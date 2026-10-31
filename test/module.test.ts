import fs from "node:fs";
import path from "node:path";
import { classifyLicense, decodeDeclaration, isServiceDecl } from "@oxidevm/sdk/wasm";
import { describe, expect, it } from "vitest";
import definition from "../module.ts";
import { decodeLock } from "../scripts/upstream.ts";
import { CLIENT_SCRIPT, GUEST_FILES, OXIDEVM_DIRECTORY, SQL_SOCKET, STAGING_DIRECTORY } from "../src/layout.ts";

const { manifest } = definition;
const root = path.join(import.meta.dirname, "..");
const lock = decodeLock(JSON.parse(fs.readFileSync(path.join(root, "upstream/lock.json"), "utf8")));

describe("the manifest", () => {
  it("is accepted by the SDK's own decoder", () => {
    const decoded = decodeDeclaration(JSON.parse(JSON.stringify(manifest)));
    expect(decoded.id).toBe("pglite");
    expect(isServiceDecl(decoded)).toBe(true);
  });

  it("is a service for Emscripten-built WebAssembly, exclusive per workspace, serving at most four clients", () => {
    expect(manifest).toMatchObject({ id: "pglite", version: "0.1.0", abi: "emscripten", process: { kind: "service", exclusive: "workspace" }, limits: { clients: 4, startupMs: 300_000 } });
  });

  it("exposes the JSON endpoint on a Unix socket and the PostgreSQL protocol on the standard port", () => {
    expect(manifest.expose).toEqual({
      sql: { kind: "unix", path: "/workspace/_oxidevm/pglite.sock", protocol: "oxidevm-sql/1" },
      pg: { kind: "tcp", port: 5432, protocol: "postgres-3.0" },
    });
    expect(manifest.expose.sql.path).toBe(SQL_SOCKET);
  });

  it("asks only for what the adapter uses: files, the process id, and no program of the image", () => {
    expect([...manifest.requires.host].sort()).toEqual(["files.sync", "process.info"]);
    expect([...manifest.requires.browser].sort()).toEqual(["indexeddb", "web-locks"]);
    expect(Object.keys(manifest.requires).sort()).toEqual(["browser", "host"]);
    expect(manifest.mounts).toEqual([{ guest: "/workspace", access: "rw", durability: "fsync" }]);
    expect(manifest.state.durable).toEqual(["/workspace/pgdata"]);
  });

  it("declares the options with the defaults the adapter relies on", () => {
    expect(manifest.options).toEqual({
      dataDir: { type: "string", maxLength: 255, default: "/workspace/pgdata" },
      durability: { type: "enum", values: ["relaxed", "strict"], default: "strict" },
      legacyIndexedDb: { type: "string", maxLength: 128, default: "" },
    });
  });

  it("declares the one guest file the adapter writes, the Python client", () => {
    expect(manifest.guestFiles).toEqual(GUEST_FILES.map(file => ({ artifact: file.artifact, to: file.to, mode: file.mode })));
    expect(GUEST_FILES.map(file => file.to)).toEqual([CLIENT_SCRIPT]);
    for (const file of GUEST_FILES) expect(file.to.startsWith(`${OXIDEVM_DIRECTORY}/`)).toBe(true);
    expect(STAGING_DIRECTORY.startsWith(`${OXIDEVM_DIRECTORY}/`)).toBe(true);
  });
});

describe("the artifacts", () => {
  it("are files of this repository, and the mirrored ones are exactly the files the upstream lock pins", () => {
    const mirrored = manifest.artifacts.filter(artifact => artifact.from.startsWith("upstream/"));
    expect(mirrored.map(artifact => artifact.name).sort()).toEqual(["initdb.wasm", "pglite.data", "pglite.wasm"]);
    for (const artifact of mirrored) expect(artifact.from).toBe(`upstream/${artifact.name}`);
    const locked = new Map(lock.files.map(file => [file.name, file]));
    for (const artifact of mirrored) expect(locked.has(artifact.name), artifact.name).toBe(true);
    for (const artifact of manifest.artifacts.filter(item => !item.from.startsWith("upstream/"))) {
      expect(fs.existsSync(path.join(root, artifact.from)), artifact.from).toBe(true);
    }
  });

  it("name every guest file and the notices", () => {
    const names = new Set(manifest.artifacts.map(artifact => artifact.name));
    for (const file of manifest.guestFiles) expect(names.has(file.artifact)).toBe(true);
    expect([...names].sort()).toEqual(["NOTICES.txt", "initdb.wasm", "oxidevm_pglite.py", "pglite.data", "pglite.wasm"]);
    for (const notice of manifest.license.notices) expect(names.has(notice)).toBe(true);
  });

  it("record where the mirrored files come from", () => {
    expect(manifest.upstream).toEqual([
      { name: "@electric-sql/pglite", version: lock.package.version, source: `https://www.npmjs.com/package/@electric-sql/pglite/v/${lock.package.version}` },
      { name: "PostgreSQL (PGlite fork)", version: "18.6", source: "https://github.com/electric-sql/postgres-pglite" },
    ]);
  });
});

describe("the license", () => {
  it("is a permissive expression whose every identifier is named in the notices", () => {
    const classification = classifyLicense(manifest.license.spdx);
    expect(classification.copyleft).toBe(false);
    expect(new Set(classification.ids)).toEqual(new Set(["Apache-2.0", "PostgreSQL", "MIT", "Unicode-3.0", "BSD-3-Clause"]));
    expect(manifest.license.spdx).toContain("Apache-2.0 WITH LLVM-exception");
    const notices = fs.readFileSync(path.join(root, "NOTICES.txt"), "utf8");
    for (const identifier of ["Apache-2.0", "PostgreSQL License", "Unicode-3.0", "BSD-3-Clause", "LLVM-exception"]) expect(notices, identifier).toContain(identifier);
  });

  it("matches the licenses of the code it mirrors", () => {
    expect(lock.package.license).toBe("Apache-2.0");
  });
});
