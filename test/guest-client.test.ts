import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "../src/bytes.ts";
import { frame } from "./support/connection.ts";
import { GUEST, runPython } from "./support/python.ts";

let directory = "";
const servers: net.Server[] = [];
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-client-")); });
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

interface Endpoint { readonly socket: string; readonly requests: unknown[]; readonly connections: () => number }

/** A stand-in for the module's endpoint: reads one framed request, records it and lets `reply` answer. */
async function endpoint(reply: (request: unknown, connection: net.Socket) => void): Promise<Endpoint> {
  const socket = path.join(directory, "pglite.sock");
  const requests: unknown[] = [];
  let connections = 0;
  const server = net.createServer(connection => {
    connections += 1;
    let received = Buffer.alloc(0);
    connection.on("error", () => undefined);
    connection.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4 || received.length < 4 + received.readUInt32BE(0)) return;
      const parsed: unknown = JSON.parse(received.subarray(4, 4 + received.readUInt32BE(0)).toString("utf8"));
      requests.push(parsed);
      reply(parsed, connection);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => { server.listen(socket, resolve); });
  return { socket, requests, connections: () => connections };
}

const answer = (connection: net.Socket, value: unknown): void => { connection.end(Buffer.from(frame(JSON.stringify(value)))); };

/** Runs Python code that imports the client from the guest directory. */
function client(code: string, socket: string, extra: readonly string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const program = `import sys\nsys.path[:0] = ${JSON.stringify([...extra, GUEST])}\nimport oxidevm_pglite as pg\nSOCKET = ${JSON.stringify(socket)}\n${code}`;
  return runPython(["-I", "-c", program], "");
}

describe("oxidevm_pglite.query", () => {
  it("sends { sql, params } in one framed request and returns the result of an ok reply", async () => {
    const result = { rows: [{ next: 42 }], fields: [{ name: "next", dataTypeID: 23 }], affectedRows: 0, pid: 7, backend: "pglite-wasm" };
    const server = await endpoint((_request, connection) => { answer(connection, { ok: true, result }); });
    const run = await client('import json\nprint(json.dumps(pg.query("SELECT $1::int + 1 AS next", [41], path=SOCKET)))', server.socket);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout.trim())).toEqual(result);
    expect(server.requests).toEqual([{ sql: "SELECT $1::int + 1 AS next", params: [41] }]);
  });

  it("sends an empty parameter list by default, takes tuples, and passes null, booleans, text and nested values through", async () => {
    const server = await endpoint((_request, connection) => { answer(connection, { ok: true, result: {} }); });
    await client('pg.query("SELECT 1", path=SOCKET)\npg.query("SELECT 2", (1, "é", None, True, [1, 2], {"a": 1.5}), path=SOCKET)', server.socket);
    expect(server.requests).toEqual([{ sql: "SELECT 1", params: [] }, { sql: "SELECT 2", params: [1, "é", null, true, [1, 2], { a: 1.5 }] }]);
  });

  it("raises PGliteError, a RuntimeError, with the database's message", async () => {
    const server = await endpoint((_request, connection) => { answer(connection, { ok: false, error: 'relation "t" does not exist' }); });
    const run = await client('try:\n    pg.query("SELECT * FROM t", path=SOCKET)\nexcept RuntimeError as error:\n    print(type(error).__name__, error)', server.socket);
    expect(run.stdout.trim()).toBe('PGliteError relation "t" does not exist');
  });

  it("refuses wrong argument types without connecting", async () => {
    const server = await endpoint((_request, connection) => { answer(connection, { ok: true, result: {} }); });
    const run = await client('for args in [(1,), ("x", "y"), ("x", {"a": 1}), (None,)]:\n    try:\n        pg.query(*args, path=SOCKET)\n    except TypeError as error:\n        print(error)', server.socket);
    expect(run.stdout.trim().split("\n")).toEqual(Array<string>(4).fill("query expects SQL text and a parameter list"));
    expect(server.connections()).toBe(0);
  });

  it("refuses a request over 64 KiB without connecting, and accepts one of exactly 64 KiB", async () => {
    const server = await endpoint((_request, connection) => { answer(connection, { ok: true, result: { rows: [] } }); });
    const exact = 65536 - JSON.stringify({ sql: "", params: [] }).length;
    const run = await client(`pg.query("x" * ${String(exact)}, path=SOCKET)\ntry:\n    pg.query("x" * ${String(exact + 1)}, path=SOCKET)\nexcept ValueError as error:\n    print(error)`, server.socket);
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("Database request exceeds 64 KiB");
    expect(server.connections()).toBe(1);
  });

  it("counts the 64 KiB in UTF-8 bytes, writes compact JSON, and refuses NaN", async () => {
    const server = await endpoint((_request, connection) => { answer(connection, { ok: true, result: { rows: [] } }); });
    // {"sql":"","params":[]} is 22 bytes, so the text may be 65514 bytes: 32757 two-byte characters.
    const run = await client([
      'pg.query("é" * 32757, path=SOCKET)',
      "try:",
      '    pg.query("é" * 32758, path=SOCKET)',
      "except ValueError as error:",
      "    print(error)",
      "try:",
      '    pg.query("SELECT $1", [float("nan")], path=SOCKET)',
      "except ValueError as error:",
      "    print(error)",
    ].join("\n"), server.socket);
    expect(run.stderr).toBe("");
    expect(run.stdout.trim().split("\n")[0]).toBe("Database request exceeds 64 KiB");
    expect(run.stdout).toContain("not JSON compliant");
    expect(server.connections()).toBe(1);
  });

  it("reads a reply that arrives in small pieces", async () => {
    const server = await endpoint((_request, connection) => {
      const bytes = Buffer.from(frame(JSON.stringify({ ok: true, result: { rows: [{ text: "x".repeat(300_000) }] } })));
      for (let offset = 0; offset < bytes.length; offset += 7919) connection.write(bytes.subarray(offset, offset + 7919));
      connection.end();
    });
    const run = await client('print(len(pg.query("SELECT 1", path=SOCKET)["rows"][0]["text"]))', server.socket);
    expect(run.stdout.trim()).toBe("300000");
  });

  it("refuses a reply that announces more than 1 MiB", async () => {
    const server = await endpoint((_request, connection) => { connection.end(Buffer.from(join(Uint8Array.of(0, 0x10, 0, 1), new Uint8Array(8)))); });
    const run = await client('try:\n    pg.query("SELECT 1", path=SOCKET)\nexcept pg.PGliteError as error:\n    print(error)', server.socket);
    expect(run.stdout.trim()).toBe("PGlite reply exceeds 1 MiB");
  });

  it("reports a module that closed the connection before it replied, and replies that are not replies", async () => {
    const closing = await endpoint((_request, connection) => { connection.end(); });
    const closed = await client('try:\n    pg.query("SELECT 1", path=SOCKET)\nexcept pg.PGliteError as error:\n    print(error)', closing.socket);
    expect(closed.stdout.trim()).toBe("PGlite closed the connection before it replied");
    fs.rmSync(closing.socket);
    for (const reply of ["[]", '{"ok":"yes"}', '"text"', "{}"]) {
      const odd = await endpoint((_request, connection) => { connection.end(Buffer.from(frame(reply))); });
      const run = await client('try:\n    pg.query("SELECT 1", path=SOCKET)\nexcept pg.PGliteError as error:\n    print(error)', odd.socket);
      expect(run.stdout.trim(), reply).toBe("PGlite sent an invalid reply");
      fs.rmSync(odd.socket);
    }
  });

  it("gives up when the module does not answer within the timeout", async () => {
    const silent = await endpoint(() => undefined);
    const run = await client('try:\n    pg.query("SELECT 1", path=SOCKET, timeout=0.3)\nexcept TimeoutError as error:\n    print("timed out")', silent.socket);
    expect(run.stdout.trim()).toBe("timed out");
  });

  it("fails clearly when nothing listens on the socket", async () => {
    const run = await client('try:\n    pg.query("SELECT 1", path=SOCKET)\nexcept OSError as error:\n    print(type(error).__name__)', path.join(directory, "absent.sock"));
    expect(run.stdout.trim()).toBe("FileNotFoundError");
  });
});

describe("the transport", () => {
  function bridge(source: string): string {
    const modules = path.join(directory, "bridge");
    fs.mkdirSync(modules);
    fs.writeFileSync(path.join(modules, "oxidevm.py"), source);
    return modules;
  }

  it("uses oxidevm.connect_unix when the OxideVM bridge provides it (Pyodide)", async () => {
    const server = await endpoint((_request, connection) => { answer(connection, { ok: true, result: { rows: [1] } }); });
    const modules = bridge([
      "import socket",
      "calls = []",
      "def connect_unix(path):",
      "    calls.append(path)",
      "    connection = socket.socket(socket.AF_UNIX)",
      "    connection.connect(path)",
      "    return connection",
    ].join("\n"));
    const run = await client('import oxidevm\nprint(pg.query("SELECT 1", path=SOCKET)["rows"], oxidevm.calls == [SOCKET])', server.socket, [modules]);
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("[1] True");
  });

  it("accepts a bridge socket that has no settimeout", async () => {
    const server = await endpoint((_request, connection) => { answer(connection, { ok: true, result: { rows: [2] } }); });
    const modules = bridge([
      "import socket",
      "class Plain:",
      "    def __init__(self, path):",
      "        self._socket = socket.socket(socket.AF_UNIX)",
      "        self._socket.connect(path)",
      "    def sendall(self, data): self._socket.sendall(data)",
      "    def recv(self, size): return self._socket.recv(size)",
      "    def close(self): self._socket.close()",
      "def connect_unix(path): return Plain(path)",
    ].join("\n"));
    const run = await client('print(pg.query("SELECT 1", path=SOCKET)["rows"])', server.socket, [modules]);
    expect(run.stdout.trim()).toBe("[2]");
  });

  it("falls back to the socket module when an unrelated oxidevm module has no connect_unix", async () => {
    const server = await endpoint((_request, connection) => { answer(connection, { ok: true, result: { rows: [3] } }); });
    const modules = bridge("VALUE = 1\n");
    const run = await client('print(pg.query("SELECT 1", path=SOCKET)["rows"])', server.socket, [modules]);
    expect(run.stdout.trim()).toBe("[3]");
  });
});
