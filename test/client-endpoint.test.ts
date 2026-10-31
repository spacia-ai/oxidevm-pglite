import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { kit } from "@oxidevm/sdk/wasm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jsonEndpoint } from "../src/json-endpoint.ts";
import type { Connection } from "../src/ports.ts";
import { descriptor } from "./support/node-files.ts";
import { GUEST, runPython } from "./support/python.ts";

let directory = "", socketPath = "";
let db: PGlite;
let server: net.Server;

/** Adapts a Node socket to the connection the runner hands a handler. */
function connectionOf(socket: net.Socket, ended: AbortController): Connection {
  return {
    fd: descriptor(9),
    signal: ended.signal,
    read: maxBytes => new Promise<Uint8Array>((resolve, reject) => {
      const attempt = (): void => {
        const chunk: unknown = socket.read(maxBytes);
        if (chunk instanceof Uint8Array) { cleanup(); resolve(chunk); return; }
        if (socket.readableEnded || socket.destroyed) { cleanup(); resolve(new Uint8Array(0)); }
      };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const cleanup = (): void => { socket.off("readable", attempt); socket.off("end", attempt); socket.off("error", fail); };
      socket.on("readable", attempt);
      socket.on("end", attempt);
      socket.on("error", fail);
      attempt();
    }),
    write: bytes => new Promise<void>((resolve, reject) => { socket.write(bytes, error => { if (error === null || error === undefined) resolve(); else reject(error); }); }),
  };
}

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-client-endpoint-"));
  socketPath = path.join(directory, "pglite.sock");
  db = await PGlite.create();
  const handler = jsonEndpoint({
    database: { query: (sql, params) => db.query<Record<string, unknown>>(sql, params) },
    gate: kit.gate(),
    pid: 4242,
    framing: kit.framing,
  });
  server = net.createServer(socket => {
    const ended = new AbortController();
    socket.on("error", () => undefined);
    handler(connectionOf(socket, ended)).catch(() => undefined).finally(() => { ended.abort(); socket.end(); });
  });
  await new Promise<void>(resolve => { server.listen(socketPath, resolve); });
});
afterAll(async () => {
  server.close();
  await db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function python(code: string): Promise<string> {
  const program = `import sys, json\nsys.path[:0] = [${JSON.stringify(GUEST)}]\nimport oxidevm_pglite as pg\nSOCKET = ${JSON.stringify(socketPath)}\ndef q(sql, params=None): return pg.query(sql, params, path=SOCKET)\n${code}`;
  const run = await runPython(["-I", "-c", program], "");
  expect(run.stderr).toBe("");
  return run.stdout.trim();
}

describe("the Python client against the real endpoint", () => {
  it("runs a parameterized query and returns PGlite's result with the service pid", async () => {
    const out = await python('print(json.dumps(q("SELECT $1::int + 1 AS next", [41])))');
    expect(JSON.parse(out)).toMatchObject({ rows: [{ next: 42 }], fields: [{ name: "next", dataTypeID: 23 }], pid: 4242, backend: "pglite-wasm", command: "SELECT" });
  });

  it("creates, fills and reads a table across calls", async () => {
    const out = await python([
      'q("CREATE TABLE people(id integer PRIMARY KEY, name text, active boolean, score double precision, tags text[], meta jsonb)")',
      'q("INSERT INTO people VALUES ($1, $2, $3, $4, $5, $6)", [1, "Zoë", True, 2.5, ["a", "b"], {"k": [1, 2]}])',
      'q("INSERT INTO people VALUES ($1, $2, $3, $4, $5, $6)", [2, None, False, None, None, None])',
      'print(json.dumps(q("SELECT * FROM people ORDER BY id")["rows"]))',
      'print(q("SELECT count(*) AS n FROM people")["rows"][0]["n"])',
    ].join("\n"));
    const [rows, count] = out.split("\n");
    expect(JSON.parse(rows ?? "")).toEqual([
      { id: 1, name: "Zoë", active: true, score: 2.5, tags: ["a", "b"], meta: { k: [1, 2] } },
      { id: 2, name: null, active: false, score: null, tags: null, meta: null },
    ]);
    expect(count).toBe("2");
  });

  it("carries 64-bit integers as text", async () => {
    expect(await python('print(q("SELECT 9223372036854775807::bigint AS big")["rows"][0]["big"] == "9223372036854775807")')).toBe("True");
  });

  it("raises the database's error, then keeps working", async () => {
    const out = await python([
      "try:",
      '    q("SELECT * FROM nowhere")',
      "except pg.PGliteError as error:",
      "    print(error)",
      'print(q("SELECT 1 AS one")["rows"])',
    ].join("\n"));
    expect(out.split("\n")).toEqual(['relation "nowhere" does not exist', "[{'one': 1}]"]);
  });

  it("is told that COPY needs the PostgreSQL port", async () => {
    const out = await python('try:\n    q("COPY people FROM STDIN")\nexcept pg.PGliteError as error:\n    print(error)');
    expect(out).toBe("COPY is unavailable through this experimental SQL bridge");
  });

  it("keeps a transaction open across calls, as one embedded session does", async () => {
    const out = await python([
      'q("BEGIN")',
      'q("INSERT INTO people(id, name) VALUES (3, \'in transaction\')")',
      'print(q("SELECT count(*) AS n FROM people")["rows"][0]["n"])',
      'q("ROLLBACK")',
      'print(q("SELECT count(*) AS n FROM people")["rows"][0]["n"])',
    ].join("\n"));
    expect(out.split("\n")).toEqual(["3", "2"]);
  });
});
