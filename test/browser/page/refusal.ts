import type { UserspaceVM } from "@oxidevm/sdk";
import { spawnModule } from "@oxidevm/sdk/wasm";
import { pglite } from "./oxidevm.modules.generated";
import type { ScenarioResult, SuiteConfig } from "./protocol";
import { expect, openVM, runScenarios } from "./util";

interface Refusal { readonly code: string; readonly reason: string; readonly capability: string; readonly message: string }

/** The SDK's typed refusal, with the reason and browser capability it names. Anything else is rethrown. */
function refusalOf(error: unknown): Refusal {
  if (typeof error !== "object" || error === null || !("code" in error) || !("message" in error)) throw error;
  const detail: unknown = "detail" in error ? error.detail : undefined;
  const field = (name: string): string => typeof detail === "object" && detail !== null && name in detail ? String(Reflect.get(detail, name)) : "";
  return { code: String(error.code), reason: field("reason"), capability: field("capability"), message: String(error.message) };
}

const describe = (refused: Refusal): string => `${refused.code}${refused.reason === "" ? "" : ` ${refused.reason}`}${refused.capability === "" ? "" : ` (${refused.capability})`}: ${refused.message}`;

/**
 * For a browser that cannot run modules (WebKit: the module frame has no isolated blob workers): no PGlite code may run, and
 * the refusal must be the SDK's typed `FEATURE_NOT_AVAILABLE`. It can come at either of two points: the VM itself (a
 * browser without what Userspace storage needs, as Playwright's WebKit build on Linux, which has no OPFS) or the start of
 * the module (`wasm-module-isolation-unavailable`, naming the missing capability). The result says which.
 */
export async function refusal(config: SuiteConfig): Promise<readonly ScenarioResult[]> {
  let vm: UserspaceVM | undefined;
  try {
    return await runScenarios([
      ["refusal: the module does not run, and the refusal is FEATURE_NOT_AVAILABLE", async () => {
        const opened = await openVM(config, { workspaceId: "pglite-refusal" }).then(value => ({ value }), (error: unknown) => ({ refused: refusalOf(error) }));
        if ("refused" in opened) {
          expect(opened.refused.code === "FEATURE_NOT_AVAILABLE", describe(opened.refused));
          return `refused at createVM, before any module code: ${describe(opened.refused)}`;
        }
        vm = opened.value;
        const outcome = await spawnModule(vm, pglite, { workspaceId: "pglite-refusal" }).then(() => undefined, (error: unknown) => refusalOf(error));
        expect(outcome !== undefined, "the module started in a browser that should refuse it");
        const refused = outcome ?? { code: "", reason: "", capability: "", message: "" };
        expect(refused.code === "FEATURE_NOT_AVAILABLE" && refused.reason === "wasm-module-isolation-unavailable" && refused.capability !== "", describe(refused));
        const after = await vm.exec({ command: "/bin/sh", args: ["-c", "echo alive"] });
        const out = new TextDecoder().decode(after.stdout).trim();
        expect(after.exit.kind === "exited" && after.exit.code === 0 && out === "alive", `the VM is not usable after the refused start: ${out}`);
        return `refused at spawnModule, the VM still runs programs: ${describe(refused)}`;
      }],
    ]);
  } finally {
    await vm?.dispose();
  }
}
