import { spawnModule } from "@oxidevm/sdk/wasm";
import { CLIENT_IMPORT } from "./native";
import { pglite } from "./oxidevm.modules.generated";
import type { ScenarioResult, SuiteConfig } from "./protocol";
import { expectEqual, openVM, python, runScenarios } from "./util";

const WORKSPACE_ID = "pglite-crash";

/**
 * Phase one of the crash test. It leaves a committed row and an open transaction behind and returns while the
 * module is still running: the harness then kills the renderer, so nothing here is shut down on purpose.
 */
export async function crashSeed(config: SuiteConfig): Promise<readonly ScenarioResult[]> {
  const vm = await openVM(config, { workspaceId: WORKSPACE_ID });
  return runScenarios([
    ["seed: a committed row and an open transaction with a second row, both visible to the session", async () => {
      await spawnModule(vm, pglite, { workspaceId: WORKSPACE_ID });
      const rows = await python(vm, `${CLIENT_IMPORT}
pg.query("CREATE TABLE recovery (n integer)")
pg.query("INSERT INTO recovery VALUES (42)")
pg.query("BEGIN")
pg.query("INSERT INTO recovery VALUES (99)")
print(pg.query("SELECT n FROM recovery ORDER BY n")["rows"])`);
      expectEqual(rows, "[{'n': 42}, {'n': 99}]", "rows before the crash");
      return rows;
    }],
  ]);
}

/** Phase two, in a new page of the same browser context after the crash, on the same persistent workspace. */
export async function crashRecover(config: SuiteConfig): Promise<readonly ScenarioResult[]> {
  const vm = await openVM(config, { workspaceId: WORKSPACE_ID });
  try {
    return await runScenarios([
      ["recovery: the committed row survived the renderer crash and the open transaction rolled back", async () => {
        const service = await spawnModule(vm, pglite, { workspaceId: WORKSPACE_ID });
        const rows = await python(vm, `${CLIENT_IMPORT}print(pg.query("SELECT n FROM recovery ORDER BY n")["rows"])`);
        expectEqual(rows, "[{'n': 42}]", "rows after the crash");
        return `${rows}, restarted as pid ${String(service.pid)}`;
      }],
      ["recovery: the database is writable again and keeps new data across a clean restart", async () => {
        await python(vm, `${CLIENT_IMPORT}pg.query("INSERT INTO recovery VALUES (43)")\nprint(pg.query("SELECT count(*)::int AS n FROM recovery")["rows"])`);
        return "ok";
      }],
    ]);
  } finally {
    await vm.dispose();
  }
}
