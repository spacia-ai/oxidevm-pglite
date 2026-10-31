import { concat } from "./bytes.ts";
import type { Connection, SyncFiles } from "./ports.ts";
import { within } from "./timing.ts";
import type { ResponseSink } from "./wire.ts";

/** A response is sent in pieces of about this size while PostgreSQL produces it, so that memory stays bounded. */
export const STREAM_THRESHOLD = 1024 ** 2;
export const CLIENT_GONE = "PostgreSQL client stopped receiving data";

export interface ClientSinkPorts {
  readonly connection: Pick<Connection, "fd" | "write">;
  readonly fs: Pick<SyncFiles, "writeAll">;
  /** How much a response may collect before it is sent; defaults to {@link STREAM_THRESHOLD}. */
  readonly threshold?: number;
}

/**
 * Sends PostgreSQL's responses to the client's socket. What PostgreSQL produces while one statement runs is
 * collected and written with the connection's own `write` when the statement is done, which only waits for the
 * client. The two moments when the module cannot wait are written at once and synchronously, with `noSignal`:
 * a large response, which is sent as it grows so that it never fills memory, and the `COPY FROM STDIN` handshake,
 * where PostgreSQL needs the client's data before it can return. A client that has hung up answers either write
 * with EPIPE, which fails that session and nothing else: neither write can end the module.
 */
export function createClientSink(ports: ClientSinkPorts): ResponseSink {
  const threshold = ports.threshold ?? STREAM_THRESHOLD;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const take = (): Uint8Array<ArrayBuffer> => {
    const bytes = concat(pending);
    pending = [];
    pendingBytes = 0;
    return bytes;
  };
  const sendNow = (): void => {
    if (pendingBytes === 0) return;
    const bytes = take();
    try {
      ports.fs.writeAll(ports.connection.fd, bytes, { noSignal: true });
    } catch (error: unknown) {
      throw new Error(CLIENT_GONE, { cause: error });
    }
  };
  return {
    reset() {
      pending = [];
      pendingBytes = 0;
    },
    write(bytes) {
      // PostgreSQL reuses the memory it hands over, so the bytes are copied.
      pending.push(bytes.slice());
      pendingBytes += bytes.length;
      if (pendingBytes >= threshold) sendNow();
    },
    async flush(signal) {
      if (pendingBytes === 0) return;
      const bytes = take();
      try {
        await within(ports.connection.write(bytes), signal);
      } catch (error: unknown) {
        if (signal.aborted) throw error;
        throw new Error(CLIENT_GONE, { cause: error });
      }
    },
    flushSync: sendNow,
  };
}
