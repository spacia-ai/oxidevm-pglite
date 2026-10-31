import { describe, expect, it } from "vitest";
import { MAX_SPOOL_BYTES, createWriterFactory } from "../src/writer.ts";
import type { WriterHost, WriterOptions } from "../src/writer.ts";
import type { Descriptor, NativeProcesses } from "../src/ports.ts";
import { descriptor, processId, text } from "./support/node-files.ts";

type Spawn = Parameters<NativeProcesses["spawn"]>;

/**
 * The machine around one writer helper: a descriptor table (to see which descriptor the child inherits as its
 * standard output), the spool file, the client socket and the helper itself, which copies the spool to the socket
 * and answers "ok" until the client is gone, as pg-writer.py does.
 */
class World {
  readonly events: string[] = [];
  readonly stdout = descriptor(1);
  readonly table = new Map<number, string>([[1, "terminal"]]);
  readonly files = new Map<string, Uint8Array[]>();
  readonly open = new Map<number, string>();
  readonly spawned: { readonly spec: Spawn[0]; readonly stdoutIs: string | undefined }[] = [];
  readonly sockets = new Map<string, { received: Uint8Array[]; gone: boolean }>();
  readonly acks: string[] = [];
  readonly signals: number[] = [];
  readonly unlinks: string[] = [];
  readonly closed: number[] = [];
  next = 100;
  childExits = true;
  spawnGate: Promise<undefined> | undefined;
  pipes = true;
  failUnlink = false;
  private failed = false;

  socket(name: string): Descriptor {
    const fd = descriptor(this.next++);
    this.table.set(fd, name);
    this.sockets.set(name, { received: [], gone: false });
    return fd;
  }

  get host(): WriterHost {
    return {
      stdout: this.stdout,
      fs: {
        dup: (fd, target) => {
          const label = this.table.get(fd) ?? "unknown";
          if (target !== undefined) { this.table.set(target, label); this.events.push(`dup:${label}->${String(target)}`); return target; }
          const copy = descriptor(this.next++);
          this.table.set(copy, label);
          this.events.push(`save:${label}`);
          return copy;
        },
        open: (spool, flags = 0) => {
          const fd = descriptor(this.next++);
          this.open.set(fd, text(spool));
          if ((flags & 0o1000) !== 0) this.files.set(text(spool), []);
          this.events.push(`open:${text(spool)}:${String(flags)}`);
          return fd;
        },
        close: fd => { this.closed.push(fd); this.events.push(`close:${String(fd)}`); this.open.delete(fd); },
        writeAll: (fd, bytes) => {
          if (fd === this.pipeIn) { this.command(bytes); return; }
          const spool = this.open.get(fd);
          if (spool === undefined) throw new Error("write to a descriptor that is not open");
          this.files.get(spool)?.push(Uint8Array.from(bytes));
          this.events.push(`write:${String(bytes.length)}`);
        },
        read: (fd) => new TextEncoder().encode(fd === this.pipeOut ? this.acks.shift() ?? "" : ""),
        unlink: spool => {
          if (this.failUnlink) throw new Error("ENOENT");
          this.unlinks.push(text(spool));
          this.files.delete(text(spool));
        },
      },
      files: {
        writeAll: (fd, bytes) => { this.command(bytes); return fd === this.pipeIn ? Promise.resolve() : Promise.reject(new Error("wrong descriptor")); },
        read: (fd) => Promise.resolve(new TextEncoder().encode(fd === this.pipeOut ? this.acks.shift() ?? "" : "")),
      },
      process: {
        spawn: async spec => {
          this.spawned.push({ spec, stdoutIs: this.table.get(1) });
          this.events.push(`spawn:${this.table.get(1) ?? "?"}`);
          if (this.spawnGate !== undefined) await this.spawnGate;
          this.child = { spool: spec.args?.[2] ?? "", socket: this.table.get(1) ?? "" };
          return { pid: processId(900), stdin: this.pipes ? this.pipeIn : null, stdout: null, stderr: this.pipes ? this.pipeOut : null };
        },
        wait: (_pid, options) => {
          this.events.push("wait");
          if (this.childExits || this.signals.length > 0) return Promise.resolve({ kind: "exited" as const, code: 0 });
          return new Promise((_resolve, reject) => { if (options?.signal?.aborted === true) reject(new Error("still running")); });
        },
        signal: (_pid, signal) => { this.signals.push(signal); this.events.push(`signal:${String(signal)}`); return Promise.resolve(); },
      },
    };
  }

  readonly pipeIn = descriptor(7001);
  readonly pipeOut = descriptor(7002);
  private child: { spool: string; socket: string } | undefined;

  /** What the helper does with a command on its standard input. */
  private command(bytes: Uint8Array): void {
    const text = new TextDecoder().decode(bytes);
    const child = this.child;
    if (child === undefined) return;
    const socket = this.sockets.get(child.socket);
    if (text !== "send\n" || this.failed || socket === undefined || socket.gone) {
      this.failed = true;
      this.acks.push(`${JSON.stringify({ ok: false, error: "PostgreSQL client disconnected" })}\n`);
      return;
    }
    for (const part of this.files.get(child.spool) ?? []) socket.received.push(part);
    this.acks.push('{"ok":true}\n');
  }

  received(name: string): string {
    return (this.sockets.get(name)?.received ?? []).map(part => new TextDecoder().decode(part)).join("");
  }

  disconnect(name: string): void {
    const socket = this.sockets.get(name);
    if (socket !== undefined) socket.gone = true;
  }
}

const options = (extra: Partial<WriterOptions> = {}): WriterOptions => ({ script: "/workspace/_oxidevm/pg-writer.py", spoolDirectory: "/workspace/_oxidevm", uuid: () => "spool-1", grace: () => AbortSignal.abort(), ...extra });
const signal = new AbortController().signal;
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("opening a writer", () => {
  it("lends the client's socket to the helper as its standard output while it starts, then puts the terminal back", async () => {
    const world = new World();
    const client = world.socket("client-A");
    await createWriterFactory(world.host, options()).open(client);
    expect(world.spawned).toHaveLength(1);
    expect(world.spawned[0]).toEqual({
      spec: { command: "/usr/bin/python3", args: ["-u", "/workspace/_oxidevm/pg-writer.py", "/workspace/_oxidevm/pgwire-spool-1.out"], stdio: { stdin: "pipe", stdout: "inherit", stderr: "pipe" } },
      stdoutIs: "client-A",
    });
    expect(world.table.get(1)).toBe("terminal");
    expect(world.events.slice(0, 3)).toEqual(["save:terminal", "dup:client-A->1", "spawn:client-A"]);
    expect(world.events.slice(3, 5)).toEqual(["dup:terminal->1", expect.stringMatching(/^close:/u)]);
  });

  it("starts one helper at a time, so that two clients never share the borrowed standard output", async () => {
    const world = new World();
    const factory = createWriterFactory(world.host, options());
    const releaseFirst = Promise.withResolvers<undefined>();
    world.spawnGate = releaseFirst.promise;
    const first = factory.open(world.socket("client-A"));
    const second = factory.open(world.socket("client-B"));
    await new Promise(resolve => { setTimeout(resolve, 0); });
    expect(world.spawned.map(item => item.stdoutIs)).toEqual(["client-A"]);
    world.spawnGate = undefined;
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);
    expect(world.spawned.map(item => item.stdoutIs)).toEqual(["client-A", "client-B"]);
    expect(world.table.get(1)).toBe("terminal");
    const events = world.events.filter(event => event.startsWith("dup:") || event.startsWith("spawn:"));
    expect(events).toEqual(["dup:client-A->1", "spawn:client-A", "dup:terminal->1", "dup:client-B->1", "spawn:client-B", "dup:terminal->1"]);
  });

  it("still lets the next client start when a spawn fails, and restores the standard output", async () => {
    const world = new World();
    const host = world.host;
    let first = true;
    const failing: WriterHost = { ...host, process: { ...host.process, spawn: spec => { if (first) { first = false; return Promise.reject(new Error("no python")); } return host.process.spawn(spec); } } };
    const factory = createWriterFactory(failing, options());
    await expect(factory.open(world.socket("client-A"))).rejects.toThrow("no python");
    expect(world.table.get(1)).toBe("terminal");
    await factory.open(world.socket("client-B"));
    expect(world.spawned.map(item => item.stdoutIs)).toEqual(["client-B"]);
  });

  it("kills a helper that came without pipes and refuses to start", async () => {
    const world = new World();
    world.pipes = false;
    await expect(createWriterFactory(world.host, options()).open(world.socket("client-A"))).rejects.toThrow("Native PostgreSQL response writer requires pipes");
    expect(world.signals).toEqual([9]);
  });
});

describe("a writer", () => {
  async function opened(extra: Partial<WriterOptions> = {}): Promise<{ world: World; writer: Awaited<ReturnType<ReturnType<typeof createWriterFactory>["open"]>> }> {
    const world = new World();
    const writer = await createWriterFactory(world.host, options(extra)).open(world.socket("client"));
    return { world, writer };
  }

  it("spools a response and has the helper send it, asynchronously", async () => {
    const { world, writer } = await opened();
    writer.reset();
    writer.write(bytes("first "));
    writer.write(bytes("second"));
    await writer.flush(signal);
    expect(world.received("client")).toBe("first second");
    writer.reset();
    writer.write(bytes(" again"));
    await writer.flush(signal);
    expect(world.received("client")).toBe("first second again");
  });

  it("sends blocking, for the moment PostgreSQL waits for the client's COPY data", async () => {
    const { world, writer } = await opened();
    writer.reset();
    writer.write(bytes("CopyInResponse"));
    writer.flushSync();
    expect(world.received("client")).toBe("CopyInResponse");
  });

  it("opens the spool for writing, creating and truncating it, and starts over on reset", async () => {
    const { world, writer } = await opened();
    writer.reset();
    writer.write(bytes("discard me"));
    writer.reset();
    writer.write(bytes("keep"));
    await writer.flush(signal);
    expect(world.received("client")).toBe("keep");
    expect(world.events.filter(event => event.startsWith("open:"))).toEqual(["open:/workspace/_oxidevm/pgwire-spool-1.out:577", "open:/workspace/_oxidevm/pgwire-spool-1.out:577"]);
  });

  it("writes the spool in pieces of at most 64 KiB", async () => {
    const { world, writer } = await opened();
    writer.reset();
    writer.write(new Uint8Array(150_000));
    expect(world.events.filter(event => event.startsWith("write:"))).toEqual(["write:65536", "write:65536", "write:18928"]);
    await writer.flush(signal);
  });

  it("refuses a response over the spool limit, and accepts one exactly at it", async () => {
    const { writer } = await opened({ maxSpoolBytes: 100 });
    writer.reset();
    writer.write(new Uint8Array(100));
    expect(() => { writer.write(new Uint8Array(1)); }).toThrow("PostgreSQL response exceeds the 512 MiB spool limit");
    expect(MAX_SPOOL_BYTES).toBe(512 * 1024 ** 2);
  });

  it("has no spool before the first reset or after a flush", async () => {
    const { writer } = await opened();
    expect(() => { writer.write(bytes("x")); }).toThrow("Response spool is closed");
    writer.reset();
    writer.write(bytes("x"));
    await writer.flush(signal);
    expect(() => { writer.write(bytes("y")); }).toThrow("Response spool is closed");
  });

  it("reports a client that stopped receiving, on every later flush too", async () => {
    const { world, writer } = await opened();
    world.disconnect("client");
    writer.reset();
    writer.write(bytes("lost"));
    await expect(writer.flush(signal)).rejects.toThrow("PostgreSQL client stopped receiving data");
    writer.reset();
    expect(() => { writer.flushSync(); }).toThrow("PostgreSQL client stopped receiving data");
  });

  it("fails when the helper sends something that is not an answer", async () => {
    const { world, writer } = await opened();
    writer.reset();
    world.acks.push("garbage\n");
    world.acks.push("garbage\n");
    await expect(writer.flush(signal)).rejects.toThrow("PostgreSQL response writer sent an invalid reply");
  });

  it("ends the spool, closes the helper's input, waits for it, closes the answer pipe and removes the spool", async () => {
    const { world, writer } = await opened();
    writer.reset();
    world.events.length = 0;
    await writer.close();
    expect(world.events).toEqual([expect.stringMatching(/^close:\d+$/u), "close:7001", "wait", "close:7002"]);
    expect(world.unlinks).toEqual(["/workspace/_oxidevm/pgwire-spool-1.out"]);
    expect(world.signals).toEqual([]);
  });

  it("kills a helper that does not exit, and does not fail when no spool was ever written", async () => {
    const { world, writer } = await opened();
    world.childExits = false;
    world.failUnlink = true;
    await writer.close();
    expect(world.signals).toEqual([9]);
  });
});
