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

async function legacyStillThere(): Promise<boolean> {
  return (await indexedDB.databases()).some(database => database.name === `/pglite/${LEGACY}`);
}

export async function migration(config: SuiteConfig): Promise<readonly ScenarioResult[]> {
  await createLegacyDatabase(config);
  const vm = await openVM(config);
  const start = () => spawnModule(vm, pglite, { workspaceId: "pglite-migration", options: { legacyIndexedDb: LEGACY } });
  let service: Awaited<ReturnType<typeof start>> | undefined;
  try {
    return await runScenarios([
      ["migration: the legacy IndexedDB database is copied into the workspace and verified", async () => {
        service = await start();
        const rows = await python(vm, `${CLIENT_IMPORT}print(pg.query("SELECT * FROM preserved")["rows"])\nprint(pg.query("SELECT id, note FROM ticket ORDER BY id")["rows"])`);
        expectEqual(rows.split("\n"), ["[{'id': 42, 'label': 'original data'}]", "[{'id': 1, 'note': 'a'}, {'id': 2, 'note': 'b'}]"], "migrated rows");
        const marker: unknown = JSON.parse(await vm.workspace.readText("pgdata/.oxidevm-storage.json"));
        const source: unknown = typeof marker === "object" && marker !== null ? Reflect.get(marker, "source") : undefined;
        const backup: unknown = typeof marker === "object" && marker !== null ? Reflect.get(marker, "backup") : undefined;
        expectEqual(source, "indexeddb", "marker source");
        expect(typeof backup === "string" && backup.startsWith("/workspace/_oxidevm/pglite-indexeddb-"), `backup ${String(backup)}`);
        const size = Number(await python(vm, `import os\nprint(os.stat(${JSON.stringify(backup)}).st_size)`));
        expect(size > 0, "the backup archive is empty");
        expect(await legacyStillThere(), "the legacy IndexedDB database was removed");
        expectEqual(service.info["dataDir"], "/workspace/pgdata", "info.dataDir");
        return `backup of ${String(size)} bytes kept, legacy database retained`;
      }],
      ["migration: a restart opens the migrated database and does not migrate again", async () => {
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
