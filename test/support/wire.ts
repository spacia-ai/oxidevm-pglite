import { int32, join } from "../../src/bytes.ts";
import type { ResponseSink } from "../../src/wire.ts";

const encoder = new TextEncoder(), decoder = new TextDecoder();

/** A frontend message: type byte, length, body. */
export function message(type: string, body: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
  return join(encoder.encode(type), int32(body.length + 4), body);
}

export const cstring = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(`${text}\0`);
export const query = (sql: string): Uint8Array<ArrayBuffer> => message("Q", cstring(sql));
export const terminate = (): Uint8Array<ArrayBuffer> => message("X");
export const int16 = (value: number): Uint8Array<ArrayBuffer> => Uint8Array.of(value >> 8 & 0xff, value & 0xff);

/** The startup packet: length, protocol, parameters, final NUL. */
export function startup(parameters: Readonly<Record<string, string>> = { user: "postgres", database: "postgres" }, protocol = 196_608): Uint8Array<ArrayBuffer> {
  const body = join(int32(protocol), ...Object.entries(parameters).flatMap(([key, value]) => [cstring(key), cstring(value)]), Uint8Array.of(0));
  return join(int32(body.length + 4), body);
}

/** SSLRequest, GSSENCRequest and CancelRequest are startup packets with a request code in place of a protocol. */
export const sslRequest = (): Uint8Array<ArrayBuffer> => join(int32(8), int32(80_877_103));
export const cancelRequest = (): Uint8Array<ArrayBuffer> => join(int32(16), int32(80_877_102), int32(1), int32(2));

export interface Backend { readonly type: string; readonly body: Uint8Array }

/** Splits what PostgreSQL sent into messages. */
export function backendMessages(bytes: Uint8Array): Backend[] {
  const messages: Backend[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
    const length = view.getUint32(1);
    messages.push({ type: String.fromCharCode(bytes[offset] ?? 0), body: bytes.subarray(offset + 5, offset + 1 + length) });
    offset += 1 + length;
  }
  return messages;
}

/** Text of the fields of a DataRow. */
export function dataRow(body: Uint8Array): (string | null)[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const fields: (string | null)[] = [];
  let offset = 2;
  for (let index = 0; index < view.getUint16(0); index += 1) {
    const length = view.getInt32(offset);
    offset += 4;
    if (length < 0) { fields.push(null); continue; }
    fields.push(decoder.decode(body.subarray(offset, offset + length)));
    offset += length;
  }
  return fields;
}

/** The fields of an ErrorResponse, by field code (`S` severity, `C` code, `M` message). */
export function errorFields(body: Uint8Array): Record<string, string> {
  const fields: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const code = String.fromCharCode(body[offset] ?? 0);
    const end = body.indexOf(0, offset + 1);
    fields[code] = decoder.decode(body.subarray(offset + 1, end));
    offset = end + 1;
  }
  return fields;
}

export const commandTag = (body: Uint8Array): string => decoder.decode(body.subarray(0, body.indexOf(0)));

export interface MemorySink extends ResponseSink {
  /** What each flush sent. */
  readonly sent: Uint8Array[];
  /** Every message of every flush, in order. */
  messages(): Backend[];
  /** How many times `flushSync` ran. */
  syncFlushes: number;
  /** Runs before every blocking flush: lets a test look at the world while PostgreSQL waits for COPY data. */
  onFlushSync: (() => void) | undefined;
  failFlush: Error | undefined;
  /** Resolves once at least `count` flushes have happened. */
  flushed(count: number): Promise<void>;
}

/** A response sink that keeps what was sent, standing in for the helper process that writes to the socket. */
export function memorySink(): MemorySink {
  let pending: Uint8Array[] = [];
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  const notify = (): void => {
    for (const waiter of waiters.splice(0)) {
      if (sink.sent.length >= waiter.count) waiter.resolve();
      else waiters.push(waiter);
    }
  };
  const sink: MemorySink = {
    flushed: count => {
      if (sink.sent.length >= count) return Promise.resolve();
      return new Promise<void>(resolve => { waiters.push({ count, resolve }); });
    },
    sent: [],
    syncFlushes: 0,
    onFlushSync: undefined,
    failFlush: undefined,
    messages: () => backendMessages(join(...sink.sent)),
    reset: () => { pending = []; },
    write: bytes => { pending.push(Uint8Array.from(bytes)); },
    flush: () => {
      if (sink.failFlush !== undefined) return Promise.reject(sink.failFlush);
      sink.sent.push(join(...pending));
      pending = [];
      notify();
      return Promise.resolve();
    },
    flushSync: () => {
      sink.syncFlushes += 1;
      if (sink.failFlush !== undefined) throw sink.failFlush;
      sink.sent.push(join(...pending));
      pending = [];
      notify();
      sink.onFlushSync?.();
    },
  };
  return sink;
}
