import type { PGliteOptions } from "@electric-sql/pglite";
import { defineModule } from "@oxidevm/sdk/wasm";
import { createClientSink } from "./src/client-sink.ts";
import { ensureGuestFiles } from "./src/guest-files.ts";
import { BACKEND, jsonEndpoint } from "./src/json-endpoint.ts";
import { STAGING_DIRECTORY } from "./src/layout.ts";
import { archiveSource } from "./src/archive.ts";
import { resolveDataDir, resolveImportArchive } from "./src/options.ts";
import { createSharedBackend } from "./src/session.ts";
import { openDatabase } from "./src/storage.ts";
import { wireSession } from "./src/wire.ts";

/**
 * PGlite, PostgreSQL for WebAssembly, as an OxideVM service. It keeps its database as live files in the
 * workspace, answers JSON statements on a Unix socket (`oxidevm-sql/1`, for Python and JavaScript clients) and
 * speaks the PostgreSQL protocol on 127.0.0.1:5432 (for psql, psycopg and any driver).
 */
export default defineModule({
  manifest: {
    id: "pglite",
    version: "0.3.1",
    abi: "emscripten",
    artifacts: [
      { name: "pglite.wasm", from: "upstream/pglite.wasm" },
      { name: "initdb.wasm", from: "upstream/initdb.wasm" },
      { name: "pglite.data", from: "upstream/pglite.data" },
      { name: "oxidevm_pglite.py", from: "guest/oxidevm_pglite.py" },
      { name: "NOTICES.txt", from: "NOTICES.txt" },
    ],
    process: { kind: "service", exclusive: "workspace" },
    expose: {
      sql: { kind: "unix", path: "/workspace/_oxidevm/pglite.sock", protocol: "oxidevm-sql/1" },
      pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" },
    },
    // No network reach: the service opens no connections of its own and serves programs in the VM through `expose`.
    // No browser storage either: the database is files of the VM, and `exclusive` is the VM's workspace lease.
    requires: { host: ["files.sync", "process.info"] },
    // The first start initializes PostgreSQL, and an import loads a whole database: more than the default two minutes on a slow machine.
    limits: { clients: 4, startupMs: 300_000 },
    mounts: [{ guest: "/workspace", access: "rw", durability: "fsync" }],
    state: { durable: ["/workspace/pgdata"] },
    guestFiles: [{ artifact: "oxidevm_pglite.py", to: "/workspace/_oxidevm/oxidevm_pglite.py", mode: 0o644 }],
    options: {
      dataDir: { type: "string", maxLength: 255, default: "/workspace/pgdata" },
      durability: { type: "enum", values: ["relaxed", "strict"], default: "strict" },
      importArchive: { type: "string", maxLength: 255, default: "" },
    },
    license: { spdx: "Apache-2.0 AND PostgreSQL AND MIT AND Unicode-3.0 AND BSD-3-Clause AND Apache-2.0 WITH LLVM-exception", notices: ["NOTICES.txt"] },
    upstream: [
      { name: "@electric-sql/pglite", version: "0.5.14", source: "https://www.npmjs.com/package/@electric-sql/pglite/v/0.5.14" },
      { name: "PostgreSQL (PGlite fork)", version: "18.6", source: "https://github.com/electric-sql/postgres-pglite" },
    ],
  },
  adapter: async host => {
    const dataDir = resolveDataDir(host.options.dataDir);
    const importArchive = resolveImportArchive(host.options.importArchive, dataDir);
    const { pid } = await host.process.info();
    await ensureGuestFiles({ fs: host.fs, artifacts: host.artifacts, errno: host.kit.errno });

    const pglite: PGliteOptions = {
      relaxedDurability: host.options.durability === "relaxed",
      pgliteWasmModule: await host.artifacts.compile("pglite.wasm"),
      initdbWasmModule: await host.artifacts.compile("initdb.wasm"),
      fsBundle: new Blob([await host.artifacts.bytes("pglite.data")]),
    };
    const { db } = await openDatabase(
      { files: host.fs, kit: host.kit, log: line => { host.log(line); } },
      { dataDir, stagingDir: STAGING_DIRECTORY, pglite, ...(importArchive === undefined ? {} : { source: archiveSource({ files: host.fs, errno: host.kit.errno }, importArchive) }) },
    );
    const version = (await db.query<{ server_version: string }>("SHOW server_version")).rows[0]?.server_version;
    if (version === undefined) throw new Error("PostgreSQL did not report its version");

    const backend = createSharedBackend({ gate: host.kit.gate(), db });
    return {
      info: () => ({ version, backend: BACKEND, dataDir, durability: host.options.durability }),
      protocols: {
        sql: jsonEndpoint({ database: { query: (sql, params) => db.query<Record<string, unknown>>(sql, params) }, gate: backend.embedded, pid, framing: host.kit.framing }),
        pg: connection => wireSession(
          { signal: connection.signal, read: maxBytes => connection.read(maxBytes), readSync: maxBytes => host.fs.read(connection.fd, maxBytes) },
          { db, version, backend, sink: createClientSink({ connection, fs: host.fs }), readExactly: host.kit.framing.readExactly },
        ),
      },
      close: () => db.close(),
    };
  },
});
