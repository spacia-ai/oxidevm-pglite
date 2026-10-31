import { toError } from "./errors.ts";

/** The signal's reason as an `Error` (an abort without a reason has a `DOMException`, which is one). */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return toError(reason);
}

/**
 * Waits for a promise, but gives up with the signal's reason as soon as the signal aborts. The promise is not
 * cancelled (a socket read cannot be); it keeps running, its outcome is observed and ignored, and ending the
 * connection that owns it ends it.
 */
export function within<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => undefined);
      reject(abortError(signal));
      return;
    }
    const abort = (): void => { reject(abortError(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => { signal.removeEventListener("abort", abort); }).catch(() => undefined);
  });
}
