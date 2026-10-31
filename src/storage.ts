import { PGlite } from "@electric-sql/pglite";
import type { PGliteOptions } from "@electric-sql/pglite";
import { fingerprint } from "./fingerprint.ts";
import { decodeMarker, encodeMarker, MARKER_NAME, MAX_MARKER_BYTES } from "./marker.ts";
import type { Kit, SyncFiles } from "./ports.ts";
import { VMPostgresFS } from "./vm-fs.ts";
import type { VmFiles } from "./vm-fs.ts";

/** The VM file operations opening a database needs. */
export type StorageFiles = VmFiles & Pick<SyncFiles, "readFile" | "writeFile" | "writeAll">;

export interface StorageHost {
  readonly files: StorageFiles;
  readonly kit: Pick<Kit, "errno" | "directory">;
  readonly log: (line: string) => void;
}

/** A database from an earlier version of the application, as a tar archive of its data directory. */
export interface LegacyExport {
  readonly archive: Blob;
  /** The fingerprint of the legacy database, which the copy must reproduce. */
  readonly fingerprint: string;
}

export interface LegacySource {
  /** The legacy database, or `undefined` when there is none. */
  export(): Promise<LegacyExport | undefined>;
}

export interface StorageOptions {
  /** Where the live database is; it appears here only once it is complete and verified. */
  readonly dataDir: string;
  /** Where a database is built before it replaces `dataDir`. */
  readonly stagingDir: string;
  /** Where the archive of a migrated legacy database is kept. */
  readonly backupDir: string;
  /** PGlite's options: the compiled WebAssembly, the file bundle and the durability of the live database. */
  readonly pglite: PGliteOptions;
  readonly legacy?: LegacySource;
}

export interface OpenedDatabase {
  readonly db: PGlite;
  readonly fs: VMPostgresFS;
  /** `created` and `migrated` mean this call built the data directory. */
  readonly origin: "existing" | "created" | "migrated";
}

const MAX_ARCHIVE_BYTES = 256 * 1024 ** 2;
const O_WRONLY = 0o1, O_CREAT = 0o100, O_EXCL = 0o200;
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

async function writeBackup(host: StorageHost, path: string, archive: Blob): Promise<void> {
  const fd = host.files.open(path, O_WRONLY | O_CREAT | O_EXCL, 0o600);
  try {
    const reader = archive.stream().getReader();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      host.files.writeAll(fd, part.value);
    }
    host.files.fsync(fd);
  } finally {
    host.files.close(fd);
  }
}

/**
 * Builds the database in the staging directory: initializes it, or loads the legacy archive into it, checks
 * that the copy reproduces the legacy database, and writes the marker. The staging database is always
 * flushed strictly, whatever the live database's durability is, because it is published by one rename.
 */
async function populate(host: StorageHost, options: StorageOptions, directory: string): Promise<"created" | "migrated"> {
  const exported = await options.legacy?.export();
  let backup: string | null = null;
  if (exported !== undefined) {
    if (exported.archive.size > MAX_ARCHIVE_BYTES) throw new Error("The migration archive exceeds the 256 MiB limit. The IndexedDB database is preserved.");
    backup = `${options.backupDir}/pglite-indexeddb-${crypto.randomUUID()}.tar`;
    await writeBackup(host, backup, exported.archive);
  }
  const staged = await PGlite.create({
    ...options.pglite,
    relaxedDurability: false,
    fs: filesystem(host, directory),
    ...(exported === undefined ? {} : { loadDataDir: exported.archive }),
  });
  let verified: string;
  try {
    verified = await fingerprint(staged);
    if (exported !== undefined && exported.fingerprint !== verified) throw new Error("Database migration verification failed. Original data and backup are preserved.");
  } finally {
    await staged.close();
  }
  const markerPath = `${directory}/${MARKER_NAME}`;
  host.files.writeFile(markerPath, encodeMarker({ version: 1, source: exported === undefined ? "new" : "indexeddb", fingerprint: verified, backup }));
  host.kit.directory.sync(host.files, markerPath, "file");
  if (exported !== undefined) host.log(`migrated the legacy IndexedDB database (${String(exported.archive.size)} bytes) to ${options.dataDir}; its archive is kept at ${backup ?? ""}`);
  return exported === undefined ? "created" : "migrated";
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
    let built: "created" | "migrated" | undefined;
    const result = await host.kit.directory.createAtomically(host.files, {
      destination: options.dataDir,
      staging: options.stagingDir,
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
