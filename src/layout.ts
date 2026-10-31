/** Where the module puts its files and what it expects of the image; the manifest literal in module.ts repeats the values it declares. */

/** The directory the module owns inside the workspace: sockets, helper scripts, spool files, staging. */
export const OXIDEVM_DIRECTORY = "/workspace/_oxidevm";
/** The Linux program that runs the two helper scripts and the client. */
export const PYTHON = "/usr/bin/python3";
/** The JSON endpoint's Unix socket. */
export const SQL_SOCKET = `${OXIDEVM_DIRECTORY}/pglite.sock`;
/** Where a database that is being created or migrated is built before it replaces the data directory. */
export const STAGING_DIRECTORY = `${OXIDEVM_DIRECTORY}/pgdata-migrating`;

export const METADATA_SCRIPT = `${OXIDEVM_DIRECTORY}/pg-metadata.py`;
export const WRITER_SCRIPT = `${OXIDEVM_DIRECTORY}/pg-writer.py`;
export const CLIENT_SCRIPT = `${OXIDEVM_DIRECTORY}/oxidevm_pglite.py`;

/** Artifacts the module writes into the guest before it uses them: `guestFiles` in the manifest. */
export const GUEST_FILES = [
  { artifact: "pg-metadata.py", to: METADATA_SCRIPT, mode: 0o644 },
  { artifact: "pg-writer.py", to: WRITER_SCRIPT, mode: 0o644 },
  { artifact: "oxidevm_pglite.py", to: CLIENT_SCRIPT, mode: 0o644 },
] as const;
