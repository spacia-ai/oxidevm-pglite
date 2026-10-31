import { OXIDEVM_DIRECTORY } from "./layout.ts";

const WORKSPACE = "/workspace";

/**
 * Checks the `dataDir` option, which the runner only knows as a string: an absolute, normalized path inside the
 * workspace and outside the module's own directory, because the data directory is replaced by one rename.
 */
export function resolveDataDir(value: string): string {
  const refusal = new Error("The dataDir option must be an absolute path inside /workspace, outside /workspace/_oxidevm, without empty, . or .. segments");
  if (!value.startsWith(`${WORKSPACE}/`)) throw refusal;
  const segments = value.slice(WORKSPACE.length + 1).split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === ".." || segment.includes("\0"))) throw refusal;
  if (value === OXIDEVM_DIRECTORY || value.startsWith(`${OXIDEVM_DIRECTORY}/`)) throw refusal;
  return value;
}

/** The `legacyIndexedDb` option: the name of an IndexedDB database to migrate from, or `undefined` for none (an empty name). */
export function resolveLegacyName(value: string): string | undefined {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) throw new Error("The legacyIndexedDb option must not contain control characters");
  }
  return value === "" ? undefined : value;
}
