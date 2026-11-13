import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { kit } from "@oxidevm/sdk/wasm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { int32, join } from "../src/bytes.ts";
import { VMPostgresFS } from "../src/vm-fs.ts";
import { createSharedBackend } from "../src/session.ts";
import { wireSession } from "../src/wire.ts";
import { fakeConnection } from "./support/connection.ts";
import type { FakeConnection } from "./support/connection.ts";
import { createNodeFiles } from "./support/node-files.ts";
import { cstring, dataRow, errorFields, int16, memorySink, message, query, startup, terminate } from "./support/wire.ts";
import type { MemorySink } from "./support/wire.ts";

let root = "";
let db: PGlite;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-wire-copy-"));
  const { files } = createNodeFiles();
  db = await PGlite.create({ fs: new VMPostgresFS(root, { files, errno: kit.errno, directory: kit.directory }) });
});
afterAll(async () => {
  await db.close();
  fs.rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.exec("ROLLBACK; DISCARD ALL").catch(() => undefined);
  await db.exec("DROP TABLE IF EXISTS wire_data; CREATE TABLE wire_data(n integer, label text)");
});

interface Run { readonly sink: MemorySink; readonly connection: FakeConnection; readonly done: Promise<void> }

function begin(input: readonly Uint8Array[], options: { readonly closed?: boolean; readonly database?: PGlite } = {}): Run {
  const connection = fakeConnection(join(...input), options.closed === undefined ? {} : { closed: options.closed });
  const sink = memorySink();
  const never = new AbortController().signal;
  const done = wireSession(connection, { db: options.database ?? db, version: "18.6", backend: createSharedBackend({ gate: kit.gate(), db: options.database ?? db }), sink, readExactly: kit.framing.readExactly, idle: () => never });
  return { sink, connection, done };
}

const types = (run: Run): string => run.sink.messages().map(item => item.type).join("");
const copyData = (text: string): Uint8Array => message("d", new TextEncoder().encode(text));
const copyDone = (): Uint8Array => message("c");
const stored = async (): Promise<unknown[]> => (await db.query("SELECT n, label FROM wire_data ORDER BY n")).rows;

describe("COPY FROM STDIN", () => {
  it("answers the client before it waits for data, then stores what the client sends", async () => {
    const run = begin([startup(), query("COPY wire_data FROM STDIN"), copyData("1\tfirst\n2\tsecond\n"), copyDone(), query("SELECT count(*) FROM wire_data"), terminate()]);
    let atFlush: { readonly types: string; readonly queued: number } | undefined;
    run.sink.onFlushSync = () => { atFlush = { types: types(run), queued: run.connection.pending() }; };
    await run.done;
    expect(atFlush?.types).toBe("RSSSSSSZG");
    expect(atFlush?.queued).toBeGreaterThan(0);
    expect(run.sink.syncFlushes).toBe(1);
    expect(types(run)).toBe("RSSSSSSZGCZTDCZ");
    expect(await stored()).toEqual([{ n: 1, label: "first" }, { n: 2, label: "second" }]);
    expect(run.sink.messages().filter(item => item.type === "D").map(item => dataRow(item.body))).toEqual([["2"]]);
  });

  it("takes data sent in many CopyData messages and a large one", async () => {
    const big = `${Array.from({ length: 5000 }, (_value, index) => `${String(index)}\trow ${String(index)}`).join("\n")}\n`;
    const run = begin([startup(), query("COPY wire_data FROM STDIN"), copyData("-1\tfirst\n"), copyData(big), copyData("-2\tlast\n"), copyDone(), terminate()]);
    await run.done;
    expect((await db.query<{ count: string }>("SELECT count(*)::text AS count FROM wire_data")).rows).toEqual([{ count: "5002" }]);
  });

  it("works through the extended protocol, as psycopg uses it", async () => {
    const parse = message("P", join(cstring(""), cstring("COPY wire_data FROM STDIN"), int16(0)));
    const bind = message("B", join(cstring(""), cstring(""), int16(0), int16(0), int16(0)));
    const execute = message("E", join(cstring(""), int32(0)));
    const run = begin([startup(), parse, bind, execute, copyData("7\tseven\n"), copyDone(), message("S"), terminate()]);
    await run.done;
    expect(types(run)).toBe("RSSSSSSZ12GCZ");
    expect(await stored()).toEqual([{ n: 7, label: "seven" }]);
  });

  it("reports a CopyFail from the client as the statement's error and carries on", async () => {
    const run = begin([startup(), query("COPY wire_data FROM STDIN"), copyData("1\tnever stored\n"), message("f", cstring("changed my mind")), query("SELECT count(*) FROM wire_data"), terminate()]);
    await run.done;
    expect(types(run)).toBe("RSSSSSSZGEZTDCZ");
    expect(errorFields(run.sink.messages().find(item => item.type === "E")?.body ?? new Uint8Array(0))["M"]).toContain("changed my mind");
    expect(await stored()).toEqual([]);
  });

  it("ends the session when the client sends something that is not a COPY message", async () => {
    const run = begin([startup(), query("COPY wire_data FROM STDIN"), query("SELECT 1")]);
    await expect(run.done).rejects.toThrow("Invalid COPY frontend message");
    expect(await stored()).toEqual([]);
    expect(db.isInTransaction()).toBe(false);
  });

  it("ends the session when the client vanishes in the middle of the data", async () => {
    const run = begin([startup(), query("COPY wire_data FROM STDIN"), copyData("1\tfirst\n")], { closed: true });
    await expect(run.done).rejects.toThrow("Client disconnected during COPY");
    expect(await stored()).toEqual([]);
    expect(db.isInTransaction()).toBe(false);
  });

  it("refuses a CopyData message longer than 16 MiB, and a body on CopyDone", async () => {
    const huge = begin([startup(), query("COPY wire_data FROM STDIN"), join(Uint8Array.of(100), int32(16 * 1024 ** 2 + 5))]);
    await expect(huge.done).rejects.toThrow("Invalid COPY frontend message");
    const body = begin([startup(), query("COPY wire_data FROM STDIN"), message("c", Uint8Array.of(1))]);
    await expect(body.done).rejects.toThrow("Invalid COPY message body");
    const unterminated = begin([startup(), query("COPY wire_data FROM STDIN"), message("f", new TextEncoder().encode("no terminator"))]);
    await expect(unterminated.done).rejects.toThrow("Invalid COPY message body");
  });

  it("refuses an exchange of more than 64 MiB", async () => {
    const chunk = message("d", new Uint8Array(15 * 1024 ** 2));
    const run = begin([startup(), query("COPY wire_data FROM STDIN"), chunk, chunk, chunk, chunk, chunk]);
    await expect(run.done).rejects.toThrow("COPY exchange exceeds 64 MiB");
    expect(db.isInTransaction()).toBe(false);
  });
});

describe("COPY TO STDOUT", () => {
  it("streams the rows as CopyData between CopyOutResponse and CopyDone", async () => {
    await db.exec("INSERT INTO wire_data VALUES (1, 'first'), (2, 'second')");
    const run = begin([startup(), query("COPY wire_data TO STDOUT"), terminate()]);
    await run.done;
    expect(types(run)).toBe("RSSSSSSZHddcCZ");
    expect(run.sink.messages().filter(item => item.type === "d").map(item => new TextDecoder().decode(item.body))).toEqual(["1\tfirst\n", "2\tsecond\n"]);
    expect(run.sink.syncFlushes).toBe(0);
  });
});

describe("COPY without the VM file system", () => {
  it("fails instead of reading data PostgreSQL could not store durably", async () => {
    const memory = await PGlite.create();
    try {
      await memory.exec("CREATE TABLE wire_data(n integer, label text)");
      const run = begin([startup(), query("COPY wire_data FROM STDIN"), copyData("1\tx\n"), copyDone()], { database: memory });
      await expect(run.done).rejects.toThrow("COPY requires the VM filesystem adapter");
    } finally {
      await memory.close();
    }
  });
});
