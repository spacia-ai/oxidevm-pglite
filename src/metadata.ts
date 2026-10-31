import { HelperError } from "./errors.ts";
import { PYTHON } from "./layout.ts";
import type { NativeProcesses, SyncFiles } from "./ports.ts";
import { decodeReply, readLineSync, stopChild } from "./sidecar.ts";
import type { Utimes } from "./vm-fs.ts";

/** The host operations the helper client uses. */
export interface MetadataHost {
  readonly fs: Pick<SyncFiles, "read" | "writeAll" | "close">;
  readonly process: Pick<NativeProcesses, "spawn" | "wait" | "signal">;
}

export interface MetadataOptions {
  /** The guest path of `pg-metadata.py`. */
  readonly script: string;
  /** The directories the helper may touch. */
  readonly roots: readonly string[];
  /** How long `close` waits for the helper before it kills it. */
  readonly grace?: () => AbortSignal;
}

export interface MetadataHelper {
  /** Sets a file's times through the helper; blocks until it answers, because PostgreSQL's file system calls cannot wait. */
  readonly utimes: Utimes;
  close(): Promise<void>;
}

const WHO = "The native metadata helper";
const GRACE_MS = 2000;
const SIGKILL = 9;
const encoder = new TextEncoder();

/**
 * Starts the Python helper that sets file times, the one metadata operation the host lacks (phase 1: removed
 * when engine API 144 lands). Requests and replies are one JSON line each, over the child's pipes.
 */
export async function startMetadataHelper(host: MetadataHost, options: MetadataOptions): Promise<MetadataHelper> {
  const child = await host.process.spawn({
    command: PYTHON,
    args: ["-u", options.script, ...options.roots],
    stdio: { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
  });
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) {
    await host.process.signal(child.pid, SIGKILL).catch(() => undefined);
    throw new Error(`${WHO} requires pipes`);
  }
  return {
    utimes(path, atimeMs, mtimeMs) {
      host.fs.writeAll(stdin, encoder.encode(`${JSON.stringify({ op: "utimes", path, atimeMs, mtimeMs })}\n`));
      const reply = decodeReply(readLineSync(host.fs, stdout, WHO), WHO);
      if (!reply.ok) throw new HelperError(reply.error, reply.errno ?? 22);
    },
    async close() {
      host.fs.close(stdin);
      await stopChild(host.process, child.pid, (options.grace ?? (() => AbortSignal.timeout(GRACE_MS)))());
      host.fs.close(stdout);
    },
  };
}
