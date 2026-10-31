import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { kit } from "@oxidevm/sdk/wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.ts";
import { decodeMarker } from "../src/marker.ts";
import { openDatabase } from "../src/storage.ts";
import type { LegacySource, OpenedDatabase, StorageHost, StorageOptions } from "../src/storage.ts";
import { createNodeFiles } from "./support/node-files.ts";
import type { NodeFilesHarness } from "./support/node-files.ts";

let base = "", dataDir = "", stagingDir = "", backupDir = "";
let harness: NodeFilesHarness;
let logs: string[];
const opened: OpenedDatabase[] = [];

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pglite-storage-")));
  backupDir = path.join(base, "_oxidevm");
  fs.mkdirSync(backupDir);
  dataDir = path.join(base, "pgdata");
  stagingDir = path.join(backupDir, "pgdata-migrating");
  harness = createNodeFiles();
  logs = [];
});
afterEach(async () => {
  for (const item of opened.splice(0)) if (!item.db.closed) await item.db.close().catch(() => undefined);
  fs.rmSync(base, { recursive: true, force: true });
});

const host = (): StorageHost => ({ files: harness.files, kit, log: line => { logs.push(line); } });
const options = (extra: Partial<StorageOptions> = {}): StorageOptions => ({ dataDir, stagingDir, backupDir, pglite: {}, ...extra });

async function open(extra: Partial<StorageOptions> = {}): Promise<OpenedDatabase> {
  const database = await openDatabase(host(), options(extra));
  opened.push(database);
  return database;
}

/** A legacy database held in memory: its archive and fingerprint, the way the IndexedDB source exports them. */
async function legacyExport(statements: string): Promise<{ archive: Blob; fingerprint: string }> {
  const legacy = await PGlite.create();
  try {
    await legacy.exec(statements);
    return { archive: await legacy.dumpDataDir("none"), fingerprint: await fingerprint(legacy) };
  } finally {
    await legacy.close();
  }
}

const markerOf = (directory: string) => decodeMarker(fs.readFileSync(path.join(directory, ".oxidevm-storage.json")));

describe("a new data directory", () => {
  it("is built beside its destination, verified, marked, flushed and only then renamed into place", async () => {
    const database = await open();
    expect(database.origin).toBe("created");
    expect((await database.db.query("SELECT 41 + 1 AS answer")).rows).toEqual([{ answer: 42 }]);
    expect(fs.readFileSync(path.join(dataDir, "PG_VERSION"), "utf8").trim()).toBe("18");
    expect(fs.existsSync(stagingDir)).toBe(false);

    const marker = markerOf(dataDir);
    expect(marker).toMatchObject({ version: 1, source: "new", backup: null });
    expect(marker.fingerprint).toBe(await fingerprint(database.db));

    const rename = harness.ops.indexOf(`rename:${stagingDir}->${dataDir}`);
    const markerSync = harness.ops.indexOf(`fsync:${stagingDir}/.oxidevm-storage.json`);
    const stagingSync = harness.ops.slice(0, rename).lastIndexOf(`fsync:${stagingDir}`);
    expect(rename).toBeGreaterThan(-1);
    expect(markerSync).toBeGreaterThan(-1);
    expect(stagingSync).toBeGreaterThan(markerSync);
    expect(rename).toBeGreaterThan(stagingSync);
    expect(harness.ops.indexOf(`fsync:${base}`, rename)).toBeGreaterThan(rename);
    expect(harness.ops.indexOf(`fsync:${backupDir}`, rename)).toBeGreaterThan(rename);
    expect(logs.join("\n")).toContain("created a new PostgreSQL database");
  });

  it("is opened as it is the next time, with its data", async () => {
    const first = await open();
    await first.db.exec("CREATE TABLE kept(n integer); INSERT INTO kept VALUES (7)");
    await first.db.close();
    harness.ops.length = 0;
    const second = await open();
    expect(second.origin).toBe("existing");
    expect((await second.db.query("SELECT n FROM kept")).rows).toEqual([{ n: 7 }]);
    expect(harness.ops.filter(op => op.includes(stagingDir))).toEqual([]);
  });

  it("keeps an earlier unfinished attempt aside instead of overwriting it", async () => {
    fs.mkdirSync(stagingDir);
    fs.writeFileSync(path.join(stagingDir, "leftover"), "from a crash");
    const database = await open();
    expect(database.origin).toBe("created");
    const aside = fs.readdirSync(backupDir).filter(name => name.startsWith("pgdata-migrating-failed-"));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(backupDir, aside[0] ?? "", "leftover"), "utf8")).toBe("from a crash");
  });

  it("creates the missing parent directories of a nested data directory and makes them durable", async () => {
    dataDir = path.join(base, "databases", "main", "data");
    const database = await open();
    expect(database.origin).toBe("created");
    expect(fs.existsSync(path.join(dataDir, "PG_VERSION"))).toBe(true);
    expect(harness.ops).toContain(`mkdir:${path.join(base, "databases")}`);
    expect(harness.ops).toContain(`mkdir:${path.join(base, "databases", "main")}`);
    expect(harness.ops.indexOf(`fsync:${base}`)).toBeGreaterThan(harness.ops.indexOf(`mkdir:${path.join(base, "databases")}`));
    expect(harness.ops.indexOf(`fsync:${path.join(base, "databases")}`)).toBeGreaterThan(harness.ops.indexOf(`mkdir:${path.join(base, "databases", "main")}`));
  });

  it("reports a legacy source with no database as a new one", async () => {
    let asked = 0;
    const legacy: LegacySource = { export: () => { asked += 1; return Promise.resolve(undefined); } };
    const database = await open({ legacy });
    expect(asked).toBe(1);
    expect(database.origin).toBe("created");
    expect(markerOf(dataDir).source).toBe("new");
  });
});

describe("an existing data directory", () => {
  it("is refused without a marker or without PG_VERSION, and left untouched", async () => {
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "18\n");
    await expect(open()).rejects.toThrow(`Existing ${dataDir} has no verified migration marker. Preserve it and inspect it before starting PostgreSQL.`);
    fs.rmSync(path.join(dataDir, "PG_VERSION"));
    fs.writeFileSync(path.join(dataDir, ".oxidevm-storage.json"), "{}");
    await expect(open()).rejects.toThrow("has no verified migration marker");
    expect(fs.readdirSync(dataDir).sort()).toEqual([".oxidevm-storage.json"]);
  });

  it("is refused with a marker of another version or a damaged one", async () => {
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "18\n");
    const marker = path.join(dataDir, ".oxidevm-storage.json");
    fs.writeFileSync(marker, JSON.stringify({ version: 2 }));
    await expect(open()).rejects.toThrow("Unsupported VM PostgreSQL storage marker");
    fs.writeFileSync(marker, "garbage");
    await expect(open()).rejects.toThrow("Unreadable VM PostgreSQL storage marker");
    fs.writeFileSync(marker, JSON.stringify({ version: 1, source: "new" }));
    await expect(open()).rejects.toThrow("Invalid VM PostgreSQL storage marker");
    fs.writeFileSync(marker, " ".repeat(5000));
    await expect(open()).rejects.toThrow("Unreadable VM PostgreSQL storage marker");
  });
});

describe("migration from a legacy database", () => {
  const statements = "CREATE TABLE preserved(id integer PRIMARY KEY, label text); INSERT INTO preserved VALUES (42, 'original data'); CREATE SEQUENCE ids;";

  it("copies the archive into the data directory, verifies the copy, and keeps the archive as a backup", async () => {
    const exported = await legacyExport(statements);
    let asked = 0;
    const legacy: LegacySource = { export: () => { asked += 1; return Promise.resolve(exported); } };
    const database = await open({ legacy });
    expect(database.origin).toBe("migrated");
    expect((await database.db.query("SELECT * FROM preserved")).rows).toEqual([{ id: 42, label: "original data" }]);

    const marker = markerOf(dataDir);
    expect(marker).toMatchObject({ version: 1, source: "indexeddb", fingerprint: exported.fingerprint });
    expect(marker.backup).toMatch(new RegExp(`^${backupDir}/pglite-indexeddb-[0-9a-f-]{36}\\.tar$`, "u"));
    const backup = marker.backup ?? "";
    expect(Buffer.compare(fs.readFileSync(backup), Buffer.from(await exported.archive.arrayBuffer()))).toBe(0);
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain("migrated");
    expect(await fingerprint(database.db)).toBe(exported.fingerprint);

    await database.db.close();
    await open({ legacy });
    expect(asked).toBe(1);
  });

  it("does not publish a copy that differs from the legacy database, and keeps the attempt and the backup", async () => {
    const exported = await legacyExport(statements);
    const legacy: LegacySource = { export: () => Promise.resolve({ archive: exported.archive, fingerprint: "0".repeat(64) }) };
    await expect(open({ legacy })).rejects.toThrow("Database migration verification failed. Original data and backup are preserved.");
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(fs.existsSync(stagingDir)).toBe(true);
    expect(fs.readdirSync(backupDir).filter(name => name.endsWith(".tar"))).toHaveLength(1);
  });

  it("refuses an archive over 256 MiB before writing anything", async () => {
    const huge = Object.defineProperty(new Blob([]), "size", { value: 300 * 1024 ** 2 });
    const legacy: LegacySource = { export: () => Promise.resolve({ archive: huge, fingerprint: "0".repeat(64) }) };
    await expect(open({ legacy })).rejects.toThrow("The migration archive exceeds the 256 MiB limit. The IndexedDB database is preserved.");
    expect(fs.readdirSync(backupDir).filter(name => name.endsWith(".tar"))).toEqual([]);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it("accepts an archive of exactly 256 MiB", async () => {
    const exported = await legacyExport(statements);
    const limit = Object.defineProperty(new Blob([exported.archive]), "size", { value: 256 * 1024 ** 2 });
    const legacy: LegacySource = { export: () => Promise.resolve({ archive: limit, fingerprint: exported.fingerprint }) };
    expect((await open({ legacy })).origin).toBe("migrated");
  });

  it("passes a failure of the legacy source on, leaving no data directory", async () => {
    const legacy: LegacySource = { export: () => Promise.reject(new Error("IndexedDB is unavailable")) };
    await expect(open({ legacy })).rejects.toThrow("IndexedDB is unavailable");
    expect(fs.existsSync(dataDir)).toBe(false);
  });
});

describe("durability", () => {
  it("flushes before a statement is answered when strict, and reports a failed flush", async () => {
    const database = await open({ pglite: { relaxedDurability: false } });
    await database.db.exec("CREATE TABLE d(n integer)");
    harness.failFsync = true;
    await expect(database.db.query("INSERT INTO d VALUES (1)")).rejects.toThrow("Injected storage flush failure");
    harness.failFsync = false;
  });

  it("answers first and flushes after when relaxed, logging a failed flush instead of losing it", async () => {
    const database = await open({ pglite: { relaxedDurability: true } });
    await database.db.exec("CREATE TABLE d(n integer)");
    harness.failFsync = true;
    await database.db.query("INSERT INTO d VALUES (1)");
    await database.fs.syncToFs().catch(() => undefined);
    harness.failFsync = false;
    expect(logs.join("\n")).toContain("database flush failed after the statement was answered");
    await database.fs.syncToFs();
    expect((await database.db.query("SELECT n FROM d")).rows).toEqual([{ n: 1 }]);
  });

  it("builds the new database strictly even when the live one is relaxed", async () => {
    harness.failFsync = file => file.includes("/base/");
    await expect(open({ pglite: { relaxedDurability: true } })).rejects.toThrow("Injected storage flush failure");
    expect(fs.existsSync(dataDir)).toBe(false);
  });
});
