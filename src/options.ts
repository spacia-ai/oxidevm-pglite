import { OXIDEVM_DIRECTORY } from "./layout.ts";

const WORKSPACE = "/workspace";

/**
 * Checks the `dataDir` option, which the runner only knows as a string: an absolute, normalized path inside the
 * workspace and outside the module's own directory, because the data directory is replaced by one rename.
 */
export function resolveDataDir(value: string): string {
  const refusal = new Error("The dataDir option must be an absolute path inside /workspace, outside /workspace/_oxidevm, without empty, . or .. segments");
  if (!insideWorkspace(value)) throw refusal;
  if (value === OXIDEVM_DIRECTORY || value.startsWith(`${OXIDEVM_DIRECTORY}/`)) throw refusal;
  return value;
}

/** True for an absolute path inside the workspace without empty, `.` or `..` segments. */
function insideWorkspace(value: string): boolean {
  if (!value.startsWith(`${WORKSPACE}/`)) return false;
  const segments = value.slice(WORKSPACE.length + 1).split("/");
  return !segments.some(segment => segment === "" || segment === "." || segment === ".." || segment.includes("\0"));
}

/**
 * The `importArchive` option: the guest path of a PGlite data-directory archive to load when the data directory is
 * created, or `undefined` for none (an empty value). It is an absolute, normalized path inside the workspace and
 * outside the data directory it is loaded into.
 */
export function resolveImportArchive(value: string, dataDir: string): string | undefined {
  if (value === "") return undefined;
  if (!insideWorkspace(value) || value === dataDir || value.startsWith(`${dataDir}/`)) {
    throw new Error("The importArchive option must be empty or an absolute path inside /workspace, outside the data directory, without empty, . or .. segments");
  }
  return value;
}
