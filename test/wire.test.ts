import { PGlite } from "@electric-sql/pglite";
import { kit } from "@oxidevm/sdk/wasm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { int32, join } from "../src/bytes.ts";
import { EMBEDDED_TRANSACTION_MESSAGE, SESSION_BUSY_MESSAGE, createSharedBackend, withStatementSession } from "../src/session.ts";
import type { SharedBackend } from "../src/session.ts";
import { BACKEND_WAIT_MESSAGE, wireSession } from "../src/wire.ts";
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
interface Shared { readonly gate: ReturnType<typeof kit.gate>; readonly backend: SharedBackend }
interface Extra { readonly shared?: Shared; readonly idle?: AbortSignal; readonly closed?: boolean; readonly chunk?: number; readonly database?: PGlite }

/** The turns on one database, for the sessions of one test; the gate is at hand so that a test can see that it is free. */
function share(database: PGlite = db): Shared {
  const gate = kit.gate();
  return { gate, backend: createSharedBackend({ gate, db: database }) };
}

/** Starts a native session whose client sends `input` and then, unless it ends the stream, goes quiet. */
function begin(input: readonly Uint8Array[], extra: Extra = {}): Run {
  const connection = fakeConnection(join(...input), { ...(extra.chunk === undefined ? {} : { chunk: extra.chunk }), ...(extra.closed === undefined ? {} : { closed: extra.closed }) });
  const sink = memorySink();
  const never = new AbortController().signal;
  const done = wireSession(connection, {
    db: extra.database ?? db, version: "18.6", backend: (extra.shared ?? share(extra.database)).backend, sink, readExactly: kit.framing.readExactly, idle: () => extra.idle ?? never,
  });
  return { sink, connection, done };
}

const types = (run: Run): string => run.sink.messages().map(item => item.type).join("");
const rows = (run: Run): (string | null)[][] => run.sink.messages().filter(item => item.type === "D").map(item => dataRow(item.body));
const errors = (run: Run): Record<string, string>[] => run.sink.messages().filter(item => item.type === "E").map(item => errorFields(item.body));
async function free(gate: ReturnType<typeof kit.gate>): Promise<void> { (await gate.acquire(new AbortController().signal))(); }
/** The messages of the flush with this index (0 is the greeting). */
const flushRows = (run: Run, index: number): (string | null)[][] => backendMessages(run.sink.sent[index] ?? new Uint8Array(0)).filter(item => item.type === "D").map(item => dataRow(item.body));
const flushErrors = (run: Run, index: number): Record<string, string>[] => backendMessages(run.sink.sent[index] ?? new Uint8Array(0)).filter(item => item.type === "E").map(item => errorFields(item.body));
/** Sends more from the client and waits until the session has answered with its flush number `count`. */
async function say(run: Run, bytes: Uint8Array, count: number): Promise<void> {
  run.connection.feed(bytes);
  await run.sink.flushed(count);
}
/** Runs one statement as the JSON endpoint does: in the embedded client's turn. */
async function embedded<T>(shared: Shared, sql: string): Promise<T[]> {
  return withStatementSession(shared.backend.embedded, new AbortController().signal, async () => (await db.query<T>(sql)).rows);
}
const parse = (name: string, sql: string): Uint8Array => message("P", join(cstring(name), cstring(sql), int16(0)));
const bind = (statement: string, parameters: readonly string[] = []): Uint8Array => message("B", join(
  cstring(""), cstring(statement), int16(0), int16(parameters.length), ...parameters.flatMap(value => [int32(value.length), new TextEncoder().encode(value)]), int16(0),
));
const describeStatement = (name: string): Uint8Array => message("D", join(Uint8Array.of(0x53), cstring(name)));
const closeStatement = (name: string): Uint8Array => message("C", join(Uint8Array.of(0x53), cstring(name)));
const run_ = (): Uint8Array => message("E", join(cstring(""), int32(0)));
const sync = (): Uint8Array => message("S");
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
    const shared = share();
    const run = begin([cancelRequest()], { shared });
    await run.done;
    expect(run.sink.sent).toEqual([]);
    await free(shared.gate);
  });

  it("refuses every other user, database and protocol, before taking the database", async () => {
    const shared = share();
    const refused: [Uint8Array, string][] = [
      [startup({ user: "alice", database: "postgres" }), "Connect as postgres to database postgres"],
      [startup({ user: "postgres", database: "other" }), "Connect as postgres to database postgres"],
      [startup({ database: "postgres" }), "Connect as postgres to database postgres"],
      [startup({ user: "postgres" }, 131_072), "Only PostgreSQL protocol 3.0 is supported"],
      [join(int32(5), Uint8Array.of(0)), "Only PostgreSQL protocol 3.0 is supported"],
    ];
    for (const [bytes, message_] of refused) {
      const run = begin([bytes], { shared });
      await expect(run.done, message_).rejects.toThrow(message_);
      expect(run.sink.sent).toEqual([]);
    }
    await free(shared.gate);
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

describe("the one backend, shared by turns", () => {
  it("serves two connections that are open at once and send simple queries in turn", async () => {
    const shared = share();
    const first = begin([startup()], { shared }), second = begin([startup()], { shared });
    await Promise.all([first.sink.flushed(1), second.sink.flushed(1)]);
    await say(first, query("SELECT 'a1'"), 2);
    await say(second, query("SELECT 'b1'"), 2);
    await say(first, query("SELECT 'a2'"), 3);
    await say(second, query("SELECT 'b2'"), 3);
    expect([flushRows(first, 1), flushRows(first, 2), flushRows(second, 1), flushRows(second, 2)]).toEqual([[["a1"]], [["a2"]], [["b1"]], [["b2"]]]);
    // Neither holds the backend while it waits for its client.
    await free(shared.gate);
    first.connection.feed(terminate());
    second.connection.feed(terminate());
    await Promise.all([first.done, second.done]);
  });

  it("greets a connection while another one is in the middle of a transaction", async () => {
    const shared = share();
    const first = begin([startup(), query("BEGIN")], { shared });
    await first.sink.flushed(2);
    const second = begin([startup()], { shared });
    await second.sink.flushed(1);
    expect(types(second)).toBe("RSSSSSSZ");
    first.connection.feed(terminate());
    second.connection.feed(terminate());
    await Promise.all([first.done, second.done]);
  });

  it("stays with a connection from BEGIN to COMMIT: another connection and an embedded statement wait", async () => {
    await db.exec("DROP TABLE IF EXISTS turn_wire; CREATE TABLE turn_wire(n int)");
    const shared = share();
    const first = begin([startup(), query("BEGIN"), query("INSERT INTO turn_wire VALUES (1)")], { shared });
    await first.sink.flushed(3);
    const second = begin([startup(), query("SELECT count(*) FROM turn_wire")], { shared });
    await second.sink.flushed(1);
    await tick();
    expect(second.sink.sent).toHaveLength(1);

    const wait = new AbortController();
    const statement = withStatementSession(shared.backend.embedded, new AbortController().signal, () => Promise.resolve("ran"), { now: () => 0, timeout: () => wait.signal });
    wait.abort(new DOMException("timed out", "TimeoutError"));
    await expect(statement).rejects.toThrow(SESSION_BUSY_MESSAGE);

    await say(first, query("INSERT INTO turn_wire VALUES (2)"), 4);
    await tick();
    expect(second.sink.sent).toHaveLength(1);
    await say(first, query("COMMIT"), 5);
    await second.sink.flushed(2);
    expect(flushRows(second, 1)).toEqual([["2"]]);
    await free(shared.gate);
    first.connection.feed(terminate());
    second.connection.feed(terminate());
    await Promise.all([first.done, second.done]);
    await db.exec("DROP TABLE turn_wire");
  });

  it("stays with a connection after ROLLBACK ends a failed transaction, not before", async () => {
    const shared = share();
    const first = begin([startup(), query("BEGIN"), query("SELECT * FROM missing_wire_table")], { shared });
    await first.sink.flushed(3);
    const second = begin([startup(), query("SELECT 1")], { shared });
    await second.sink.flushed(1);
    await tick();
    expect(second.sink.sent).toHaveLength(1);
    await say(first, query("ROLLBACK"), 4);
    await second.sink.flushed(2);
    expect(flushRows(second, 1)).toEqual([["1"]]);
    first.connection.feed(terminate());
    second.connection.feed(terminate());
    await Promise.all([first.done, second.done]);
  });

  it("stays with a connection through an extended-protocol exchange, until its Sync", async () => {
    const shared = share();
    const first = begin([startup(), parse("", "SELECT $1::int + 1"), bind("", ["41"])], { shared });
    await first.sink.flushed(1);
    const second = begin([startup(), query("SELECT 'between'")], { shared });
    await second.sink.flushed(1);
    await tick();
    await tick();
    expect(second.sink.sent).toHaveLength(1);
    first.connection.feed(join(run_(), sync()));
    await second.sink.flushed(2);
    expect(rows(first)).toEqual([["42"]]);
    expect(rows(second)).toEqual([["between"]]);
    first.connection.feed(terminate());
    second.connection.feed(terminate());
    await Promise.all([first.done, second.done]);
  });

  it("gives every connection the search_path of its own startup packet when two alternate", async () => {
    await db.exec("CREATE SCHEMA IF NOT EXISTS dev; DROP TABLE IF EXISTS public.where_am_i, dev.where_am_i; CREATE TABLE public.where_am_i AS SELECT 'public' AS here; CREATE TABLE dev.where_am_i AS SELECT 'dev' AS here");
    const shared = share();
    const first = begin([startup({ user: "postgres", database: "postgres", search_path: "public" })], { shared });
    const second = begin([startup({ user: "postgres", database: "postgres", search_path: "dev", application_name: "second" })], { shared });
    await Promise.all([first.sink.flushed(1), second.sink.flushed(1)]);
    for (let round = 0; round < 3; round += 1) {
      await say(first, query("SELECT here, current_setting('search_path'), current_setting('application_name') FROM where_am_i"), round + 2);
      await say(second, query("SELECT here, current_setting('search_path'), current_setting('application_name') FROM where_am_i"), round + 2);
      expect([flushRows(first, round + 1), flushRows(second, round + 1)]).toEqual([[["public", "public", ""]], [["dev", "dev", "second"]]]);
    }
    // An unqualified name is created in the connection's own schema.
    await say(second, query("CREATE TABLE made_here(n int)"), 5);
    await say(first, query("SELECT to_regclass('dev.made_here') IS NOT NULL, to_regclass('public.made_here') IS NOT NULL"), 5);
    expect(flushRows(first, 4)).toEqual([["t", "f"]]);
    first.connection.feed(terminate());
    second.connection.feed(terminate());
    await Promise.all([first.done, second.done]);
    await db.exec("DROP SCHEMA dev CASCADE; DROP TABLE public.where_am_i");
  });

  it("keeps what a connection SET while others had their turns, and RESET stays reset", async () => {
    const shared = share();
    const first = begin([startup()], { shared }), second = begin([startup()], { shared });
    await Promise.all([first.sink.flushed(1), second.sink.flushed(1)]);
    await say(first, query("SET search_path = pg_catalog; SET statement_timeout = '7s'; SET DateStyle = German"), 2);
    await say(second, query("SELECT current_setting('search_path'), current_setting('statement_timeout'), current_setting('DateStyle')"), 2);
    expect(flushRows(second, 1)).toEqual([["public", "0", "ISO, MDY"]]);
    await say(second, query("SET statement_timeout = '9s'"), 3);
    await say(first, query("SELECT current_setting('search_path'), current_setting('statement_timeout'), current_setting('DateStyle')"), 3);
    expect(flushRows(first, 2)).toEqual([["pg_catalog", "7s", "German, DMY"]]);
    await say(first, query("RESET statement_timeout"), 4);
    await say(second, query("SELECT current_setting('statement_timeout')"), 4);
    await say(first, query("SELECT current_setting('statement_timeout')"), 5);
    expect([flushRows(second, 3), flushRows(first, 4)]).toEqual([[["9s"]], [["0"]]]);
    // The JSON endpoint is a client of its own: it sees neither connection's settings.
    expect(await embedded(shared, "SELECT current_setting('search_path') AS path, current_setting('statement_timeout') AS timeout")).toEqual([{ path: "public", timeout: "0" }]);
    first.connection.feed(terminate());
    second.connection.feed(terminate());
    await Promise.all([first.done, second.done]);
  });

  it("applies the settings of the options startup parameter", async () => {
    const run = begin([startup({ user: "postgres", options: "-c search_path=pg_catalog --statement-timeout=3s  -capplication_name=two\\ words" }), query("SELECT current_setting('search_path'), current_setting('statement_timeout'), current_setting('application_name')"), terminate()]);
    await run.done;
    expect(rows(run)).toEqual([["pg_catalog", "3s", "two words"]]);
    const refused = begin([startup({ user: "postgres", options: "-d 5" })]);
    await expect(refused.done).rejects.toThrow("Only -c name=value and --name=value are supported in the options startup parameter");
  });

  it("ignores the startup parameters that are not session settings", async () => {
    const run = begin([startup({ user: "postgres", database: "postgres", client_encoding: "LATIN1", "_pq_.future": "1" }), query("SHOW client_encoding"), terminate()]);
    await run.done;
    expect(rows(run)).toEqual([["UTF8"]]);
  });

  it("ends a connection whose startup setting PostgreSQL refuses, with a fatal error, at its first statement", async () => {
    const shared = share();
    const run = begin([startup({ user: "postgres", no_such_setting: "1" }), query("SELECT 1")], { shared });
    await expect(run.done).rejects.toThrow(/unrecognized configuration parameter "no_such_setting"/u);
    expect(flushErrors(run, 1)).toMatchObject([{ S: "FATAL", C: "55000" }]);
    await free(shared.gate);
    expect(await embedded(shared, "SELECT 1 AS one")).toEqual([{ one: 1 }]);
  });

  it("gives every connection its own prepared statements, named or not", async () => {
    const shared = share();
    const first = begin([startup()], { shared }), second = begin([startup()], { shared });
    await Promise.all([first.sink.flushed(1), second.sink.flushed(1)]);
    /** Sends the messages (each is answered by a flush of its own) and resolves with what came back for them. */
    const exchange = async (run: Run, ...messages: Uint8Array[]): Promise<{ types: string; rows: (string | null)[][]; errors: Record<string, string>[] }> => {
      const before = run.sink.sent.length;
      await say(run, join(...messages), before + messages.length);
      const answer = backendMessages(join(...run.sink.sent.slice(before)));
      return {
        types: answer.map(item => item.type).join(""),
        rows: answer.filter(item => item.type === "D").map(item => dataRow(item.body)),
        errors: answer.filter(item => item.type === "E").map(item => errorFields(item.body)),
      };
    };
    // The same name, and the unnamed statement, prepared by both for different SQL, each in a round trip of its own.
    expect((await exchange(first, parse("S_1", "SELECT 'first named'"), parse("", "SELECT 'first unnamed'"), describeStatement(""), sync())).types).toBe("11tTZ");
    expect((await exchange(second, parse("S_1", "SELECT 'second named'"), parse("", "SELECT 'second unnamed'"), sync())).types).toBe("11Z");
    expect((await exchange(first, bind("S_1"), run_(), bind(""), run_(), sync())).rows).toEqual([["first named"], ["first unnamed"]]);
    expect((await exchange(second, bind("S_1"), run_(), bind(""), run_(), sync())).rows).toEqual([["second named"], ["second unnamed"]]);
    // The unnamed statement is replaced by the next one; a named one is refused until it is closed.
    const replaced = await exchange(first, parse("", "SELECT 'replaced'"), bind(""), run_(), parse("S_1", "SELECT 2"), sync());
    expect(replaced.rows).toEqual([["replaced"]]);
    expect(replaced.errors).toMatchObject([{ C: "42P05" }]);
    expect((await exchange(first, closeStatement("S_1"), parse("S_1", "SELECT 'again'"), bind("S_1"), run_(), sync())).rows).toEqual([["again"]]);
    // When a connection goes, its statements go with it; the other's stay.
    first.connection.feed(terminate());
    await first.done;
    expect((await exchange(second, bind("S_1"), run_(), sync(), query("SELECT count(*) FROM pg_prepared_statements"))).rows).toEqual([["second named"], ["2"]]);
    second.connection.feed(terminate());
    await second.done;
  });

  it("rolls back and frees the backend when a client leaves in the middle of a transaction", async () => {
    await db.exec("DROP TABLE IF EXISTS left_wire; CREATE TABLE left_wire(n int)");
    const shared = share();
    const first = begin([startup(), query("BEGIN"), query("INSERT INTO left_wire VALUES (1)"), query("SET application_name = 'native'")], { shared });
    await first.sink.flushed(4);
    const second = begin([startup(), query("SELECT count(*), current_setting('application_name') FROM left_wire")], { shared });
    await second.sink.flushed(1);
    await tick();
    expect(second.sink.sent).toHaveLength(1);
    first.connection.end.abort(new Error("The client is gone"));
    await expect(first.done).rejects.toThrow("The client is gone");
    await second.sink.flushed(2);
    expect(flushRows(second, 1)).toEqual([["0", ""]]);
    second.connection.feed(terminate());
    await second.done;
    await db.exec("DROP TABLE left_wire");
  });

  it("rolls back when the client's stream ends in the middle of a transaction", async () => {
    const run = begin([startup(), query("BEGIN"), query("CREATE TABLE leaked_wire(n int)"), query("SET application_name = 'native'")], { closed: true });
    await expect(run.done).rejects.toThrow(/closed/u);
    expect(db.isInTransaction()).toBe(false);
    expect((await db.query<{ present: boolean }>("SELECT to_regclass('leaked_wire') IS NOT NULL AS present")).rows).toEqual([{ present: false }]);
    expect((await db.query<{ application_name: string }>("SHOW application_name")).rows).toEqual([{ application_name: "" }]);
  });

  it("ends an extended-protocol exchange the client left unfinished", async () => {
    const shared = share();
    const run = begin([startup(), parse("", "SELECT 1"), bind("")], { shared, closed: true });
    await expect(run.done).rejects.toThrow(/closed/u);
    await free(shared.gate);
    const next = begin([startup(), query("SELECT 2"), terminate()], { shared });
    await next.done;
    expect(rows(next)).toEqual([["2"]]);
  });

  it("is not given to a native connection while an embedded transaction is open, and that transaction survives", async () => {
    await db.exec("BEGIN");
    const run = begin([startup(), query("SELECT 1"), terminate()]);
    await expect(run.done).rejects.toThrow(EMBEDDED_TRANSACTION_MESSAGE);
    expect(EMBEDDED_TRANSACTION_MESSAGE).toBe("An embedded transaction is active. Commit or roll it back before opening a native session.");
    expect(types(run)).toBe("RSSSSSSZE");
    expect(flushErrors(run, 1)).toMatchObject([{ S: "FATAL", C: "55000", M: EMBEDDED_TRANSACTION_MESSAGE }]);
    expect(db.isInTransaction()).toBe(true);
    await db.exec("ROLLBACK");
  });

  it("tells a connection that waited too long for the backend why it is closed", async () => {
    const shared = share(), idle = new AbortController();
    const first = begin([startup(), query("BEGIN")], { shared });
    await first.sink.flushed(2);
    const second = begin([startup(), query("SELECT 1")], { shared, idle: idle.signal });
    await second.sink.flushed(1);
    await tick();
    idle.abort(new DOMException("idle", "TimeoutError"));
    await expect(second.done).rejects.toThrow(BACKEND_WAIT_MESSAGE);
    expect(flushErrors(second, 1)).toMatchObject([{ S: "FATAL", C: "55P03", M: BACKEND_WAIT_MESSAGE }]);
    // The connection that has the backend is untouched.
    await say(first, query("SELECT 'still mine'"), 3);
    expect(flushRows(first, 2)).toEqual([["still mine"]]);
    first.connection.feed(terminate());
    await first.done;
  });

  it("is restored once the last native connection has gone: prepared statements, temporary tables and settings", async () => {
    const shared = share();
    const first = begin([startup(), query("PREPARE leftover AS SELECT 1"), query("CREATE TEMP TABLE scratch(n int)"), query("SET search_path = pg_catalog")], { shared });
    await first.sink.flushed(4);
    const second = begin([startup(), query("SELECT count(*) FROM scratch")], { shared });
    await second.sink.flushed(2);
    // One PostgreSQL session: the other connection sees the temporary table.
    expect(flushRows(second, 1)).toEqual([["0"]]);
    first.connection.feed(terminate());
    await first.done;
    await say(second, query("SELECT count(*) FROM pg_prepared_statements"), 3);
    expect(flushRows(second, 2)).toEqual([["1"]]);
    second.connection.feed(terminate());
    await second.done;
    expect(await embedded(shared, "SELECT (SELECT count(*)::int FROM pg_prepared_statements) AS prepared, to_regclass('pg_temp.scratch') IS NULL AS dropped, current_setting('search_path') AS path"))
      .toEqual([{ prepared: 0, dropped: true, path: "public" }]);
  });

  it("keeps the JSON client's settings when the last native connection goes", async () => {
    const shared = share();
    await embedded(shared, "SET application_name = 'embedded'");
    const run = begin([startup(), query("SELECT current_setting('application_name')"), terminate()], { shared });
    await run.done;
    expect(rows(run)).toEqual([[""]]);
    expect(await embedded(shared, "SELECT current_setting('application_name') AS name")).toEqual([{ name: "embedded" }]);
    await embedded(shared, "RESET application_name");
  });

  it("is released when the session fails, when the client is idle too long and when the module stops", async () => {
    const shared = share();
    await expect(begin([startup(), message("Z")], { shared }).done).rejects.toThrow("Unsupported PostgreSQL frontend message");
    await free(shared.gate);

    const idle = new AbortController();
    const quiet = begin([startup(), query("BEGIN")], { shared, idle: idle.signal });
    await quiet.sink.flushed(2);
    idle.abort(new DOMException("idle", "TimeoutError"));
    await expect(quiet.done).rejects.toThrow("idle");
    await free(shared.gate);
    expect(db.isInTransaction()).toBe(false);

    const stopping = begin([startup(), query("BEGIN")], { shared });
    await stopping.sink.flushed(2);
    stopping.connection.end.abort(new Error("The module is stopping"));
    await expect(stopping.done).rejects.toThrow("The module is stopping");
    await free(shared.gate);
    expect(db.isInTransaction()).toBe(false);
  });
});

describe("messages in the test support", () => {
  it("round-trips", () => {
    const [first] = backendMessages(message("Z", Uint8Array.of(0x49)));
    expect(first).toEqual({ type: "Z", body: Uint8Array.of(0x49) });
  });
});
