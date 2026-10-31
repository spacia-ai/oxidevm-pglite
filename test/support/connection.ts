import { int32, join } from "../../src/bytes.ts";
import type { Connection } from "../../src/ports.ts";
import { toError } from "../../src/errors.ts";
import { descriptor } from "./node-files.ts";

export interface FakeConnection extends Connection {
  /** What the handler wrote, one entry per `write` call. */
  readonly written: Uint8Array[];
  /** The `maxBytes` of every `read` call. */
  readonly reads: number[];
  /** Ends the connection, as the runner does when the module stops. */
  readonly end: AbortController;
  /** Hands the handler more bytes to read. */
  feed(bytes: Uint8Array): void;
  /** A blocking read of the same stream, as the wire handler does while it receives COPY data; empty at the end. */
  readSync(maxBytes: number): Uint8Array;
  /** How many bytes are still queued. */
  readonly pending: () => number;
}

/**
 * A client connection with scripted input. The handler's reads return at most `chunk` bytes of what is queued;
 * when nothing is queued they wait for `feed`, or report the end of the stream when `closed` is true.
 */
export function fakeConnection(input: Uint8Array = new Uint8Array(0), options: { readonly chunk?: number; readonly closed?: boolean } = {}): FakeConnection {
  const end = new AbortController(), written: Uint8Array[] = [], reads: number[] = [];
  let queued = input;
  let waiting: { readonly resolve: () => void } | undefined;
  const connection: FakeConnection = {
    // Far above the descriptors of real files on this machine, which the fake VM must not mistake for the socket.
    fd: descriptor(4_000_040),
    signal: end.signal,
    written,
    reads,
    end,
    feed(bytes) {
      queued = join(queued, bytes);
      waiting?.resolve();
    },
    readSync(maxBytes) {
      reads.push(-maxBytes);
      const size = Math.min(maxBytes, options.chunk ?? maxBytes, queued.length);
      const chunk = queued.subarray(0, size);
      queued = queued.subarray(size);
      return chunk;
    },
    pending: () => queued.length,
    async read(maxBytes) {
      reads.push(maxBytes);
      while (queued.length === 0) {
        if (options.closed === true) return new Uint8Array(0);
        if (end.signal.aborted) throw toError(end.signal.reason);
        await new Promise<void>((resolve, reject) => {
          waiting = { resolve };
          end.signal.addEventListener("abort", () => { reject(toError(end.signal.reason)); }, { once: true });
        });
      }
      const size = Math.min(maxBytes, options.chunk ?? maxBytes, queued.length);
      const chunk = queued.subarray(0, size);
      queued = queued.subarray(size);
      return chunk;
    },
    write(bytes) {
      written.push(Uint8Array.from(bytes));
      return Promise.resolve();
    },
  };
  return connection;
}

/** A length-prefixed message, as the JSON endpoint speaks it. */
export function frame(payload: Uint8Array | string): Uint8Array<ArrayBuffer> {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  return join(int32(bytes.length), bytes);
}

/** The JSON of the single frame the handler wrote. */
export function replyOf(connection: FakeConnection): unknown {
  expectOneWrite(connection);
  const bytes = connection.written[0] ?? new Uint8Array(0);
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length !== bytes.length - 4) throw new Error(`The frame says ${String(length)} bytes but carries ${String(bytes.length - 4)}`);
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(4)));
  return parsed;
}

function expectOneWrite(connection: FakeConnection): void {
  if (connection.written.length !== 1) throw new Error(`Expected one write, saw ${String(connection.written.length)}`);
}
