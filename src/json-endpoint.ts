import { number32 } from "./bytes.ts";
import { exactKeys, isRecord } from "./decode.ts";
import { errorText } from "./errors.ts";
import type { Connection, Kit } from "./ports.ts";
import { withStatementSession } from "./session.ts";
import type { SessionClock } from "./session.ts";
import { isCopyCommand } from "./sql-text.ts";
import { within } from "./timing.ts";

type Gate = ReturnType<Kit["gate"]>;
type Framing = Pick<Kit["framing"], "readExactly" | "writeFrame">;
type FrameSource = Parameters<Framing["readExactly"]>[0];

/** The limits of the `oxidevm-sql/1` protocol. */
export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_REPLY_BYTES = 1024 * 1024;
export const MAX_PARAMS = 1024;
/** One request, from the first byte to the last byte of the reply. */
export const DEADLINE_MS = 30_000;
export const BACKEND = "pglite-wasm";

export const COPY_UNAVAILABLE = "COPY is unavailable through this experimental SQL bridge";
const INVALID_REQUEST = "Invalid database request";
const REQUEST_TOO_LARGE = "Database request exceeds 64 KiB";
const REPLY_TOO_LARGE = "Database response exceeds 1 MiB. Use LIMIT or select fewer columns.";

/** What the endpoint needs of the database: one statement with parameters, answered with PGlite's result object. */
export interface SqlDatabase {
  query(sql: string, params: unknown[]): Promise<Readonly<Record<string, unknown>>>;
}

export interface JsonEndpointDeps {
  readonly database: SqlDatabase;
  readonly gate: Gate;
  /** The service's process id, reported in every result. */
  readonly pid: number;
  readonly framing: Framing;
  /** The signal that ends a request; defaults to 30 seconds. */
  readonly deadline?: () => AbortSignal;
  readonly session?: SessionClock;
}

interface Request { readonly sql: string; readonly params: unknown[] }

function decodeRequest(body: Uint8Array): Request {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!isRecord(parsed) || !exactKeys(parsed, ["sql", "params"])) throw new Error(INVALID_REQUEST);
  const { sql, params } = parsed;
  if (typeof sql !== "string" || !Array.isArray(params) || params.length > MAX_PARAMS) throw new Error(INVALID_REQUEST);
  return { sql, params: Array.from<unknown>(params) };
}

function encodeReply(reply: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify(reply, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
}

async function readRequest(source: FrameSource, signal: AbortSignal, framing: Framing): Promise<Request> {
  const length = number32(await within(framing.readExactly(source, 4), signal));
  if (length > MAX_REQUEST_BYTES) throw new Error(REQUEST_TOO_LARGE);
  return decodeRequest(await within(framing.readExactly(source, length), signal));
}

/**
 * The handler of the `oxidevm-sql/1` endpoint: one request per connection, a length-prefixed JSON object
 * `{ sql, params }`, answered by a length-prefixed `{ ok: true, result }` or `{ ok: false, error }`. A client
 * that goes away before it has sent a whole request gets no reply (there is nobody to read it). A client that
 * goes away before it has read its reply makes that one write fail with EPIPE, which the runner reports for
 * this connection only. A request that outlives its deadline or the module gets no reply either: the handler
 * fails and the runner closes the connection.
 */
export function jsonEndpoint(deps: JsonEndpointDeps): (connection: Connection) => Promise<void> {
  return async connection => {
    const signal = AbortSignal.any([connection.signal, (deps.deadline ?? (() => AbortSignal.timeout(DEADLINE_MS)))()]);
    const peer = { ended: false };
    const source: FrameSource = {
      read: async maxBytes => {
        const chunk = await connection.read(maxBytes);
        if (chunk.length === 0) peer.ended = true;
        return chunk;
      },
    };
    let reply: unknown;
    try {
      const request = await readRequest(source, signal, deps.framing);
      if (isCopyCommand(request.sql)) throw new Error(COPY_UNAVAILABLE);
      const result = await withStatementSession(deps.gate, signal, () => deps.database.query(request.sql, request.params), deps.session);
      reply = { ok: true, result: { ...result, pid: deps.pid, backend: BACKEND } };
    } catch (error: unknown) {
      if (peer.ended) return;
      reply = { ok: false, error: errorText(error) };
    }
    signal.throwIfAborted();
    let bytes = encodeReply(reply);
    if (bytes.length > MAX_REPLY_BYTES) bytes = encodeReply({ ok: false, error: REPLY_TOO_LARGE });
    await deps.framing.writeFrame(connection, bytes, MAX_REPLY_BYTES);
  };
}
