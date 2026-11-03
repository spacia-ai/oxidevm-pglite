import type { KitErrno, SyncFiles } from "./ports.ts";
import { MAX_ARCHIVE_BYTES } from "./storage.ts";
import type { ImportedArchive, ImportSource } from "./storage.ts";

const ENOENT = 2, S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000, O_RDONLY = 0;
/** One read of the host returns at most 16 MiB (and `readFile` refuses a larger limit), so a piece is read in steps. */
const READ_BYTES = 4 * 1024 ** 2;
/** At most this many pieces: 256 MiB in pieces of the 16 MiB a page can write with one `vm.workspace.write`. */
export const MAX_ARCHIVE_PIECES = 64;

export interface ArchiveHost {
  readonly files: Pick<SyncFiles, "lstat" | "readdir" | "open" | "read" | "close">;
  readonly errno: KitErrno;
}

/**
 * The `importArchive` source: a tar archive of a PGlite data directory (`PGlite.dumpDataDir`), plain or gzip, that a
 * page wrote into the workspace. It is one file, or a directory whose regular files, in name order, are the
 * consecutive pieces of one archive (a page writes at most 16 MiB per call). It is read once, when the data directory
 * is created, and never changed or removed. A missing, malformed or oversized archive fails the start instead of
 * becoming an empty database.
 */
export function archiveSource(host: ArchiveHost, path: string): ImportSource {
  // The executor's exceptions become the rejection of the promise `load` returns.
  return { load: () => new Promise<ImportedArchive>(resolve => { resolve(readArchive(host, path)); }) };
}

function modeOf(host: ArchiveHost, path: string): number {
  try {
    return host.files.lstat(path).mode & S_IFMT;
  } catch (error: unknown) {
    if (host.errno.of(error) === ENOENT) throw new Error(`The import archive ${path} does not exist. Write it before the first start, or leave importArchive empty for a new database.`, { cause: error });
    throw error;
  }
}

function tooLarge(path: string): Error {
  return new Error(`The import archive ${path} exceeds the 256 MiB limit`);
}

/** Reads one file whole, in steps, failing as soon as it holds more than `remaining` bytes. */
function readPiece(host: ArchiveHost, archive: string, path: string, remaining: number): Uint8Array<ArrayBuffer>[] {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let read = 0;
  const fd = host.files.open(path, O_RDONLY);
  try {
    for (;;) {
      const chunk = host.files.read(fd, Math.min(READ_BYTES, remaining - read + 1));
      if (chunk.length === 0) return chunks;
      read += chunk.length;
      if (read > remaining) throw tooLarge(archive);
      chunks.push(owned(chunk));
    }
  } finally {
    host.files.close(fd);
  }
}

/** The pieces of an archive kept as a directory, in name order; anything but regular files is refused. */
function pieces(host: ArchiveHost, path: string): readonly string[] {
  const names = host.files.readdir(path).map(entry => entry.name).filter(name => name !== "." && name !== "..").sort();
  if (names.length === 0) throw new Error(`The import archive directory ${path} is empty`);
  if (names.length > MAX_ARCHIVE_PIECES) throw new Error(`The import archive directory ${path} has more than ${String(MAX_ARCHIVE_PIECES)} pieces`);
  const files = names.map(name => `${path}/${name}`);
  for (const file of files) if (modeOf(host, file) !== S_IFREG) throw new Error(`The import archive piece ${file} is not a regular file`);
  return files;
}

/** Bytes of an ordinary ArrayBuffer, which a Blob takes; bytes over shared memory are copied once. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Uint8Array.from(bytes);
}

function readArchive(host: ArchiveHost, path: string): ImportedArchive {
  const mode = modeOf(host, path);
  if (mode !== S_IFREG && mode !== S_IFDIR) throw new Error(`The import archive ${path} is neither a regular file nor a directory of pieces`);
  const files = mode === S_IFREG ? [path] : pieces(host, path);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  for (const file of files) {
    for (const part of readPiece(host, path, file, MAX_ARCHIVE_BYTES - total)) {
      total += part.length;
      parts.push(part);
    }
  }
  if (total === 0) throw new Error(`The import archive ${path} is empty`);
  // PGlite decompresses an archive whose type says gzip; dumpDataDir("gzip") and "auto" write gzip.
  const gzip = parts[0]?.[0] === 0x1f && parts[0][1] === 0x8b;
  return { archive: new Blob(parts, gzip ? { type: "application/x-gzip" } : {}), path };
}
