import { describe, expect, it } from "vitest";
import { decodeReply, readLine, readLineSync, stopChild } from "../src/sidecar.ts";
import type { Descriptor, NativeProcesses } from "../src/ports.ts";
import { descriptor, processId } from "./support/node-files.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const pipe: Descriptor = descriptor(7);

/** A pipe that hands out the given chunks one read at a time, then reports the end of the stream. */
function chunks(...parts: readonly string[]): { read(fd: Descriptor, count: number): Uint8Array; readonly counts: number[] } {
  const queue = [...parts], counts: number[] = [];
  return { counts, read(_fd, count) { counts.push(count); const next = queue.shift(); return next === undefined ? new Uint8Array(0) : encode(next); } };
}

describe("readLineSync", () => {
  it("collects a line that arrives in pieces, reading 4096 bytes at most", () => {
    const source = chunks('{"ok":', "true}\n");
    expect(readLineSync(source, pipe, "The helper")).toBe('{"ok":true}\n');
    expect(source.counts).toEqual([4096, 4096]);
  });

  it("names the helper when its pipe ends first", () => {
    expect(() => readLineSync(chunks('{"ok":'), pipe, "The native metadata helper")).toThrow("The native metadata helper exited");
  });

  it("refuses a reply longer than 8192 bytes without a newline", () => {
    expect(() => readLineSync(chunks("x".repeat(5000), "x".repeat(5000)), pipe, "The helper")).toThrow("The helper reply exceeds its limit");
    expect(readLineSync(chunks("x".repeat(8000), "\n"), pipe, "The helper")).toHaveLength(8001);
  });

  it("decodes characters split across reads", () => {
    const bytes = encode("é\n");
    let step = 0;
    const source = { read: () => { step += 1; return step === 1 ? bytes.subarray(0, 1) : step === 2 ? bytes.subarray(1) : new Uint8Array(0); } };
    expect(readLineSync(source, pipe, "The helper")).toBe("é\n");
  });
});

describe("readLine", () => {
  it("reads asynchronously with the caller's signal", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const queue = ['{"ok":', "true}\n"];
    const source = { read: (_fd: Descriptor, _count: number, options?: { readonly signal?: AbortSignal }) => { seen.push(options?.signal); return Promise.resolve(encode(queue.shift() ?? "")); } };
    const signal = new AbortController().signal;
    expect(await readLine(source, pipe, "The helper", signal)).toBe('{"ok":true}\n');
    expect(seen).toEqual([signal, signal]);
  });

  it("fails when the pipe ends or the reply is too long", async () => {
    const ended = { read: () => Promise.resolve(new Uint8Array(0)) };
    await expect(readLine(ended, pipe, "The helper", new AbortController().signal)).rejects.toThrow("The helper exited");
    const endless = { read: () => Promise.resolve(encode("x".repeat(4096))) };
    await expect(readLine(endless, pipe, "The helper", new AbortController().signal)).rejects.toThrow("The helper reply exceeds its limit");
  });
});

describe("decodeReply", () => {
  it("reads success and failure replies", () => {
    expect(decodeReply('{"ok":true}\n', "The helper")).toEqual({ ok: true });
    expect(decodeReply('{"ok":false,"errno":13,"error":"denied"}\n', "The helper")).toEqual({ ok: false, errno: 13, error: "denied" });
    expect(decodeReply('{"ok":false}\n', "The helper")).toEqual({ ok: false, errno: undefined, error: "The helper reported a failure" });
  });

  it("rejects anything else", () => {
    for (const line of ["not json\n", "[]\n", "null\n", '{"ok":"yes"}\n', "{}\n", '{"ok":true,"extra":1}\n', '{"ok":false,"errno":"13"}\n', '{"ok":false,"errno":1.5}\n', '{"ok":false,"error":7}\n']) {
      expect(() => decodeReply(line, "The helper"), line).toThrow("The helper sent an invalid reply");
    }
  });
});

describe("stopChild", () => {
  function fakeProcesses(waits: readonly ("exits" | "hangs")[]): { processes: Pick<NativeProcesses, "wait" | "signal">; readonly signals: number[]; readonly waited: number[] } {
    const signals: number[] = [], waited: number[] = [], queue = [...waits];
    return {
      signals,
      waited,
      processes: {
        signal: (_pid, signal) => { signals.push(signal); return Promise.resolve(); },
        wait: (pid, options) => {
          waited.push(pid);
          if (queue.shift() === "exits") return Promise.resolve({ kind: "exited" as const, code: 0 });
          return new Promise((_resolve, reject) => {
            const signal = options?.signal;
            if (signal?.aborted === true) reject(new Error("timed out"));
            else signal?.addEventListener("abort", () => { reject(new Error("timed out")); }, { once: true });
          });
        },
      },
    };
  }
  const child = processId(1);

  it("lets a child that exits by itself go", async () => {
    const { processes, signals } = fakeProcesses(["exits"]);
    await stopChild(processes, child, AbortSignal.abort());
    expect(signals).toEqual([]);
  });

  it("kills a child that outlives its grace period and waits for it", async () => {
    const { processes, signals, waited } = fakeProcesses(["hangs", "exits"]);
    await stopChild(processes, child, AbortSignal.abort());
    expect(signals).toEqual([9]);
    expect(waited).toHaveLength(2);
  });
});
