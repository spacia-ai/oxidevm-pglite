/** Decoding helpers for values that arrive as `unknown`: from pipes, sockets and files. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the record has every required key, no key beyond the required and optional ones, and no inherited keys. */
export function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(record);
  return required.every(key => Object.hasOwn(record, key)) && keys.every(key => required.includes(key) || optional.includes(key));
}
