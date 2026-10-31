import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUEST } from "./support/python.ts";

const script = path.join(GUEST, "pg-writer.py");

interface Writer {
  readonly child: ChildProcessByStdio<Writable, null, Readable>;
  readonly spool: string;
  /** Everything the client has received so far. */
  received(): Buffer;
  /** Asks the helper to send the spool and returns its answer. */
  send(command?: string): Promise<unknown>;
  closeClient(): Promise<void>;
  exit(): Promise<number | null>;
}

let directory = "";
const servers: net.Server[] = [];
const children: ChildProcessByStdio<Writable, null, Readable>[] = [];
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-writer-")); });
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const server of servers.splice(0)) server.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

/** Starts the helper with a connected unix socket as its standard output, like the module does with a client's socket. */
async function start(): Promise<Writer> {
  const socketPath = path.join(directory, "client.sock");
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>(resolve => { server.listen(socketPath, resolve); });
  const accepted = new Promise<net.Socket>(resolve => { server.once("connection", resolve); });
  const outgoing = net.connect(socketPath);
  await new Promise<void>(resolve => { outgoing.once("connect", resolve); });
  const client = await accepted;
  const received: Buffer[] = [];
  client.on("data", (chunk: Buffer) => { received.push(chunk); });
  const spool = path.join(directory, "response.out");
  const child = spawn("python3", ["-u", "-B", script, spool], { stdio: ["pipe", outgoing, "pipe"], env: { PATH: process.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1" } });
  children.push(child);
  outgoing.destroy();
  const answers: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  let buffered = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    buffered += chunk;
    for (let cut = buffered.indexOf("\n"); cut >= 0; cut = buffered.indexOf("\n")) {
      const line = buffered.slice(0, cut);
      buffered = buffered.slice(cut + 1);
      const next = waiting.shift();
      if (next === undefined) answers.push(line); else next(line);
    }
  });
  const exited = new Promise<number | null>(resolve => { child.on("close", code => { resolve(code); }); });
  return {
    child,
    spool,
    received: () => Buffer.concat(received),
    send: async (command = "send\n") => {
      child.stdin.write(command);
      const line = answers.shift() ?? await new Promise<string>(resolve => { waiting.push(resolve); });
      const parsed: unknown = JSON.parse(line);
      return parsed;
    },
    closeClient: async () => { await new Promise<void>(resolve => { client.once("close", () => { resolve(); }); client.destroy(); }); },
    exit: () => { child.stdin.end(); return exited; },
  };
}

/** Waits until the client has received `size` bytes. */
async function receivedAll(writer: Writer, size: number): Promise<Buffer> {
  for (let attempt = 0; writer.received().length < size; attempt += 1) {
    if (attempt > 2000) throw new Error(`The client received ${String(writer.received().length)} of ${String(size)} bytes`);
    await new Promise(resolve => { setImmediate(resolve); });
  }
  return writer.received();
}

describe("pg-writer.py", () => {
  it("copies the spool to the client's socket and says ok", async () => {
    const writer = await start();
    fs.writeFileSync(writer.spool, "hello, client");
    expect(await writer.send()).toEqual({ ok: true });
    expect((await receivedAll(writer, 13)).toString()).toBe("hello, client");
    expect(await writer.exit()).toBe(0);
  });

  it("sends a spool of several megabytes intact, and later spools after it", async () => {
    const writer = await start();
    const big = Buffer.alloc(3 * 1024 ** 2 + 17);
    for (let index = 0; index < big.length; index += 1) big[index] = index % 251;
    fs.writeFileSync(writer.spool, big);
    expect(await writer.send()).toEqual({ ok: true });
    fs.writeFileSync(writer.spool, "tail");
    expect(await writer.send()).toEqual({ ok: true });
    const all = await receivedAll(writer, big.length + 4);
    expect(Buffer.compare(all.subarray(0, big.length), big)).toBe(0);
    expect(all.subarray(big.length).toString()).toBe("tail");
  });

  it("sends nothing and still says ok for an empty spool", async () => {
    const writer = await start();
    fs.writeFileSync(writer.spool, "");
    expect(await writer.send()).toEqual({ ok: true });
    expect(writer.received().length).toBe(0);
  });

  it("reports a client that has gone, and keeps failing without ending", async () => {
    const writer = await start();
    fs.writeFileSync(writer.spool, "x".repeat(100_000));
    await writer.closeClient();
    const first = await writer.send();
    expect(first).toMatchObject({ ok: false });
    const second = await writer.send();
    expect(second).toEqual({ ok: false, error: "PostgreSQL client disconnected" });
    expect(writer.child.exitCode).toBeNull();
    expect(writer.child.signalCode).toBeNull();
    expect(await writer.exit()).toBe(0);
  });

  it("refuses commands other than send, and then treats the client as gone", async () => {
    const writer = await start();
    fs.writeFileSync(writer.spool, "data");
    expect(await writer.send("sned\n")).toEqual({ ok: false, error: "Invalid response writer command" });
    expect(await writer.send()).toEqual({ ok: false, error: "PostgreSQL client disconnected" });
    expect(writer.received().length).toBe(0);
  });

  it("reports a missing spool", async () => {
    const writer = await start();
    expect(await writer.send()).toMatchObject({ ok: false });
  });
});
