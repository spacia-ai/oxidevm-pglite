import type { Kit } from "./ports.ts";

type Gate = ReturnType<Kit["gate"]>;

/** How long an embedded statement waits for a native connection to let go of the database. */
export const SESSION_WAIT_MS = 250;
export const SESSION_BUSY_MESSAGE = "A native PostgreSQL connection owns the database. Close it before using oxidevm.query().";
export const SESSION_WAIT_EXPIRED_MESSAGE = "Database session wait expired before SQL execution";

/** Time, so that a test can move it by hand. */
export interface SessionClock {
  now(): number;
  /** A signal that aborts after `ms`. */
  timeout(ms: number): AbortSignal;
}

const SYSTEM_CLOCK: SessionClock = { now: () => Date.now(), timeout: ms => AbortSignal.timeout(ms) };

/**
 * Runs one embedded statement while it holds the database. PGlite has a single backend, so a native
 * connection leases the whole database for its lifetime (see the wire handler) and an embedded statement
 * waits for it, but only briefly: the caller is told who owns the database instead of hanging.
 */
export async function withStatementSession<T>(gate: Gate, signal: AbortSignal, run: () => Promise<T>, clock: SessionClock = SYSTEM_CLOCK): Promise<T> {
  const deadline = clock.now() + SESSION_WAIT_MS;
  let release: () => void;
  try {
    release = await gate.acquire(AbortSignal.any([signal, clock.timeout(SESSION_WAIT_MS)]));
  } catch {
    throw new Error(SESSION_BUSY_MESSAGE);
  }
  try {
    signal.throwIfAborted();
    if (clock.now() > deadline) throw new Error(SESSION_WAIT_EXPIRED_MESSAGE);
    return await run();
  } finally {
    release();
  }
}
