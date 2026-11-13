import { PGlite } from "@electric-sql/pglite";
import { kit } from "@oxidevm/sdk/wasm";
import { describe, expect, it } from "vitest";
import { isRecord } from "../src/decode.ts";
import { jsonEndpoint } from "../src/json-endpoint.ts";
import type { JsonEndpointDeps, SqlDatabase } from "../src/json-endpoint.ts";
import { SESSION_BUSY_MESSAGE } from "../src/session.ts";
import { fakeConnection, frame, replyOf } from "./support/connection.ts";
import type { FakeConnection } from "./support/connection.ts";

interface Call { readonly sql: string; readonly params: unknown[] }

function stub(result: Record<string, unknown> = { rows: [], fields: [], affectedRows: 0 }): { database: SqlDatabase; readonly calls: Call[] } {
  const calls: Call[] = [];
  return { calls, database: { query: (sql, params) => { calls.push({ sql, params }); return Promise.resolve(result); } } };
}

/** A deadline and a session wait that the test ends by hand, so that nothing here depends on the clock. */
function controls(): { deps: Pick<JsonEndpointDeps, "deadline" | "session">; readonly deadline: AbortController; readonly wait: AbortController } {
  const deadline = new AbortController(), wait = new AbortController();
  return { deadline, wait, deps: { deadline: () => deadline.signal, session: { now: () => 0, timeout: () => wait.signal } } };
}

function endpoint(database: SqlDatabase, extra: Partial<JsonEndpointDeps> = {}): (connection: FakeConnection) => Promise<void> {
  const control = controls();
  const handler = jsonEndpoint({ database, gate: kit.gate(), pid: 1234, framing: kit.framing, ...control.deps, ...extra });
  return handler;
}

const request = (sql: unknown, params: unknown = []): Uint8Array => frame(JSON.stringify({ sql, params }));

describe("oxidevm-sql/1 replies", () => {
  it("answers one request with the result, the service pid and the backend name, in one frame", async () => {
    const { database, calls } = stub({ rows: [{ n: 42 }], fields: [{ name: "n", dataTypeID: 23 }], affectedRows: 0 });
    const connection = fakeConnection(request("SELECT $1::int AS n", [42]));
    await endpoint(database)(connection);
    expect(replyOf(connection)).toEqual({ ok: true, result: { rows: [{ n: 42 }], fields: [{ name: "n", dataTypeID: 23 }], affectedRows: 0, pid: 1234, backend: "pglite-wasm" } });
    expect(calls).toEqual([{ sql: "SELECT $1::int AS n", params: [42] }]);
  });

  it("has the same shape for the real PGlite", async () => {
    const db = await PGlite.create();
    try {
      const database: SqlDatabase = { query: (sql, params) => db.query<Record<string, unknown>>(sql, params) };
      const connection = fakeConnection(request("SELECT $1::int AS n, 'x'::text AS label", [42]));
      await endpoint(database)(connection);
      expect(replyOf(connection)).toEqual({
        ok: true,
        result: {
          rows: [{ n: 42, label: "x" }], fields: [{ name: "n", dataTypeID: 23 }, { name: "label", dataTypeID: 25 }], affectedRows: 0,
          command: "SELECT", rowCount: 1, pid: 1234, backend: "pglite-wasm",
        },
      });
      const create = fakeConnection(request("CREATE TABLE shape(n integer)"));
      await endpoint(database)(create);
      expect(replyOf(create)).toMatchObject({ ok: true, result: { rows: [], command: "CREATE", pid: 1234, backend: "pglite-wasm" } });
    } finally {
      await db.close();
    }
  });

  it("writes 64-bit integers as text because JSON cannot hold them", async () => {
    const { database } = stub({ rows: [{ big: 9_223_372_036_854_775_807n }], fields: [], affectedRows: 0 });
    const connection = fakeConnection(request("SELECT 1"));
    await endpoint(database)(connection);
    expect(replyOf(connection)).toMatchObject({ ok: true, result: { rows: [{ big: "9223372036854775807" }] } });
  });

  it("reads a request that arrives a byte at a time", async () => {
    const { database, calls } = stub();
    const connection = fakeConnection(request("SELECT 1"), { chunk: 1 });
    await endpoint(database)(connection);
    expect(calls).toHaveLength(1);
    expect(replyOf(connection)).toMatchObject({ ok: true });
  });
});

describe("oxidevm-sql/1 requests", () => {
  it("accepts a request of exactly 64 KiB and refuses a larger one without reading it", async () => {
    const padding = "x".repeat(65536 - JSON.stringify({ sql: "", params: [] }).length - 0);
    const exact = frame(JSON.stringify({ sql: padding, params: [] }));
    expect(exact.length - 4).toBe(65536);
    const { database, calls } = stub();
    const accepted = fakeConnection(exact);
    await endpoint(database)(accepted);
    expect(calls).toHaveLength(1);
    expect(replyOf(accepted)).toMatchObject({ ok: true });

    const oversized = fakeConnection(frame(JSON.stringify({ sql: `${padding}x`, params: [] })));
    await endpoint(database)(oversized);
    expect(replyOf(oversized)).toEqual({ ok: false, error: "Database request exceeds 64 KiB" });
    expect(calls).toHaveLength(1);
    expect(oversized.reads).toEqual([4]);
  });

  it("refuses requests that are not exactly { sql: string, params: array of at most 1024 }", async () => {
    const { database, calls } = stub();
    const bodies: unknown[] = [
      null, [], "SELECT 1", 7, {}, { sql: "SELECT 1" }, { params: [] }, { sql: 1, params: [] }, { sql: "SELECT 1", params: {} },
      { sql: "SELECT 1", params: "x" }, { sql: "SELECT 1", params: new Array<number>(1025).fill(0) }, { sql: "SELECT 1", params: [], extra: true },
    ];
    for (const body of bodies) {
      const connection = fakeConnection(frame(JSON.stringify(body)));
      await endpoint(database)(connection);
      expect(replyOf(connection), JSON.stringify(body)).toEqual({ ok: false, error: "Invalid database request" });
    }
    const limit = fakeConnection(request("SELECT 1", new Array<number>(1024).fill(0)));
    await endpoint(database)(limit);
    expect(replyOf(limit)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });

  it("explains a request that is not JSON", async () => {
    const { database, calls } = stub();
    const connection = fakeConnection(frame("{not json"));
    await endpoint(database)(connection);
    const reply = replyOf(connection);
    expect(reply).toMatchObject({ ok: false });
    expect(JSON.stringify(reply)).toMatch(/JSON/u);
    expect(calls).toEqual([]);
  });

  it("refuses COPY, which has no data channel here, without touching the database", async () => {
    const { database, calls } = stub();
    for (const sql of ["COPY t FROM STDIN", "SELECT 1; copy t to stdout"]) {
      const connection = fakeConnection(request(sql));
      await endpoint(database)(connection);
      expect(replyOf(connection)).toEqual({ ok: false, error: "COPY is unavailable through this experimental SQL bridge" });
    }
    const quoted = fakeConnection(request("SELECT 'COPY'"));
    await endpoint(database)(quoted);
    expect(replyOf(quoted)).toMatchObject({ ok: true });
    expect(calls.map(call => call.sql)).toEqual(["SELECT 'COPY'"]);
  });
});

describe("oxidevm-sql/1 failures", () => {
  it("reports a failing statement with the database's message, at most 4096 characters", async () => {
    const failing: SqlDatabase = { query: () => Promise.reject(new Error(`relation "t" does not exist ${"!".repeat(5000)}`)) };
    const connection = fakeConnection(request("SELECT * FROM t"));
    await endpoint(failing)(connection);
    const reply = replyOf(connection);
    expect(reply).toMatchObject({ ok: false });
    const error = isRecord(reply) ? reply["error"] : undefined;
    expect(typeof error === "string" && error.startsWith('relation "t" does not exist')).toBe(true);
    expect(typeof error === "string" ? error.length : -1).toBe(4096);
  });

  it("replaces a result over 1 MiB with an explanation", async () => {
    const { database } = stub({ rows: [{ blob: "x".repeat(1024 * 1024) }], fields: [], affectedRows: 0 });
    const connection = fakeConnection(request("SELECT repeat('x', 1048576)"));
    await endpoint(database)(connection);
    expect(replyOf(connection)).toEqual({ ok: false, error: "Database response exceeds 1 MiB. Use LIMIT or select fewer columns." });
  });

  it("keeps a result just under 1 MiB", async () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ ok: true, result: { rows: [{ v: "" }], pid: 1234, backend: "pglite-wasm" } })).length;
    const { database } = stub({ rows: [{ v: "x".repeat(1024 * 1024 - overhead) }] });
    const connection = fakeConnection(request("SELECT 1"));
    await endpoint(database)(connection);
    expect(connection.written[0]?.length).toBe(4 + 1024 * 1024);
    expect(replyOf(connection)).toMatchObject({ ok: true });
  });

  it("says a native connection is using the database when the database stays busy", async () => {
    const gate = kit.gate();
    const holder = await gate.acquire(new AbortController().signal);
    const control = controls();
    const { database, calls } = stub();
    const connection = fakeConnection(request("SELECT 1"));
    const done = jsonEndpoint({ database, gate, pid: 1, framing: kit.framing, ...control.deps })(connection);
    await new Promise(resolve => { setTimeout(resolve, 0); });
    control.wait.abort(new DOMException("timed out", "TimeoutError"));
    await done;
    expect(replyOf(connection)).toEqual({ ok: false, error: SESSION_BUSY_MESSAGE });
    expect(calls).toEqual([]);
    holder();
  });

  it("writes nothing when the client went away before sending a whole request", async () => {
    const { database, calls } = stub();
    for (const bytes of [new Uint8Array(0), Uint8Array.of(0, 0), frame("{}").subarray(0, 5)]) {
      const connection = fakeConnection(bytes, { closed: true });
      await endpoint(database)(connection);
      expect(connection.written).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  it("gives up without a reply when the 30 seconds are over while waiting for the client", async () => {
    const control = controls();
    const connection = fakeConnection();
    const done = jsonEndpoint({ ...stub(), gate: kit.gate(), pid: 1, framing: kit.framing, ...control.deps })(connection);
    control.deadline.abort(new DOMException("timed out", "TimeoutError"));
    await expect(done).rejects.toThrow("timed out");
    expect(connection.written).toEqual([]);
  });

  it("does not answer a statement that finished after the 30 seconds were over", async () => {
    const control = controls();
    const slow: SqlDatabase = { query: () => { control.deadline.abort(new DOMException("timed out", "TimeoutError")); return Promise.resolve({ rows: [] }); } };
    const connection = fakeConnection(request("SELECT pg_sleep(60)"));
    await expect(jsonEndpoint({ database: slow, gate: kit.gate(), pid: 1, framing: kit.framing, ...control.deps })(connection)).rejects.toThrow("timed out");
    expect(connection.written).toEqual([]);
  });

  it("stops when the module stops", async () => {
    const connection = fakeConnection();
    const done = endpoint(stub().database)(connection);
    connection.end.abort(new Error("The module is stopping"));
    await expect(done).rejects.toThrow("The module is stopping");
  });

  it("releases the database after answering, so the next request is served", async () => {
    const gate = kit.gate(), control = controls(), { database } = stub();
    for (let index = 0; index < 3; index += 1) {
      const connection = fakeConnection(request("SELECT 1"));
      await jsonEndpoint({ database, gate, pid: 1, framing: kit.framing, ...control.deps })(connection);
      expect(replyOf(connection)).toMatchObject({ ok: true });
    }
  });
});
