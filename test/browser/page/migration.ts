import { PGlite } from "@electric-sql/pglite";
import { spawnModule, stopModule } from "@oxidevm/sdk/wasm";
import { CLIENT_IMPORT } from "./native";
import { pglite } from "./oxidevm.modules.generated";
import type { ScenarioResult, SuiteConfig } from "./protocol";
import { expect, expectEqual, openVM, python, runScenarios } from "./util";

/** The IndexedDB database the sample's application kept its data in. */
const LEGACY = "oxidevm-pyodide-v1-pglite";

async function compiled(url: string): Promise<WebAssembly.Module> {
  return WebAssembly.compileStreaming(fetch(url));
}

/** Builds the legacy database the way the sample's application did: PGlite on IndexedDB. */
async function createLegacyDatabase(config: SuiteConfig): Promise<void> {
  const db = await PGlite.create({
    dataDir: `idb://${LEGACY}`,
    pgliteWasmModule: await compiled(config.legacyURLs.wasm),
    initdbWasmModule: await compiled(config.legacyURLs.initdb),
    fsBundle: await (await fetch(config.legacyURLs.data)).blob(),
  });
  await db.exec("CREATE TABLE preserved(id integer PRIMARY KEY, label text); INSERT INTO preserved VALUES (42, 'original data');");
  await db.exec("CREATE TABLE ticket(id bigserial PRIMARY KEY, note text); INSERT INTO ticket(note) VALUES ('a'), ('b');");
  await db.close();
}

/** Where the page writes the exported archive: a directory of pieces, because one workspace write takes at most 16 MiB. */
const ARCHIVE = "pglite-import";
const ARCHIVE_PATH = `/workspace/${ARCHIVE}`;
const PIECE_BYTES = 16 * 1024 ** 2;

/**
 * The page side of the migration (README, "Migrate from IndexedDB"): PGlite in the page opens the legacy database,
 * archives its data directory and writes the archive into the VM. The module, which has no IndexedDB, loads it.
 */
async function exportLegacyDatabase(config: SuiteConfig, vm: Awaited<ReturnType<typeof openVM>>): Promise<number> {
  const legacy = await PGlite.create({
    dataDir: `idb://${LEGACY}`,
    pgliteWasmModule: await compiled(config.legacyURLs.wasm),
    initdbWasmModule: await compiled(config.legacyURLs.initdb),
    fsBundle: await (await fetch(config.legacyURLs.data)).blob(),
  });
  try {
    const archive = new Uint8Array(await (await legacy.dumpDataDir("gzip")).arrayBuffer());
    await vm.workspace.createDirectory(ARCHIVE);
    for (let offset = 0, index = 0; offset < archive.length; offset += PIECE_BYTES, index += 1) {
      await vm.workspace.writeFile(`${ARCHIVE}/${String(index).padStart(3, "0")}`, archive.subarray(offset, offset + PIECE_BYTES));
    }
    return archive.length;
  } finally {
    await legacy.close();
  }
}

async function legacyStillThere(): Promise<boolean> {
  return (await indexedDB.databases()).some(database => database.name === `/pglite/${LEGACY}`);
}

export async function migration(config: SuiteConfig): Promise<readonly ScenarioResult[]> {
  await createLegacyDatabase(config);
  const vm = await openVM(config);
  const start = () => spawnModule(vm, pglite, { workspaceId: "pglite-migration", options: { importArchive: ARCHIVE_PATH } });
  let service: Awaited<ReturnType<typeof start>> | undefined;
  try {
    return await runScenarios([
      ["migration: the page exports the legacy IndexedDB database into the workspace and the module imports it", async () => {
        const size = await exportLegacyDatabase(config, vm);
        service = await start();
        const rows = await python(vm, `${CLIENT_IMPORT}print(pg.query("SELECT * FROM preserved")["rows"])\nprint(pg.query("SELECT id, note FROM ticket ORDER BY id")["rows"])`);
        expectEqual(rows.split("\n"), ["[{'id': 42, 'label': 'original data'}]", "[{'id': 1, 'note': 'a'}, {'id': 2, 'note': 'b'}]"], "migrated rows");
        const marker: unknown = JSON.parse(await vm.workspace.readText("pgdata/.oxidevm-storage.json"));
        const source: unknown = typeof marker === "object" && marker !== null ? Reflect.get(marker, "source") : undefined;
        const backup: unknown = typeof marker === "object" && marker !== null ? Reflect.get(marker, "backup") : undefined;
        expectEqual(source, "archive", "marker source");
        expectEqual(backup, ARCHIVE_PATH, "marker backup");
        const kept = Number(await python(vm, `import os\nd = ${JSON.stringify(ARCHIVE_PATH)}\nprint(sum(os.stat(os.path.join(d, n)).st_size for n in os.listdir(d)))`));
        expectEqual(kept, size, "size of the kept archive");
        expect(await legacyStillThere(), "the legacy IndexedDB database was removed");
        expectEqual(service.info["dataDir"], "/workspace/pgdata", "info.dataDir");
        return `archive of ${String(size)} bytes imported and kept, legacy database retained`;
      }],
      ["migration: a restart opens the imported database and does not import again", async () => {
        if (service === undefined) throw new Error("The module is not running");
        await python(vm, `${CLIENT_IMPORT}pg.query("INSERT INTO preserved VALUES (43, 'added after the migration')")`);
        const before = await vm.workspace.readText("pgdata/.oxidevm-storage.json");
        await stopModule(service);
        service = await start();
        const rows = await python(vm, `${CLIENT_IMPORT}print(pg.query("SELECT id FROM preserved ORDER BY id")["rows"])`);
        expectEqual(rows, "[{'id': 42}, {'id': 43}]", "rows after the restart");
        expectEqual(await vm.workspace.readText("pgdata/.oxidevm-storage.json"), before, "marker after the restart");
        return "marker unchanged, new row kept";
      }],
    ]);
  } finally {
    if (service !== undefined) await stopModule(service).catch(() => undefined);
    await vm.dispose();
  }
}
