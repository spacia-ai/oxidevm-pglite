import { PGlite } from "@electric-sql/pglite";
import { kit } from "@oxidevm/sdk/wasm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { EMBEDDED_TRANSACTION_MESSAGE, SESSION_BUSY_MESSAGE, SESSION_WAIT_MS, SESSION_WAIT_EXPIRED_MESSAGE, createSharedBackend, withStatementSession } from "../src/session.ts";
import type { Party, SharedBackend } from "../src/session.ts";
import { query } from "./support/wire.ts";

describe("the shared gate (ported from the sample's SessionGate test)", () => {
  it("serves one session at a time in arrival order, drops cancelled waits, and ignores a second release", async () => {
    const gate = kit.gate(), signal = new AbortController().signal;
    const first = await gate.acquire(signal), cancel = new AbortController();
    const cancelled = gate.acquire(cancel.signal);
    cancel.abort(Error("Disconnected before SQL execution"));
    await expect(cancelled).rejects.toThrow(/Disconnected/u);
    const next = gate.acquire(signal), order: string[] = [];
    const later = gate.acquire(signal).then(release => { order.push("later"); release(); });
    first();
    const release = await next;
    order.push("next");
    release();
    release();
    await later;
    expect(order).toEqual(["next", "later"]);
    const final = await gate.acquire(signal);
    final();
  });
});

/** A clock the test moves by hand, with wait signals it aborts by hand. */
function clock(start = 1000): { now: () => number; advance(ms: number): void; timeout(ms: number): AbortSignal; readonly waits: number[]; expire(): void } {
  let current = start;
  const waits: number[] = [], controllers: AbortController[] = [];
  return {
    now: () => current,
    advance: ms => { current += ms; },
    timeout: ms => { waits.push(ms); const controller = new AbortController(); controllers.push(controller); return controller.signal; },
    waits,
    expire: () => { for (const controller of controllers) controller.abort(new DOMException("timed out", "TimeoutError")); },
  };
}

describe("withStatementSession", () => {
  it("runs at once when nobody holds the database, waiting at most 250 ms, and releases afterwards", async () => {
    const gate = kit.gate(), time = clock();
    expect(SESSION_WAIT_MS).toBe(250);
    expect(await withStatementSession(gate, new AbortController().signal, () => Promise.resolve("done"), time)).toBe("done");
    expect(time.waits).toEqual([250]);
    const again = await gate.acquire(new AbortController().signal);
    again();
  });

  it("reports that a native connection owns the database when the wait runs out, without running", async () => {
    const gate = kit.gate(), time = clock();
    const holder = await gate.acquire(new AbortController().signal);
    let ran = false;
    const waiting = withStatementSession(gate, new AbortController().signal, () => { ran = true; return Promise.resolve(); }, time);
    time.expire();
    await expect(waiting).rejects.toThrow(SESSION_BUSY_MESSAGE);
    expect(SESSION_BUSY_MESSAGE).toBe("A native PostgreSQL connection is using the database (a running statement or an open transaction). Try again when it is done.");
    expect(ran).toBe(false);
    holder();
    const free = await gate.acquire(new AbortController().signal);
    free();
  });

  it("runs once the holder lets go within the wait", async () => {
    const gate = kit.gate(), time = clock();
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, new AbortController().signal, () => Promise.resolve(42), time);
    holder();
    expect(await waiting).toBe(42);
  });

  it("serves waiting statements in arrival order", async () => {
    const gate = kit.gate(), time = clock(), order: number[] = [];
    const holder = await gate.acquire(new AbortController().signal);
    const runs = [1, 2, 3].map(index => withStatementSession(gate, new AbortController().signal, () => { order.push(index); return Promise.resolve(); }, time));
    holder();
    await Promise.all(runs);
    expect(order).toEqual([1, 2, 3]);
  });

  it("reports the same message when the request itself was cancelled while waiting", async () => {
    const gate = kit.gate(), time = clock(), request = new AbortController();
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, request.signal, () => Promise.resolve(), time);
    request.abort(new Error("shutting down"));
    await expect(waiting).rejects.toThrow(SESSION_BUSY_MESSAGE);
    holder();
  });

  it("does not run a statement whose wait ended after its deadline, and lets the next one in", async () => {
    const gate = kit.gate(), time = clock();
    let ran = false;
    const slow = (): Promise<void> => { time.advance(251); return Promise.resolve(); };
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, new AbortController().signal, () => { ran = true; return Promise.resolve(); }, time);
    await slow();
    holder();
    await expect(waiting).rejects.toThrow(SESSION_WAIT_EXPIRED_MESSAGE);
    expect(SESSION_WAIT_EXPIRED_MESSAGE).toBe("Database session wait expired before SQL execution");
    expect(ran).toBe(false);
    const free = await gate.acquire(new AbortController().signal);
    free();
  });

  it("allows a statement that waited exactly the limit", async () => {
    const gate = kit.gate(), time = clock();
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, new AbortController().signal, () => Promise.resolve("ok"), time);
    time.advance(250);
    holder();
    expect(await waiting).toBe("ok");
  });

  it("does not run a statement whose request ended before it started, and releases the database", async () => {
    const gate = kit.gate(), time = clock(), request = new AbortController();
    let ran = false;
    const holder = await gate.acquire(new AbortController().signal);
    const waiting = withStatementSession(gate, request.signal, () => { ran = true; return Promise.resolve(); }, time);
    holder();
    request.abort(new Error("deadline"));
    await expect(waiting).rejects.toThrow();
    expect(ran).toBe(false);
    const free = await gate.acquire(new AbortController().signal);
    free();
  });

  it("releases the database when the statement fails", async () => {
    const gate = kit.gate(), time = clock();
    await expect(withStatementSession(gate, new AbortController().signal, () => Promise.reject(new Error("syntax error")), time)).rejects.toThrow("syntax error");
    const free = await gate.acquire(new AbortController().signal);
    free();
  });
});

describe("the shared backend", () => {
  let db: PGlite;
  beforeAll(async () => { db = await PGlite.create(); });
  afterAll(async () => { await db.close(); });
  afterEach(async () => { await db.exec("ROLLBACK; DISCARD ALL").catch(() => undefined); });

  const forever = new AbortController().signal;
  const share = (): { gate: ReturnType<typeof kit.gate>; backend: SharedBackend } => {
    const gate = kit.gate();
    return { gate, backend: createSharedBackend({ gate, db }) };
  };
  const show = async (name: string): Promise<unknown> => (await db.query<{ value: string }>("SELECT current_setting($1) AS value", [name])).rows[0]?.value;
  /** One turn of a client: runs the statements and reads a setting while it has the backend. */
  const turn = async (backend: SharedBackend, party: Party, sql: string, setting = "search_path"): Promise<unknown> => {
    const release = await backend.acquire(party, forever);
    try {
      await db.exec(sql);
      return await show(setting);
    } finally {
      release();
    }
  };

  it("gives native connections the smallest free slot, and a slot again once its connection has left", async () => {
    const { backend } = share();
    const first = backend.join([]), second = backend.join([]), third = backend.join([]);
    expect([first.slot, second.slot, third.slot]).toEqual([0, 1, 2]);
    await backend.leave(second, undefined, []);
    expect(backend.join([]).slot).toBe(1);
    expect(backend.join([]).slot).toBe(3);
  });

  it("puts a client's settings back for each of its turns and resets them for the others", async () => {
    const { backend } = share();
    const first = backend.join([["search_path", "pg_catalog"]]), second = backend.join([]);
    expect(await turn(backend, first, "SET statement_timeout = '4s'")).toBe("pg_catalog");
    expect(await turn(backend, second, "SELECT 1")).toBe("public");
    expect(await turn(backend, second, "SELECT 1", "statement_timeout")).toBe("0");
    expect(await turn(backend, first, "SELECT 1", "statement_timeout")).toBe("4s");
    expect(await turn(backend, first, "SELECT 1")).toBe("pg_catalog");
    expect(await turn(backend, second, "SELECT 1")).toBe("public");
    expect([...first.settings].sort()).toEqual([["search_path", "pg_catalog"], ["statement_timeout", "4000"]]);
  });

  it("puts a client's role back, which pg_settings does not list", async () => {
    await db.exec("DROP ROLE IF EXISTS turn_role; CREATE ROLE turn_role");
    const { backend } = share();
    const first = backend.join([]), second = backend.join([]);
    expect(await turn(backend, first, "SET ROLE turn_role", "role")).toBe("turn_role");
    expect(await turn(backend, second, "SELECT 1", "role")).toBe("none");
    expect(await turn(backend, first, "SELECT 1", "role")).toBe("turn_role");
    await backend.leave(first, undefined, []);
    await backend.leave(second, undefined, []);
    (await backend.embedded.acquire(forever))();
    await db.exec("DROP ROLE turn_role");
  });

  it("does not touch the backend when the same client takes turn after turn", async () => {
    const { backend } = share();
    const only = backend.join([]);
    const statements: string[] = [];
    const counting = createSharedBackend({ gate: kit.gate(), db: {
      runExclusive: run => db.runExclusive(run), isInTransaction: () => db.isInTransaction(), execProtocolRawStream: (bytes, options) => db.execProtocolRawStream(bytes, options),
      query: (sql: string, parameters?: unknown[]) => { statements.push(sql); return db.query(sql, parameters); },
      exec: (sql: string) => { statements.push(sql); return db.exec(sql); },
    } });
    const client = counting.join([]);
    for (let round = 0; round < 3; round += 1) (await counting.acquire(client, forever))();
    expect(statements).toEqual([]);
    await backend.leave(only, undefined, []);
  });

  it("fails the turn, frees the gate and leaves nobody's settings behind when a setting is refused", async () => {
    const { gate, backend } = share();
    const good = backend.join([["application_name", "good"]]), bad = backend.join([["application_name", "bad"], ["no_such_setting", "1"]]);
    expect(await turn(backend, good, "SELECT 1", "application_name")).toBe("good");
    await expect(backend.acquire(bad, forever)).rejects.toThrow(/unrecognized configuration parameter "no_such_setting"/u);
    (await gate.acquire(forever))();
    expect(await turn(backend, good, "SELECT 1", "application_name")).toBe("good");
  });

  it("refuses a native connection, and frees the gate, while the JSON client has a transaction open", async () => {
    const { gate, backend } = share();
    const native = backend.join([]);
    (await backend.embedded.acquire(forever))();
    await db.exec("BEGIN");
    await expect(backend.acquire(native, forever)).rejects.toThrow(EMBEDDED_TRANSACTION_MESSAGE);
    (await gate.acquire(forever))();
    // The JSON client itself goes on, and once it has ended the transaction the connection gets its turn.
    (await backend.embedded.acquire(forever))();
    expect(db.isInTransaction()).toBe(true);
    await db.exec("COMMIT");
    (await backend.acquire(native, forever))();
  });

  it("runs what a connection leaves behind at once when it holds the backend, and frees it", async () => {
    await db.exec("DROP TABLE IF EXISTS left_session; CREATE TABLE left_session(n int)");
    const { gate, backend } = share();
    const leaving = backend.join([]), staying = backend.join([]);
    const held = await backend.acquire(leaving, forever);
    await db.exec("BEGIN; INSERT INTO left_session VALUES (1); CREATE TEMP TABLE kept_for_others(n int)");
    await backend.leave(leaving, held, [query("ROLLBACK")]);
    expect(db.isInTransaction()).toBe(false);
    (await gate.acquire(forever))();
    expect((await db.query("SELECT * FROM left_session")).rows).toEqual([]);
    await backend.leave(staying, undefined, []);
    await db.exec("DROP TABLE left_session");
  });

  it("runs what an idle connection leaves behind before the next turn, and DISCARD ALL only after the last one", async () => {
    const { backend } = share();
    const first = backend.join([]), second = backend.join([]);
    await turn(backend, first, "CREATE TEMP TABLE shared_temp(n int); PREPARE first_plan AS SELECT 1; PREPARE doomed AS SELECT 2");
    await backend.leave(first, undefined, [query("DEALLOCATE doomed")]);
    const names = async (): Promise<unknown[]> => (await db.query<{ name: string }>("SELECT name FROM pg_prepared_statements ORDER BY name")).rows.map(row => row.name);
    expect(await names()).toEqual(["doomed", "first_plan"]);
    const release = await backend.acquire(second, forever);
    expect(await names()).toEqual(["first_plan"]);
    expect((await db.query("SELECT to_regclass('pg_temp.shared_temp') IS NOT NULL AS present")).rows).toEqual([{ present: true }]);
    release();
    await backend.leave(second, undefined, []);
    (await backend.embedded.acquire(forever))();
    expect(await names()).toEqual([]);
    expect((await db.query("SELECT to_regclass('pg_temp.shared_temp') IS NOT NULL AS present")).rows).toEqual([{ present: false }]);
  });

  it("waits with DISCARD ALL while the JSON client's transaction is open", async () => {
    const { backend } = share();
    const native = backend.join([]);
    await turn(backend, native, "PREPARE waiting_plan AS SELECT 1");
    (await backend.embedded.acquire(forever))();
    await db.exec("BEGIN");
    await backend.leave(native, undefined, []);
    (await backend.embedded.acquire(forever))();
    expect((await db.query("SELECT count(*)::int AS count FROM pg_prepared_statements")).rows).toEqual([{ count: 1 }]);
    await db.exec("COMMIT");
    (await backend.embedded.acquire(forever))();
    expect((await db.query("SELECT count(*)::int AS count FROM pg_prepared_statements")).rows).toEqual([{ count: 0 }]);
  });

  it("reports the failure of a turn that is not a wait as it is, not as a busy database", async () => {
    const failing = { acquire: (): Promise<() => void> => Promise.reject(new Error("PostgreSQL reported a session setting in an unknown form")) };
    await expect(withStatementSession(failing, forever, () => Promise.resolve(), clock())).rejects.toThrow("PostgreSQL reported a session setting in an unknown form");
  });
});
