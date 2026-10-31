import type { PGliteOptions } from "@electric-sql/pglite";
import { defineModule } from "@oxidevm/sdk/wasm";
import { ensureGuestFiles } from "./src/guest-files.ts";
import { BACKEND, jsonEndpoint } from "./src/json-endpoint.ts";
import { METADATA_SCRIPT, OXIDEVM_DIRECTORY, STAGING_DIRECTORY, WRITER_SCRIPT } from "./src/layout.ts";
import { indexedDbSource } from "./src/legacy.ts";
import { startMetadataHelper } from "./src/metadata.ts";
import { resolveDataDir, resolveLegacyName } from "./src/options.ts";
import { openDatabase } from "./src/storage.ts";
import { wireSession } from "./src/wire.ts";
import { createWriterFactory } from "./src/writer.ts";

/**
 * PGlite, PostgreSQL for WebAssembly, as an OxideVM service. It keeps its database as live files in the
 * workspace, answers JSON statements on a Unix socket (`oxidevm-sql/1`, for Python and JavaScript clients) and
 * speaks the PostgreSQL protocol on 127.0.0.1:5432 (for psql, psycopg and any driver).
 */
export default defineModule({
  manifest: {
    id: "pglite",
    version: "0.1.0",
    abi: "emscripten",
    artifacts: [
      { name: "pglite.wasm", from: "upstream/pglite.wasm" },
      { name: "initdb.wasm", from: "upstream/initdb.wasm" },
      { name: "pglite.data", from: "upstream/pglite.data" },
      { name: "pg-metadata.py", from: "guest/pg-metadata.py" },
      { name: "pg-writer.py", from: "guest/pg-writer.py" },
      { name: "oxidevm_pglite.py", from: "guest/oxidevm_pglite.py" },
      { name: "NOTICES.txt", from: "NOTICES.txt" },
    ],
    process: { kind: "service", exclusive: "workspace" },
    expose: {
      sql: { kind: "unix", path: "/workspace/_oxidevm/pglite.sock", protocol: "oxidevm-sql/1" },
      pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" },
    },
    requires: {
      host: ["files.async", "files.sync", "process.info", "process.spawn"],
      browser: ["indexeddb", "web-locks"],
      guest: { executables: ["/usr/bin/python3"] },
    },
    limits: { clients: 4 },
    mounts: [{ guest: "/workspace", access: "rw", durability: "fsync" }],
    state: { durable: ["/workspace/pgdata"] },
    guestFiles: [
      { artifact: "pg-metadata.py", to: "/workspace/_oxidevm/pg-metadata.py", mode: 0o644 },
      { artifact: "pg-writer.py", to: "/workspace/_oxidevm/pg-writer.py", mode: 0o644 },
      { artifact: "oxidevm_pglite.py", to: "/workspace/_oxidevm/oxidevm_pglite.py", mode: 0o644 },
    ],
    options: {
      dataDir: { type: "string", maxLength: 255, default: "/workspace/pgdata" },
      durability: { type: "enum", values: ["relaxed", "strict"], default: "strict" },
      legacyIndexedDb: { type: "string", maxLength: 128, default: "" },
    },
    license: { spdx: "Apache-2.0 AND PostgreSQL AND MIT AND Unicode-3.0 AND BSD-3-Clause AND Apache-2.0 WITH LLVM-exception", notices: ["NOTICES.txt"] },
    upstream: [
      { name: "@electric-sql/pglite", version: "0.5.14", source: "https://www.npmjs.com/package/@electric-sql/pglite/v/0.5.14" },
      { name: "PostgreSQL (PGlite fork)", version: "18.6", source: "https://github.com/electric-sql/postgres-pglite" },
    ],
  },
  adapter: async host => {
    const dataDir = resolveDataDir(host.options.dataDir);
    const legacyName = resolveLegacyName(host.options.legacyIndexedDb);
    const { pid } = await host.process.info();
    await ensureGuestFiles({ fs: host.fs, artifacts: host.artifacts, errno: host.kit.errno });

    // Phase 1: the host has no utimes, so a Python helper sets file times (engine API 144 removes it).
    const metadata = await startMetadataHelper(host, { script: METADATA_SCRIPT, roots: [dataDir, STAGING_DIRECTORY] });
    try {
      const pglite: PGliteOptions = {
        relaxedDurability: host.options.durability === "relaxed",
        pgliteWasmModule: await host.artifacts.compile("pglite.wasm"),
        initdbWasmModule: await host.artifacts.compile("initdb.wasm"),
        fsBundle: new Blob([await host.artifacts.bytes("pglite.data")]),
      };
      const { db } = await openDatabase(
        { files: host.fs, kit: host.kit, utimes: metadata.utimes, log: line => { host.log(line); } },
        { dataDir, stagingDir: STAGING_DIRECTORY, backupDir: OXIDEVM_DIRECTORY, pglite, ...(legacyName === undefined ? {} : { legacy: indexedDbSource(legacyName, pglite) }) },
      );
      const version = (await db.query<{ server_version: string }>("SHOW server_version")).rows[0]?.server_version;
      if (version === undefined) throw new Error("PostgreSQL did not report its version");

      const gate = host.kit.gate();
      // Phase 1: a write to a client that has gone ends the process, so helper processes write the PostgreSQL responses.
      const writers = createWriterFactory(
        { stdout: host.stdio.stdout, fs: host.fs, files: host.files, process: host.process },
        { script: WRITER_SCRIPT, spoolDirectory: OXIDEVM_DIRECTORY },
      );
      return {
        info: () => ({ version, backend: BACKEND, dataDir, durability: host.options.durability }),
        protocols: {
          sql: jsonEndpoint({ database: { query: (sql, params) => db.query<Record<string, unknown>>(sql, params) }, gate, pid, framing: host.kit.framing }),
          pg: async connection => {
            const writer = await writers.open(connection.fd);
            try {
              await wireSession(
                { signal: connection.signal, read: maxBytes => connection.read(maxBytes), readSync: maxBytes => host.fs.read(connection.fd, maxBytes) },
                { db, version, gate, sink: writer, readExactly: host.kit.framing.readExactly },
              );
            } finally {
              await writer.close();
            }
          },
        },
        close: async () => {
          try {
            await db.close();
          } finally {
            await metadata.close();
          }
        },
      };
    } catch (error: unknown) {
      await metadata.close().catch(() => undefined);
      throw error;
    }
  },
});
