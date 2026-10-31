import { exactKeys, isRecord } from "./decode.ts";
import type { AsyncFiles, Descriptor, NativeProcesses, SyncFiles } from "./ports.ts";

/** A helper process's replies are single JSON lines; one longer than this is a protocol failure. */
export const MAX_REPLY_BYTES = 8192;
const READ_CHUNK = 4096;
const SIGKILL = 9;

/** What the helpers report back: success, or a failure with the Linux errno of the failed operation when there is one. */
export type HelperReply =
  | { readonly ok: true }
  | { readonly ok: false; readonly errno: number | undefined; readonly error: string };

/** Reads one reply line from a helper's pipe, blocking: PostgreSQL's file system calls cannot wait. */
export function readLineSync(files: Pick<SyncFiles, "read">, fd: Descriptor, who: string): string {
  const decoder = new TextDecoder();
  let line = "";
  while (!line.endsWith("\n")) {
    const bytes = files.read(fd, READ_CHUNK);
    if (bytes.length === 0) throw new Error(`${who} exited`);
    line += decoder.decode(bytes, { stream: true });
    if (line.length > MAX_REPLY_BYTES) throw new Error(`${who} reply exceeds its limit`);
  }
  return line;
}

/** Reads one reply line from a helper's pipe without blocking the event loop. */
export async function readLine(files: Pick<AsyncFiles, "read">, fd: Descriptor, who: string, signal: AbortSignal): Promise<string> {
  const decoder = new TextDecoder();
  let line = "";
  while (!line.endsWith("\n")) {
    const bytes = await files.read(fd, READ_CHUNK, { signal });
    if (bytes.length === 0) throw new Error(`${who} exited`);
    line += decoder.decode(bytes, { stream: true });
    if (line.length > MAX_REPLY_BYTES) throw new Error(`${who} reply exceeds its limit`);
  }
  return line;
}

/** Decodes a reply line from `unknown`: exactly `ok`, plus `errno` and `error` on a failure. */
export function decodeReply(line: string, who: string): HelperReply {
  const invalid = new Error(`${who} sent an invalid reply`);
  let parsed: unknown;
  try { parsed = JSON.parse(line); } catch { throw invalid; }
  if (!isRecord(parsed) || !exactKeys(parsed, ["ok"], ["errno", "error"]) || typeof parsed["ok"] !== "boolean") throw invalid;
  if (parsed["ok"]) {
    if (Object.keys(parsed).length !== 1) throw invalid;
    return { ok: true };
  }
  const { errno, error } = parsed;
  if (errno !== undefined && (typeof errno !== "number" || !Number.isInteger(errno))) throw invalid;
  if (error !== undefined && typeof error !== "string") throw invalid;
  return { ok: false, errno: errno ?? undefined, error: error ?? `${who} reported a failure` };
}

type ProcessId = Parameters<NativeProcesses["wait"]>[0];

/**
 * Waits for a helper whose pipes are closed to exit. A helper that has not exited when `grace` aborts is
 * killed, so that stopping the module never waits for a stuck child.
 */
export async function stopChild(processes: Pick<NativeProcesses, "wait" | "signal">, pid: ProcessId, grace: AbortSignal): Promise<void> {
  try {
    await processes.wait(pid, { signal: grace });
  } catch {
    await processes.signal(pid, SIGKILL).catch(() => undefined);
    await processes.wait(pid).catch(() => undefined);
  }
}
