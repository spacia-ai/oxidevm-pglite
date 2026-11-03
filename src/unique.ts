/**
 * A random suffix for a temporary or set-aside name: 32 hex digits from `crypto.getRandomValues`. Module code runs
 * in an opaque-origin frame, which Chromium does not treat as a secure context, so `crypto.randomUUID` (secure
 * contexts only) is not there; `getRandomValues` is.
 */
export function uniqueSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
