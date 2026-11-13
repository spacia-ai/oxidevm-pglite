import type { PGlite } from "@electric-sql/pglite";
import { isRecord } from "./decode.ts";
import type { Kit } from "./ports.ts";

type Gate = ReturnType<Kit["gate"]>;

/** How long an embedded statement waits for a native connection to let go of the database. */
export const SESSION_WAIT_MS = 250;
export const SESSION_BUSY_MESSAGE = "A native PostgreSQL connection is using the database (a running statement or an open transaction). Try again when it is done.";
export const SESSION_WAIT_EXPIRED_MESSAGE = "Database session wait expired before SQL execution";
export const EMBEDDED_TRANSACTION_MESSAGE = "An embedded transaction is active. Commit or roll it back before opening a native session.";

/** Time, so that a test can move it by hand. */
export interface SessionClock {
  now(): number;
  /** A signal that aborts after `ms`. */
  timeout(ms: number): AbortSignal;
}

const SYSTEM_CLOCK: SessionClock = { now: () => Date.now(), timeout: ms => AbortSignal.timeout(ms) };

/** One session setting, as `SET name = value` would make it. */
export type Setting = readonly [name: string, value: string];

/**
 * One client of the shared backend: a native connection, or the JSON endpoint (all its requests are one client).
 * It remembers the session settings the client made, for the turns in which another client has the backend.
 */
export interface Party {
  /** A small number no other open native connection has; it names what the connection owns in the backend. */
  readonly slot: number;
  settings: readonly Setting[];
  open: boolean;
}

/** What the turn-taking needs of PGlite. */
export type SessionDatabase = Pick<PGlite, "runExclusive" | "isInTransaction" | "execProtocolRawStream" | "query" | "exec">;

export interface SharedBackend {
  /** The JSON endpoint's turns, as a gate: every embedded statement is the same client. */
  readonly embedded: Gate;
  /** A new native connection with the settings of its startup packet. It does not wait for the backend. */
  join(settings: readonly Setting[]): Party;
  /**
   * Waits for the backend and makes it this client's: the settings of the client that had it before are
   * remembered and reset, and this client's are put back. Resolves with the release.
   */
  acquire(party: Party, signal: AbortSignal): Promise<() => void>;
  /**
   * The connection is gone. `cleanup` are protocol messages that remove what it left in the backend; they run
   * now when the connection still holds the backend (`held`), otherwise before the next client's turn.
   */
  leave(party: Party, held: (() => void) | undefined, cleanup: readonly Uint8Array[]): Promise<void>;
}

// Settings made with SET (or set_config) for the session. `role` is not listed by pg_settings, so it is read apart, and last: it depends on nothing after it.
const CAPTURE = "SELECT name, setting FROM pg_settings WHERE source = 'session' UNION ALL SELECT 'role', current_setting('role') WHERE current_setting('role') <> 'none'";
const RESET = "SET SESSION AUTHORIZATION DEFAULT; RESET ALL";
const APPLY = "SELECT set_config(item.name, item.value, false) FROM unnest($1::text[], $2::text[]) AS item(name, value)";

function decodeSettings(rows: readonly unknown[]): Setting[] {
  return rows.map((row): Setting => {
    const { name, setting } = isRecord(row) ? row : {};
    if (typeof name !== "string" || typeof setting !== "string") throw new Error("PostgreSQL reported a session setting in an unknown form");
    return [name, setting];
  });
}

/**
 * PGlite has one PostgreSQL backend, and every client shares it by taking turns, the way a transaction-mode
 * connection pooler shares a server connection: a client holds the backend while it has work in flight or a
 * transaction open (the wire handler decides when), and between turns the backend is free for the others.
 *
 * The backend is one PostgreSQL session, so what a session owns is shared unless it is handled here or by the
 * wire handler. Handled here: session settings (`SET`, `search_path`, the startup packet's parameters) are
 * remembered per client and swapped when the backend changes hands, and when the last native connection has
 * gone the backend is restored with `DISCARD ALL`. Swapping costs two or three statements, and only when the
 * backend really changes hands: one client alone never pays it.
 */
export function createSharedBackend(deps: { readonly gate: Gate; readonly db: SessionDatabase }): SharedBackend {
  const { gate, db } = deps;
  const natives = new Set<Party>();
  const embedded: Party = { slot: -1, settings: [], open: true };
  /** Whose settings the backend has now; `undefined` when it has nobody's (as after `DISCARD ALL`). */
  let loaded: Party | undefined;
  let garbage: Uint8Array[] = [];
  let discard = false;

  const capture = async (): Promise<Setting[]> => decodeSettings((await db.query(CAPTURE)).rows);
  const quiet = (bytes: Uint8Array): Promise<void> => db.runExclusive(() => db.execProtocolRawStream(bytes, { syncToFs: true, onRawData: () => undefined }));

  /** Removes what connections that are gone left behind. Runs with the gate held. */
  const sweep = async (): Promise<void> => {
    const messages = garbage;
    garbage = [];
    for (const bytes of messages) await quiet(bytes);
    // An embedded transaction can be open here (the JSON client's own); DISCARD ALL waits until it is over.
    if (!discard || db.isInTransaction()) return;
    if (loaded?.open === true) loaded.settings = await capture();
    await db.exec("DISCARD ALL");
    loaded = undefined;
    discard = false;
  };

  const acquire = async (party: Party, signal: AbortSignal): Promise<() => void> => {
    const release = await gate.acquire(signal);
    try {
      await sweep();
      if (loaded !== party) {
        // Only the JSON client can leave a transaction open between turns; it keeps the backend's state until it ends it.
        if (db.isInTransaction()) throw new Error(EMBEDDED_TRANSACTION_MESSAGE);
        const previous = loaded;
        if (previous?.open === true) previous.settings = await capture();
        if (previous !== undefined) {
          // Until the new settings are in, the backend has nobody's: a failure here must not leave it marked as someone's.
          loaded = { slot: -1, settings: [], open: false };
          await db.exec(RESET);
        }
        if (party.settings.length > 0) {
          loaded = { slot: -1, settings: [], open: false };
          await db.query(APPLY, [party.settings.map(([name]) => name), party.settings.map(([, value]) => value)]);
        }
        loaded = party;
      }
      return release;
    } catch (error: unknown) {
      release();
      throw error;
    }
  };

  return {
    embedded: { acquire: signal => acquire(embedded, signal) },
    join(settings) {
      let slot = 0;
      const taken = new Set([...natives].map(party => party.slot));
      while (taken.has(slot)) slot += 1;
      const party: Party = { slot, settings, open: true };
      natives.add(party);
      return party;
    },
    acquire,
    async leave(party, held, cleanup) {
      party.open = false;
      natives.delete(party);
      garbage.push(...cleanup);
      if (natives.size === 0) discard = true;
      if (held === undefined) return;
      try {
        await sweep();
      } finally {
        held();
      }
    },
  };
}

/**
 * Runs one embedded statement in the JSON client's turn. It waits for a native connection that is in the middle
 * of a statement or a transaction, but only briefly: the caller is told who has the database instead of hanging.
 */
export async function withStatementSession<T>(gate: Gate, signal: AbortSignal, run: () => Promise<T>, clock: SessionClock = SYSTEM_CLOCK): Promise<T> {
  const deadline = clock.now() + SESSION_WAIT_MS;
  const wait = AbortSignal.any([signal, clock.timeout(SESSION_WAIT_MS)]);
  let release: () => void;
  try {
    release = await gate.acquire(wait);
  } catch (error: unknown) {
    if (wait.aborted) throw new Error(SESSION_BUSY_MESSAGE, { cause: error });
    throw error;
  }
  try {
    signal.throwIfAborted();
    if (clock.now() > deadline) throw new Error(SESSION_WAIT_EXPIRED_MESSAGE);
    return await run();
  } finally {
    release();
  }
}
