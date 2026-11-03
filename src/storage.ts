import { PGlite } from "@electric-sql/pglite";
import type { PGliteOptions } from "@electric-sql/pglite";
import { fingerprint } from "./fingerprint.ts";
import { decodeMarker, encodeMarker, MARKER_NAME, MAX_MARKER_BYTES } from "./marker.ts";
import type { Kit, SyncFiles } from "./ports.ts";
import { uniqueSuffix } from "./unique.ts";
import { VMPostgresFS } from "./vm-fs.ts";
import type { VmFiles } from "./vm-fs.ts";

/** The VM file operations opening a database needs. */
export type StorageFiles = VmFiles & Pick<SyncFiles, "readFile" | "writeFile">;

export interface StorageHost {
  readonly files: StorageFiles;
  readonly kit: Pick<Kit, "errno" | "directory">;
  readonly log: (line: string) => void;
}

/** A database to start from: a tar archive of a PGlite data directory (`dumpDataDir`), from a file of the VM. */
export interface ImportedArchive {
  readonly archive: Blob;
  /** The guest path of the archive; it is kept, and the marker names it. */
  readonly path: string;
}

export interface ImportSource {
  /** Reads the archive; it fails rather than letting a missing or oversized archive become an empty database. */
  load(): Promise<ImportedArchive>;
}

export interface StorageOptions {
  /** Where the live database is; it appears here only once it is complete and verified. */
  readonly dataDir: string;
  /** Where a database is built before it replaces `dataDir`. */
  readonly stagingDir: string;
  /** PGlite's options: the compiled WebAssembly, the file bundle and the durability of the live database. */
  readonly pglite: PGliteOptions;
  /** The archive a new data directory is loaded from; without it, a new data directory is initialized empty. */
  readonly source?: ImportSource;
}

export interface OpenedDatabase {
  readonly db: PGlite;
  readonly fs: VMPostgresFS;
  /** `created` and `imported` mean this call built the data directory. */
  readonly origin: "existing" | "created" | "imported";
}

/** The largest archive a new data directory is loaded from. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 ** 2;
const ENOENT = 2;

function exists(host: StorageHost, path: string): boolean {
  try {
    host.files.lstat(path);
    return true;
  } catch (error: unknown) {
    if (host.kit.errno.of(error) === ENOENT) return false;
    throw error;
  }
}

function filesystem(host: StorageHost, root: string): VMPostgresFS {
  return new VMPostgresFS(root, { files: host.files, errno: host.kit.errno, directory: host.kit.directory, log: host.log });
}

/** Creates the directories above the data directory, flushing each new entry into its parent. */
function ensureParents(host: StorageHost, dataDir: string): void {
  const parts = dataDir.split("/").filter(part => part !== "");
  parts.pop();
  let current = "";
  for (const part of parts) {
    const parent = current === "" ? "/" : current;
    current += `/${part}`;
    if (exists(host, current)) continue;
    host.files.mkdir(current, 0o755);
    host.kit.directory.sync(host.files, parent, "directory");
  }
}

/**
 * Builds the database in the staging directory: initializes it, or loads the archive into it, fingerprints it and
 * writes the marker. The staging database is always flushed strictly, whatever the live database's durability
 * is, because it is published by one rename.
 */
async function populate(host: StorageHost, options: StorageOptions, directory: string): Promise<"created" | "imported"> {
  const imported = await options.source?.load();
  const staged = await PGlite.create({
    ...options.pglite,
    relaxedDurability: false,
    fs: filesystem(host, directory),
    ...(imported === undefined ? {} : { loadDataDir: imported.archive }),
  });
  let verified: string;
  try {
    verified = await fingerprint(staged);
  } finally {
    await staged.close();
  }
  const markerPath = `${directory}/${MARKER_NAME}`;
  host.files.writeFile(markerPath, encodeMarker({ version: 1, source: imported === undefined ? "new" : "archive", fingerprint: verified, backup: imported?.path ?? null }));
  host.kit.directory.sync(host.files, markerPath, "file");
  if (imported !== undefined) host.log(`imported ${imported.path} (${String(imported.archive.size)} bytes) into ${options.dataDir}; the archive is kept`);
  return imported === undefined ? "created" : "imported";
}

/** Refuses a data directory this module did not create and verify. */
function verifyMarker(host: StorageHost, dataDir: string): void {
  const marker = `${dataDir}/${MARKER_NAME}`;
  if (!exists(host, marker) || !exists(host, `${dataDir}/PG_VERSION`)) {
    throw new Error(`Existing ${dataDir} has no verified migration marker. Preserve it and inspect it before starting PostgreSQL.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = host.files.readFile(marker, MAX_MARKER_BYTES);
  } catch {
    throw new Error("Unreadable VM PostgreSQL storage marker");
  }
  decodeMarker(bytes);
}

/**
 * Opens PGlite on the live files of the VM. A missing data directory is built next to its destination and
 * renamed into place once complete, so a crash leaves either nothing or a whole, verified database; one
 * that exists must carry the marker this module writes.
 */
export async function openDatabase(host: StorageHost, options: StorageOptions): Promise<OpenedDatabase> {
  let origin: OpenedDatabase["origin"] = "existing";
  if (!exists(host, options.dataDir)) {
    ensureParents(host, options.dataDir);
    let built: "created" | "imported" | undefined;
    const result = await host.kit.directory.createAtomically(host.files, {
      destination: options.dataDir,
      staging: options.stagingDir,
      unique: uniqueSuffix,
      populate: async directory => { built = await populate(host, options, directory); },
    });
    if (result === "created" && built !== undefined) origin = built;
    if (origin === "created") host.log(`created a new PostgreSQL database in ${options.dataDir}`);
  }
  verifyMarker(host, options.dataDir);
  const fs = filesystem(host, options.dataDir);
  const db = await PGlite.create({ ...options.pglite, fs });
  return { db, fs, origin };
}
