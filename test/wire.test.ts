import { PGlite } from "@electric-sql/pglite";
import { kit } from "@oxidevm/sdk/wasm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { int32, join } from "../src/bytes.ts";
import { SESSION_BUSY_MESSAGE, withStatementSession } from "../src/session.ts";
import { wireSession } from "../src/wire.ts";
import { fakeConnection } from "./support/connection.ts";
import type { FakeConnection } from "./support/connection.ts";
import { backendMessages, cancelRequest, commandTag, cstring, dataRow, errorFields, int16, memorySink, message, query, sslRequest, startup, terminate } from "./support/wire.ts";
import type { MemorySink } from "./support/wire.ts";

let db: PGlite;
beforeAll(async () => { db = await PGlite.create(); });
afterAll(async () => { await db.close(); });
afterEach(async () => {
  await db.exec("ROLLBACK; DISCARD ALL").catch(() => undefined);
});

interface Run { readonly sink: MemorySink; readonly connection: FakeConnection; readonly done: Promise<void> }
interface Extra { readonly gate?: ReturnType<typeof kit.gate>; readonly idle?: AbortSignal; readonly closed?: boolean; readonly chunk?: number; readonly database?: PGlite }

/** Starts a native session whose client sends `input` and then, unless it ends the stream, goes quiet. */
function begin(input: readonly Uint8Array[], extra: Extra = {}): Run {
  const connection = fakeConnection(join(...input), { ...(extra.chunk === undefined ? {} : { chunk: extra.chunk }), ...(extra.closed === undefined ? {} : { closed: extra.closed }) });
  const sink = memorySink();
  const never = new AbortController().signal;
  const done = wireSession(connection, {
    db: extra.database ?? db, version: "18.6", gate: extra.gate ?? kit.gate(), sink, readExactly: kit.framing.readExactly, idle: () => extra.idle ?? never,
  });
  return { sink, connection, done };
}

const types = (run: Run): string => run.sink.messages().map(item => item.type).join("");
const rows = (run: Run): (string | null)[][] => run.sink.messages().filter(item => item.type === "D").map(item => dataRow(item.body));
const errors = (run: Run): Record<string, string>[] => run.sink.messages().filter(item => item.type === "E").map(item => errorFields(item.body));
async function free(gate: ReturnType<typeof kit.gate>): Promise<void> { (await gate.acquire(new AbortController().signal))(); }
const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0); });

describe("startup", () => {
  it("answers a simple query after announcing the server and returning to idle", async () => {
    const run = begin([startup(), query("SELECT 42 AS answer"), terminate()]);
    await run.done;
    expect(types(run)).toBe("RSSSSSSZTDCZ");
    const messages = run.sink.messages();
    expect(messages[0]?.body).toEqual(int32(0));
    const status = new Map(messages.filter(item => item.type === "S").map(item => item.body).map((body): [string, string] => {
      const [key = "", value = ""] = new TextDecoder().decode(body).split("\0");
      return [key, value];
    }));
    expect(Object.fromEntries(status)).toEqual({
      server_version: "18.6", server_encoding: "UTF8", client_encoding: "UTF8", DateStyle: "ISO, MDY", integer_datetimes: "on", standard_conforming_strings: "on",
    });
    expect(new TextDecoder().decode(messages[7]?.body)).toBe("I");
    expect(rows(run)).toEqual([["42"]]);
    expect(commandTag(messages[10]?.body ?? new Uint8Array(0))).toBe("SELECT 1");
    expect(new TextDecoder().decode(messages[11]?.body)).toBe("I");
  });

  it("declines encryption requests with N and then accepts the real startup", async () => {
    const gssenc = join(int32(8), int32(80_877_104));
    const run = begin([sslRequest(), gssenc, startup(), terminate()]);
    await run.done;
    expect(run.sink.sent.slice(0, 2).map(bytes => [...bytes])).toEqual([[78], [78]]);
    expect(backendMessages(join(...run.sink.sent.slice(2))).map(item => item.type).join("")).toBe("RSSSSSSZ");
  });

  it("accepts a startup without a database name", async () => {
    const run = begin([startup({ user: "postgres" }), terminate()]);
    await run.done;
    expect(types(run)).toBe("RSSSSSSZ");
  });

  it("ends quietly on a cancel request, which has no backend to signal, and never takes the database", async () => {
    const gate = kit.gate();
    const run = begin([cancelRequest()], { gate });
    await run.done;
    expect(run.sink.sent).toEqual([]);
    await free(gate);
  });

  it("refuses every other user, database and protocol, before taking the database", async () => {
    const gate = kit.gate();
    const refused: [Uint8Array, string][] = [
      [startup({ user: "alice", database: "postgres" }), "Connect as postgres to database postgres"],
      [startup({ user: "postgres", database: "other" }), "Connect as postgres to database postgres"],
      [startup({ database: "postgres" }), "Connect as postgres to database postgres"],
      [startup({ user: "postgres" }, 131_072), "Only PostgreSQL protocol 3.0 is supported"],
      [join(int32(5), Uint8Array.of(0)), "Only PostgreSQL protocol 3.0 is supported"],
    ];
    for (const [bytes, message_] of refused) {
      const run = begin([bytes], { gate });
      await expect(run.done, message_).rejects.toThrow(message_);
      expect(run.sink.sent).toEqual([]);
    }
    await free(gate);
  });

  it("refuses a startup packet that is too long to read", async () => {
    const run = begin([int32(17 * 1024 ** 2 + 4)]);
    await expect(run.done).rejects.toThrow("Database message exceeds its size limit");
  });
});

describe("queries", () => {
  it("runs the extended protocol: parse, bind, describe, execute, sync", async () => {
    const parse = message("P", join(cstring(""), cstring("SELECT $1::int + 1 AS next"), int16(0)));
    const bind = message("B", join(cstring(""), cstring(""), int16(0), int16(1), int32(2), new TextEncoder().encode("41"), int16(0)));
    const describe_ = message("D", join(Uint8Array.of(0x50), cstring("")));
    const execute = message("E", join(cstring(""), int32(0)));
    const sync = message("S");
    const run = begin([startup(), parse, bind, describe_, execute, sync, terminate()]);
    await run.done;
    expect(types(run)).toBe("RSSSSSSZ12TDCZ");
    expect(rows(run)).toEqual([["42"]]);
  });

  it("reports an error and carries on with the next statement", async () => {
    const run = begin([startup(), query("SELECT * FROM missing_wire_table"), query("SELECT 1"), terminate()]);
    await run.done;
    expect(types(run)).toBe("RSSSSSSZEZTDCZ");
    expect(errors(run)).toMatchObject([{ S: "ERROR", C: "42P01" }]);
    expect(rows(run)).toEqual([["1"]]);
  });

  it("returns a result of 2 MiB intact", async () => {
    const run = begin([startup(), query("SELECT repeat('x', 2097152)"), terminate()], { chunk: 4096 });
    await run.done;
    expect(rows(run)[0]?.[0]).toHaveLength(2_097_152);
    expect(types(run)).toBe("RSSSSSSZTDCZ");
  });

  it("reads messages that arrive a few bytes at a time", async () => {
    const run = begin([startup(), query("SELECT 7"), terminate()], { chunk: 3 });
    await run.done;
    expect(rows(run)).toEqual([["7"]]);
  });
});

describe("protocol violations", () => {
  it("refuses a message type a session does not accept", async () => {
    const run = begin([startup(), message("Z")]);
    await expect(run.done).rejects.toThrow("Unsupported PostgreSQL frontend message");
  });

  it("refuses a message whose length cannot hold itself", async () => {
    const run = begin([startup(), join(Uint8Array.of(0x51), int32(3))]);
    await expect(run.done).rejects.toThrow("Invalid PostgreSQL packet length");
  });

  it("refuses a Terminate that carries data", async () => {
    const run = begin([startup(), message("X", Uint8Array.of(1))]);
    await expect(run.done).rejects.toThrow("Invalid Terminate message");
  });

  it("refuses a message longer than 16 MiB without reading it", async () => {
    const run = begin([startup(), join(Uint8Array.of(0x51), int32(16 * 1024 ** 2 + 5))]);
    await expect(run.done).rejects.toThrow("Database message exceeds its size limit");
  });

  it("stops when the client stops receiving", async () => {
    const run = begin([startup(), query("SELECT 1"), terminate()]);
    run.sink.failFlush = new Error("PostgreSQL client stopped receiving data");
    await expect(run.done).rejects.toThrow("PostgreSQL client stopped receiving data");
  });
});

describe("the one backend", () => {
  it("is leased to a session for its whole life: a second session and an embedded statement wait", async () => {
    const gate = kit.gate();
    const first = begin([startup(), query("SELECT 1")], { gate });
    await first.sink.flushed(2);
    const second = begin([startup(), terminate()], { gate });
    await tick();
    expect(second.sink.sent).toEqual([]);

    const wait = new AbortController();
    const embedded = withStatementSession(gate, new AbortController().signal, () => Promise.resolve("ran"), { now: () => 0, timeout: () => wait.signal });
    wait.abort(new DOMException("timed out", "TimeoutError"));
    await expect(embedded).rejects.toThrow(SESSION_BUSY_MESSAGE);

    first.connection.feed(terminate());
    await first.done;
    await second.done;
    expect(types(second)).toBe("RSSSSSSZ");
    await free(gate);
  });

  it("is not given to a native session while an embedded transaction is open, and that transaction survives", async () => {
    await db.exec("BEGIN");
    const run = begin([startup(), query("SELECT 1"), terminate()]);
    await expect(run.done).rejects.toThrow("An embedded transaction is active. Commit or roll it back before opening a native session.");
    expect(run.sink.sent).toEqual([]);
    expect(db.isInTransaction()).toBe(true);
    await db.exec("ROLLBACK");
  });

  it("is restored when the client leaves in the middle of a transaction", async () => {
    const run = begin([startup(), query("BEGIN"), query("CREATE TABLE leaked_wire(n int)"), query("SET application_name = 'native'")], { closed: true });
    await expect(run.done).rejects.toThrow(/closed/u);
    expect(db.isInTransaction()).toBe(false);
    expect((await db.query<{ present: boolean }>("SELECT to_regclass('leaked_wire') IS NOT NULL AS present")).rows).toEqual([{ present: false }]);
    expect((await db.query<{ application_name: string }>("SHOW application_name")).rows).toEqual([{ application_name: "" }]);
  });

  it("is restored after a clean session too: prepared statements and settings are gone", async () => {
    const before = (await db.query<{ search_path: string }>("SHOW search_path")).rows;
    const run = begin([startup(), query("PREPARE leftover AS SELECT 1"), query("SET search_path = pg_catalog"), terminate()]);
    await run.done;
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_prepared_statements")).rows).toEqual([{ count: "0" }]);
    expect((await db.query<{ search_path: string }>("SHOW search_path")).rows).toEqual(before);
  });

  it("is released when the session fails, when the client is idle too long and when the module stops", async () => {
    const gate = kit.gate();
    await expect(begin([startup(), message("Z")], { gate }).done).rejects.toThrow("Unsupported PostgreSQL frontend message");
    await free(gate);

    const idle = new AbortController();
    const quiet = begin([startup()], { gate, idle: idle.signal });
    await quiet.sink.flushed(1);
    idle.abort(new DOMException("idle", "TimeoutError"));
    await expect(quiet.done).rejects.toThrow("idle");
    await free(gate);

    const stopping = begin([startup()], { gate });
    await stopping.sink.flushed(1);
    stopping.connection.end.abort(new Error("The module is stopping"));
    await expect(stopping.done).rejects.toThrow("The module is stopping");
    await free(gate);
    expect(db.isInTransaction()).toBe(false);
  });
});

describe("messages in the test support", () => {
  it("round-trips", () => {
    const [first] = backendMessages(message("Z", Uint8Array.of(0x49)));
    expect(first).toEqual({ type: "Z", body: Uint8Array.of(0x49) });
  });
});
