import { describe, expect, it } from "vitest";
import { HelperError } from "../src/errors.ts";
import { startMetadataHelper } from "../src/metadata.ts";
import type { MetadataHost } from "../src/metadata.ts";
import type { NativeProcesses } from "../src/ports.ts";
import { descriptor, processId } from "./support/node-files.ts";

type Spawn = Parameters<NativeProcesses["spawn"]>[0];

interface Fake {
  readonly host: MetadataHost;
  readonly spawned: Spawn[];
  readonly written: string[];
  readonly closed: number[];
  readonly signals: number[];
  readonly events: string[];
}

/** A helper whose pipes are scripted: each read returns the next reply chunk, then the end of the stream. */
function fake(replies: readonly string[], options: { readonly pipes?: boolean; readonly exitsBy?: "itself" | "never" } = {}): Fake {
  const queue = [...replies], spawned: Spawn[] = [], written: string[] = [], closed: number[] = [], signals: number[] = [], events: string[] = [];
  const host: MetadataHost = {
    fs: {
      read: () => new TextEncoder().encode(queue.shift() ?? ""),
      writeAll: (_fd, bytes) => { written.push(new TextDecoder().decode(bytes)); },
      close: fd => { closed.push(fd); events.push(`close:${String(fd)}`); },
    },
    process: {
      spawn: spec => {
        spawned.push(spec);
        const pipes = options.pipes !== false;
        return Promise.resolve({ pid: processId(77), stdin: pipes ? descriptor(10) : null, stdout: pipes ? descriptor(11) : null, stderr: null });
      },
      wait: (_pid, wait) => {
        events.push("wait");
        if (options.exitsBy !== "never" || wait === undefined) return Promise.resolve({ kind: "exited" as const, code: 0 });
        return Promise.reject(new Error("still running"));
      },
      signal: (_pid, signal) => { signals.push(signal); events.push("signal"); return Promise.resolve(); },
    },
  };
  return { host, spawned, written, closed, signals, events };
}

const options = { script: "/workspace/_oxidevm/pg-metadata.py", roots: ["/workspace/pgdata", "/workspace/_oxidevm/pgdata-migrating"], grace: () => AbortSignal.abort() };

describe("startMetadataHelper", () => {
  it("starts python3 on the script with the allowed directories and pipes for input and output", async () => {
    const { host, spawned } = fake([]);
    await startMetadataHelper(host, options);
    expect(spawned).toEqual([{
      command: "/usr/bin/python3",
      args: ["-u", "/workspace/_oxidevm/pg-metadata.py", "/workspace/pgdata", "/workspace/_oxidevm/pgdata-migrating"],
      stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    }]);
  });

  it("sends one request line and returns when the helper says ok", async () => {
    const { host, written } = fake(['{"ok":true}\n', '{"ok":true}\n']);
    const helper = await startMetadataHelper(host, options);
    helper.utimes("/workspace/pgdata/PG_VERSION", 1_700_000_000_000, 1_700_000_001_500);
    helper.utimes("/workspace/pgdata/base", 1, 2);
    expect(written).toEqual([
      '{"op":"utimes","path":"/workspace/pgdata/PG_VERSION","atimeMs":1700000000000,"mtimeMs":1700000001500}\n',
      '{"op":"utimes","path":"/workspace/pgdata/base","atimeMs":1,"mtimeMs":2}\n',
    ]);
  });

  it("raises the helper's failure with its errno", async () => {
    const { host } = fake(['{"ok":false,"errno":13,"error":"Permission denied"}\n', '{"ok":false,"error":"odd"}\n']);
    const helper = await startMetadataHelper(host, options);
    let failure: unknown;
    try { helper.utimes("/workspace/pgdata/x", 1, 2); } catch (error: unknown) { failure = error; }
    expect(failure).toBeInstanceOf(HelperError);
    expect(failure).toMatchObject({ message: "Permission denied", errno: 13 });
    let second: unknown;
    try { helper.utimes("/workspace/pgdata/x", 1, 2); } catch (error: unknown) { second = error; }
    expect(second).toMatchObject({ message: "odd", errno: 22 });
  });

  it("fails when the helper exits or answers nonsense", async () => {
    const exited = await startMetadataHelper(fake([]).host, options);
    expect(() => { exited.utimes("/workspace/pgdata/x", 1, 2); }).toThrow("The native metadata helper exited");
    const nonsense = await startMetadataHelper(fake(["garbage\n"]).host, options);
    expect(() => { nonsense.utimes("/workspace/pgdata/x", 1, 2); }).toThrow("The native metadata helper sent an invalid reply");
  });

  it("closes its input, waits for the helper, then closes its output", async () => {
    const { host, closed, events, signals } = fake([]);
    const helper = await startMetadataHelper(host, options);
    await helper.close();
    expect(closed).toEqual([10, 11]);
    expect(events).toEqual(["close:10", "wait", "close:11"]);
    expect(signals).toEqual([]);
  });

  it("kills a helper that does not exit", async () => {
    const { host, signals, events } = fake([], { exitsBy: "never" });
    const helper = await startMetadataHelper(host, options);
    await helper.close();
    expect(signals).toEqual([9]);
    expect(events).toEqual(["close:10", "wait", "signal", "wait", "close:11"]);
  });

  it("kills the child and refuses to start when the host gave no pipes", async () => {
    const { host, signals } = fake([], { pipes: false });
    await expect(startMetadataHelper(host, options)).rejects.toThrow("The native metadata helper requires pipes");
    expect(signals).toEqual([9]);
  });
});
