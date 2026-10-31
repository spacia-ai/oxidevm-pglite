import { PYTHON } from "./layout.ts";
import type { AsyncFiles, Descriptor, NativeProcesses, SyncFiles } from "./ports.ts";
import { decodeReply, readLine, readLineSync, stopChild } from "./sidecar.ts";
import type { ResponseSink } from "./wire.ts";

/** The host operations the writer uses. */
export interface WriterHost {
  /** The module's standard output, which the helper borrows for the client's socket while it starts. */
  readonly stdout: Descriptor;
  readonly fs: Pick<SyncFiles, "dup" | "open" | "close" | "writeAll" | "read" | "unlink">;
  readonly files: Pick<AsyncFiles, "writeAll" | "read">;
  readonly process: Pick<NativeProcesses, "spawn" | "wait" | "signal">;
}

export interface WriterOptions {
  /** The guest path of `pg-writer.py`. */
  readonly script: string;
  /** Where the spool files go. */
  readonly spoolDirectory: string;
  /** A unique name for a spool file. */
  readonly uuid?: () => string;
  /** How long `close` waits for the helper before it kills it. */
  readonly grace?: () => AbortSignal;
  readonly maxSpoolBytes?: number;
}

/** A response sink backed by a spool file and a helper process. */
export interface ResponseWriter extends ResponseSink {
  close(): Promise<void>;
}

export interface WriterFactory {
  /** Starts a helper that writes to the client's socket (its descriptor in this process). */
  open(socket: Descriptor): Promise<ResponseWriter>;
}

export const MAX_SPOOL_BYTES = 512 * 1024 ** 2;
const WRITE_PIECE = 65_536;
const GRACE_MS = 2000;
const WHO = "PostgreSQL response writer";
const SEND = new TextEncoder().encode("send\n");
const O_WRONLY = 0o1, O_CREAT = 0o100, O_TRUNC = 0o1000;
const SIGKILL = 9;

type NativeChild = Awaited<ReturnType<NativeProcesses["spawn"]>>;

/**
 * Starts the helper with the client's socket as its standard output. The child inherits descriptor 1, so the
 * module's own standard output is pointed at the socket for the moment of the spawn and put back afterwards.
 */
async function spawnWithSocket(host: WriterHost, options: WriterOptions, socket: Descriptor, spool: string): Promise<NativeChild> {
  let saved: Descriptor | undefined;
  try {
    saved = host.fs.dup(host.stdout);
    host.fs.dup(socket, host.stdout);
    return await host.process.spawn({ command: PYTHON, args: ["-u", options.script, spool], stdio: { stdin: "pipe", stdout: "inherit", stderr: "pipe" } });
  } finally {
    if (saved !== undefined) {
      host.fs.dup(saved, host.stdout);
      host.fs.close(saved);
    }
  }
}

function acknowledged(line: string): void {
  if (!decodeReply(line, WHO).ok) throw new Error("PostgreSQL client stopped receiving data");
}

/**
 * Writes to PostgreSQL clients through helper processes (phase 1: a JavaScript write to a client that has gone
 * ends the process; engine API 144 removes the helpers). Each client gets one helper, started with the client's
 * socket as its standard output; starting them is one at a time because they borrow the module's descriptor 1.
 */
export function createWriterFactory(host: WriterHost, options: WriterOptions): WriterFactory {
  let starting: Promise<undefined> = Promise.resolve(undefined);
  const maxSpool = options.maxSpoolBytes ?? MAX_SPOOL_BYTES;
  return {
    async open(socket) {
      const spool = `${options.spoolDirectory}/pgwire-${(options.uuid ?? (() => crypto.randomUUID()))()}.out`;
      const previous = starting, turn = Promise.withResolvers<undefined>();
      starting = turn.promise;
      await previous;
      let child: NativeChild;
      try {
        child = await spawnWithSocket(host, options, socket, spool);
      } finally {
        turn.resolve(undefined);
      }
      const { stdin, stderr } = child;
      if (stdin === null || stderr === null) {
        await host.process.signal(child.pid, SIGKILL).catch(() => undefined);
        throw new Error("Native PostgreSQL response writer requires pipes");
      }
      return writer(host, options, { child, stdin, answers: stderr, spool, maxSpool });
    },
  };
}

interface Channel { readonly child: NativeChild; readonly stdin: Descriptor; readonly answers: Descriptor; readonly spool: string; readonly maxSpool: number }

function writer(host: WriterHost, options: WriterOptions, channel: Channel): ResponseWriter {
  let output: Descriptor | undefined;
  let size = 0;
  const closeOutput = (): void => {
    if (output === undefined) return;
    host.fs.close(output);
    output = undefined;
  };
  return {
    reset() {
      closeOutput();
      output = host.fs.open(channel.spool, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
      size = 0;
    },
    write(bytes) {
      if (output === undefined) throw new Error("Response spool is closed");
      size += bytes.length;
      if (size > channel.maxSpool) throw new Error("PostgreSQL response exceeds the 512 MiB spool limit");
      for (let offset = 0; offset < bytes.length; offset += WRITE_PIECE) host.fs.writeAll(output, bytes.subarray(offset, offset + WRITE_PIECE));
    },
    async flush(signal) {
      closeOutput();
      await host.files.writeAll(channel.stdin, SEND, { signal });
      acknowledged(await readLine(host.files, channel.answers, WHO, signal));
    },
    flushSync() {
      closeOutput();
      host.fs.writeAll(channel.stdin, SEND);
      acknowledged(readLineSync(host.fs, channel.answers, WHO));
    },
    async close() {
      closeOutput();
      host.fs.close(channel.stdin);
      await stopChild(host.process, channel.child.pid, (options.grace ?? (() => AbortSignal.timeout(GRACE_MS)))());
      host.fs.close(channel.answers);
      try { host.fs.unlink(channel.spool); } catch { /* nothing was spooled, or it is already gone */ }
    },
  };
}
