import type { KitErrno, SyncFiles } from "./ports.ts";
import { MAX_ARCHIVE_BYTES } from "./storage.ts";
import type { ImportedArchive, ImportSource } from "./storage.ts";

const ENOENT = 2, EFBIG = 27, S_IFMT = 0o170000, S_IFREG = 0o100000;

export interface ArchiveHost {
  readonly files: Pick<SyncFiles, "lstat" | "readFile">;
  readonly errno: KitErrno;
}

/**
 * The `importArchive` file: a tar archive of a PGlite data directory (`PGlite.dumpDataDir("none")`) that a page
 * wrote into the workspace. It is read once, when the data directory is created, and never changed or removed.
 * A missing, non-regular or oversized archive fails the start instead of becoming an empty database.
 */
export function archiveSource(host: ArchiveHost, path: string): ImportSource {
  // The executor's exceptions become the rejection of the promise `load` returns.
  return { load: () => new Promise<ImportedArchive>(resolve => { resolve(readArchive(host, path)); }) };
}

function readArchive(host: ArchiveHost, path: string): ImportedArchive {
  let mode: number;
  try {
    mode = host.files.lstat(path).mode;
  } catch (error: unknown) {
    if (host.errno.of(error) === ENOENT) throw new Error(`The import archive ${path} does not exist. Write it before the first start, or leave importArchive empty for a new database.`, { cause: error });
    throw error;
  }
  if ((mode & S_IFMT) !== S_IFREG) throw new Error(`The import archive ${path} is not a regular file`);
  let read: Uint8Array;
  try {
    read = host.files.readFile(path, MAX_ARCHIVE_BYTES);
  } catch (error: unknown) {
    if (host.errno.of(error) === EFBIG) throw new Error(`The import archive ${path} exceeds the 256 MiB limit`, { cause: error });
    throw error;
  }
  // A Blob takes bytes of an ordinary ArrayBuffer; bytes over shared memory are copied once.
  const bytes = read.buffer instanceof ArrayBuffer ? new Uint8Array(read.buffer, read.byteOffset, read.byteLength) : Uint8Array.from(read);
  return { archive: new Blob([bytes]), path };
}
