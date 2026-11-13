import type { PGlite } from "@electric-sql/pglite";
import { int32, join, number32 } from "./bytes.ts";
import { errorText } from "./errors.ts";
import type { Kit } from "./ports.ts";
import type { Setting, SharedBackend } from "./session.ts";
import { scopeStatementName } from "./statement-names.ts";
import { within } from "./timing.ts";
import { VMPostgresFS } from "./vm-fs.ts";

type FrameSource = Parameters<Kit["framing"]["readExactly"]>[0];

/** What the wire handler needs of PGlite. */
export type WireDatabase = Pick<PGlite, "runExclusive" | "isInTransaction" | "execProtocolRawStream" | "fs">;

/**
 * Where a session's responses go: collected while a statement runs, and sent when it is done, or earlier when the
 * session cannot wait (see `createClientSink`).
 */
export interface ResponseSink {
  /** Starts a new response, dropping what was collected and not sent. */
  reset(): void;
  write(bytes: Uint8Array): void;
  /** Sends what was collected; resolves once the client has taken it, rejects when it stopped receiving. */
  flush(signal: AbortSignal): Promise<void>;
  /** The same, blocking: used while PostgreSQL waits for the client's COPY data. */
  flushSync(): void;
}

/** One native client connection. */
export interface WireConnection {
  readonly signal: AbortSignal;
  read(maxBytes: number): Promise<Uint8Array>;
  /** A blocking read of the same stream, for COPY data, which PostgreSQL needs before it can return to the event loop. */
  readSync(maxBytes: number): Uint8Array;
}

export interface WireSessionDeps {
  readonly db: WireDatabase;
  /** `server_version`, as PostgreSQL reports it. */
  readonly version: string;
  /** The turns on the one backend, shared with every other connection and the JSON endpoint. */
  readonly backend: SharedBackend;
  readonly sink: ResponseSink;
  readonly readExactly: Kit["framing"]["readExactly"];
  /** A signal that ends one wait for the client; defaults to 300 seconds. */
  readonly idle?: () => AbortSignal;
}

const IDLE_MS = 300_000;
const MAX_FRONTEND_BYTES = 16 * 1024 ** 2;
const MAX_COPY_EXCHANGE_BYTES = 64 * 1024 ** 2;
const SSL_REQUEST = 80_877_103, GSSENC_REQUEST = 80_877_104, CANCEL_REQUEST = 80_877_102, PROTOCOL_3_0 = 196_608;
/** Frontend message types after startup: Query, Parse, Bind, Describe, Execute, Close, Sync, Flush, FunctionCall. */
const SESSION_MESSAGES: readonly number[] = [81, 80, 66, 68, 69, 67, 83, 72, 70];
/** Frontend messages that can arrive during COPY IN: CopyData, CopyDone, CopyFail, Flush, Sync. */
const COPY_MESSAGES: readonly number[] = [100, 99, 102, 72, 83];
const TERMINATE = 88, COPY_IN_RESPONSE = 71, COPY_DONE = 99, COPY_FAIL = 102;
const PARSE = 80, READY_FOR_QUERY = 90, IDLE = 73;
/** Startup parameters that are not session settings; `client_encoding` is not one here because the server always answers in UTF8. */
const NOT_SETTINGS: readonly string[] = ["user", "database", "replication", "options", "client_encoding"];
export const BACKEND_WAIT_MESSAGE = "Another connection kept the database busy for the whole wait (a running statement or an open transaction)";
const READ_CHUNK = 65_536;
const encoder = new TextEncoder();

export function packet(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  return join(encoder.encode(type), int32(data.length + 4), data);
}

export function simpleQuery(sql: string): Uint8Array<ArrayBuffer> {
  return packet("Q", encoder.encode(`${sql}\0`));
}

/** The input PGlite reads: a view that grows when COPY data arrives, because PGlite holds the length-tracking view. */
class GrowableInput {
  readonly #buffer: ArrayBuffer;
  readonly view: Uint8Array<ArrayBuffer>;

  constructor(first: Uint8Array) {
    this.#buffer = new ArrayBuffer(first.length, { maxByteLength: MAX_COPY_EXCHANGE_BYTES + 4096 });
    this.view = new Uint8Array(this.#buffer);
    this.view.set(first);
  }

  get size(): number {
    return this.#buffer.byteLength;
  }

  append(data: Uint8Array): void {
    const offset = this.#buffer.byteLength;
    this.#buffer.resize(offset + data.length);
    new Uint8Array(this.#buffer).set(data, offset);
  }
}

/** Splits PostgreSQL's output, which arrives in arbitrary chunks, into messages, to learn when a COPY IN handshake is complete. */
class BackendFramer {
  readonly #header = new Uint8Array(5);
  #headerSize = 0;
  #remaining = 0;

  get truncated(): boolean {
    return this.#headerSize !== 0 || this.#remaining !== 0;
  }

  /** Passes the chunk on in pieces that never straddle a message, and calls `completed` with the type of every message that ends. */
  push(chunk: Uint8Array, emit: (part: Uint8Array) => void, completed: (type: number) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#remaining === 0) {
        const take = Math.min(5 - this.#headerSize, chunk.length - offset);
        this.#header.set(chunk.subarray(offset, offset + take), this.#headerSize);
        this.#headerSize += take;
        offset += take;
        if (this.#headerSize < 5) continue;
        this.#remaining = number32(this.#header.subarray(1)) - 4;
        if (this.#remaining < 0) throw new Error("Invalid backend message length");
        emit(this.#header);
        this.#headerSize = 0;
      }
      const take = Math.min(this.#remaining, chunk.length - offset);
      emit(chunk.subarray(offset, offset + take));
      this.#remaining -= take;
      offset += take;
      if (this.#remaining === 0) completed(this.#header[0] ?? 0);
    }
  }
}

/** Reads exactly `size` bytes with blocking reads, as COPY data must be read. */
function readBlocking(connection: WireConnection, size: number): Uint8Array<ArrayBuffer> {
  if (size < 0 || size > MAX_FRONTEND_BYTES) throw new Error("COPY packet exceeds 16 MiB");
  const bytes = new Uint8Array(size);
  let offset = 0;
  while (offset < size) {
    const part = connection.readSync(Math.min(size - offset, READ_CHUNK));
    if (part.length === 0) throw new Error("Client disconnected during COPY");
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/**
 * PostgreSQL has asked the client for COPY data. Answers what is pending, then reads the client's COPY messages
 * until CopyDone or CopyFail and appends them to the input PostgreSQL is reading.
 */
function receiveCopy(db: WireDatabase, sink: ResponseSink, connection: WireConnection, input: GrowableInput): void {
  if (!(db.fs instanceof VMPostgresFS)) throw new Error("COPY requires the VM filesystem adapter");
  db.fs.flushSync();
  sink.flushSync();
  sink.reset();
  for (;;) {
    const type = readBlocking(connection, 1)[0] ?? 0;
    const size = number32(readBlocking(connection, 4)) - 4;
    if (!COPY_MESSAGES.includes(type) || size < 0 || size > MAX_FRONTEND_BYTES) throw new Error("Invalid COPY frontend message");
    const body = readBlocking(connection, size);
    if (([COPY_DONE, 72, 83].includes(type) && size !== 0) || (type === COPY_FAIL && body.at(-1) !== 0)) throw new Error("Invalid COPY message body");
    const data = packet(String.fromCharCode(type), body);
    if (input.size + data.length > MAX_COPY_EXCHANGE_BYTES) throw new Error("COPY exchange exceeds 64 MiB");
    input.append(data);
    if (type === COPY_DONE || type === COPY_FAIL) return;
  }
}

/**
 * Runs one frontend message in PostgreSQL and collects its response, taking COPY IN data from the client when
 * asked. Resolves with whether PostgreSQL ended idle: the response's last message is ReadyForQuery outside a
 * transaction, so nothing of this connection is in flight and another connection may have the backend.
 */
async function execute(deps: WireSessionDeps, connection: WireConnection, bytes: Uint8Array): Promise<boolean> {
  const { db, sink } = deps;
  sink.reset();
  const input = new GrowableInput(bytes), framer = new BackendFramer();
  let failure: unknown, lastByte = 0, idle = false;
  const fail = (error: unknown): void => { failure ??= error; };
  const emit = (part: Uint8Array): void => {
    lastByte = part.at(-1) ?? lastByte;
    if (failure !== undefined) return;
    try { sink.write(part); } catch (error: unknown) { fail(error); }
  };
  await db.runExclusive(() => db.execProtocolRawStream(input.view, {
    syncToFs: true,
    onRawData: chunk => {
      // Nothing thrown here may reach PostgreSQL: it runs inside the WebAssembly call. A COPY handshake is
      // complete when its response message ends; the client's data is read and appended before PostgreSQL resumes.
      try {
        framer.push(chunk, emit, type => {
          idle = type === READY_FOR_QUERY && lastByte === IDLE;
          if (type !== COPY_IN_RESPONSE) return;
          try {
            receiveCopy(db, sink, connection, input);
          } catch (error: unknown) {
            fail(error);
            input.append(packet("f", encoder.encode("COPY interrupted by client or resource limit\0")));
          }
        });
      } catch (error: unknown) {
        fail(error);
      }
    },
  }));
  if (failure !== undefined) throw (failure instanceof Error ? failure : new Error(errorText(failure)));
  if (framer.truncated) throw new Error("Truncated PostgreSQL backend response");
  return idle;
}

/** The settings in the value of the startup parameter `options`: `-c name=value` and `--name=value`, a backslash keeps the next character. */
function optionSettings(options: string): Setting[] {
  const words: string[] = [];
  let word = "", started = false;
  for (let index = 0; index < options.length; index += 1) {
    const char = options.charAt(index);
    if (char === " " || char === "\t" || char === "\n") {
      if (started) words.push(word);
      word = "";
      started = false;
      continue;
    }
    if (char === "\\") index += 1;
    word += options.charAt(index);
    started = true;
  }
  if (started) words.push(word);
  const settings: Setting[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const current = words[index] ?? "";
    let assignment: string;
    if (current === "-c") { index += 1; assignment = words[index] ?? ""; }
    else if (current.startsWith("-c")) assignment = current.slice(2);
    else if (current.startsWith("--")) assignment = current.slice(2);
    else throw new Error("Only -c name=value and --name=value are supported in the options startup parameter");
    const equals = assignment.indexOf("=");
    if (equals <= 0) throw new Error("Only -c name=value and --name=value are supported in the options startup parameter");
    // As PostgreSQL does for `--name`: a dash in the name stands for an underscore.
    const name = assignment.slice(0, equals);
    settings.push([current.startsWith("--") ? name.replaceAll("-", "_") : name, assignment.slice(equals + 1)]);
  }
  return settings;
}

/**
 * Accepts a startup packet that asks for protocol 3.0 and the one user and database there are. Resolves with the
 * session settings it carries (`search_path`, `application_name`, anything `options` sets), which belong to this
 * connection alone.
 */
function validateStartup(startup: Uint8Array): Setting[] {
  if (startup.length < 5 || number32(startup) !== PROTOCOL_3_0) throw new Error("Only PostgreSQL protocol 3.0 is supported");
  const settings = new TextDecoder().decode(startup.subarray(4)).split("\0"), parameters = new Map<string, string>();
  for (let index = 0; index + 1 < settings.length && settings[index] !== ""; index += 2) parameters.set(settings[index] ?? "", settings[index + 1] ?? "");
  if (parameters.get("user") !== "postgres" || ![undefined, "postgres"].includes(parameters.get("database"))) throw new Error("Connect as postgres to database postgres");
  return [
    ...optionSettings(parameters.get("options") ?? ""),
    ...[...parameters].filter(([name]) => !NOT_SETTINGS.includes(name) && !name.startsWith("_pq_.")),
  ];
}

function greeting(version: string): Uint8Array<ArrayBuffer> {
  const statuses = Object.entries({ server_version: version, server_encoding: "UTF8", client_encoding: "UTF8", DateStyle: "ISO, MDY", integer_datetimes: "on", standard_conforming_strings: "on" })
    .map(([key, value]) => packet("S", encoder.encode(`${key}\0${value}\0`)));
  return join(packet("R", int32(0)), ...statuses, packet("Z", encoder.encode("I")));
}

/** An ErrorResponse that ends the connection, for a failure that is not PostgreSQL's own. */
function fatal(code: string, text: string): Uint8Array<ArrayBuffer> {
  return packet("E", encoder.encode(`SFATAL\0VFATAL\0C${code}\0M${text}\0\0`));
}

const closeStatement = (name: Uint8Array): Uint8Array<ArrayBuffer> => packet("C", join(encoder.encode("S"), name, Uint8Array.of(0)));
const SYNC = packet("S", new Uint8Array());

/**
 * One native PostgreSQL client (`postgres-3.0`): startup, then simple and extended queries, COPY in both
 * directions, until the client terminates. PGlite has a single backend, which the connections share by taking
 * turns (see `createSharedBackend`). A connection takes the backend when a message arrives and keeps it until
 * PostgreSQL is idle again: through a transaction (`BEGIN` to `COMMIT` or `ROLLBACK`), through an extended-protocol
 * exchange up to its `Sync`, and through a `COPY`, which is one message's work. While it waits for its client
 * outside those, it holds nothing, so any number of connections can be open and idle at once.
 *
 * Its prepared statements have names of their own (see `scopeStatementName`) and are closed when it goes; an open
 * transaction is rolled back.
 */
export async function wireSession(connection: WireConnection, deps: WireSessionDeps): Promise<void> {
  const { db, sink, backend } = deps;
  const signal = (): AbortSignal => AbortSignal.any([connection.signal, (deps.idle ?? (() => AbortSignal.timeout(IDLE_MS)))()]);
  const source: FrameSource = { read: maxBytes => connection.read(maxBytes) };
  const read = (size: number): Promise<Uint8Array<ArrayBuffer>> => {
    if (!Number.isInteger(size) || size < 0 || size > MAX_FRONTEND_BYTES) return Promise.reject(new Error("Database message exceeds its size limit"));
    return within(deps.readExactly(source, size), signal());
  };
  const readPacket = async (): Promise<Uint8Array<ArrayBuffer>> => read(number32(await read(4)) - 4);
  const send = (bytes: Uint8Array): Promise<void> => { sink.reset(); sink.write(bytes); return sink.flush(signal()); };
  const quiet = (bytes: Uint8Array): Promise<void> => db.runExclusive(() => db.execProtocolRawStream(bytes, { syncToFs: false, onRawData: () => undefined }));

  let startup = await readPacket();
  while (startup.length === 4 && [SSL_REQUEST, GSSENC_REQUEST].includes(number32(startup))) {
    await send(encoder.encode("N"));
    startup = await readPacket();
  }
  if (startup.length === 12 && number32(startup) === CANCEL_REQUEST) return; // PGlite has no independent backend process to signal.
  const party = backend.join(validateStartup(startup));
  const prefix = encoder.encode(`${String(party.slot)}~`);
  /** The statements this connection has prepared and not closed, by their scoped names. */
  const statements = new Map<string, Uint8Array>();
  let held: (() => void) | undefined;

  /** Waits for the backend. A connection that cannot have it is told why, as a fatal error, before it is closed. */
  const take = async (): Promise<() => void> => {
    const wait = signal();
    try {
      return await backend.acquire(party, wait);
    } catch (error: unknown) {
      const refusal = wait.aborted && !connection.signal.aborted ? new Error(BACKEND_WAIT_MESSAGE, { cause: error }) : error;
      if (!connection.signal.aborted) await send(fatal(wait.aborted ? "55P03" : "55000", errorText(refusal))).catch(() => undefined);
      throw refusal;
    }
  };

  try {
    await send(greeting(deps.version));
    for (;;) {
      const type = (await read(1))[0] ?? 0, length = number32(await read(4));
      if (length < 4) throw new Error("Invalid PostgreSQL packet length");
      const scoped = scopeStatementName(type, await read(length - 4), prefix);
      const frontend = packet(String.fromCharCode(type), scoped.body);
      if (type === TERMINATE) {
        if (frontend.length !== 5) throw new Error("Invalid Terminate message");
        return;
      }
      if (!SESSION_MESSAGES.includes(type)) throw new Error("Unsupported PostgreSQL frontend message");
      held ??= await take();
      // A new unnamed statement replaces the one before it; under its scoped name PostgreSQL would refuse the second.
      if (type === PARSE && scoped.unnamed === true && statements.has(prefix.toString())) await quiet(closeStatement(prefix));
      if (scoped.defines !== undefined) statements.set(scoped.defines.toString(), scoped.defines);
      if (scoped.removes !== undefined) statements.delete(scoped.removes.toString());
      if (await execute(deps, connection, frontend)) {
        // The response is this connection's alone, so the backend is free while the client takes it.
        held();
        held = undefined;
      }
      await sink.flush(signal());
    }
  } finally {
    // What a client that left in the middle had in flight: an unfinished extended-protocol exchange, an open transaction.
    const unfinished = held === undefined ? [] : [SYNC, simpleQuery("ROLLBACK")];
    const closes = statements.size === 0 ? [] : [join(...[...statements.values()].map(closeStatement), SYNC)];
    await backend.leave(party, held, [...unfinished, ...closes]);
  }
}
