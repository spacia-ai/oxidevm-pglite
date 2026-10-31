import { createVM, defineImage } from "@oxidevm/sdk";
import type { ExecSpec, ProcessExit, UserspaceVM } from "@oxidevm/sdk";
import type { ScenarioResult, SuiteConfig } from "./protocol";

const decoder = new TextDecoder();

export const describeExit = (exit: ProcessExit): string => exit.kind === "exited" ? `exit ${String(exit.code)}` : `signal ${String(exit.signalNumber)}`;

export interface Run { readonly status: number; readonly stdout: string; readonly stderr: string }

/** Runs a native Linux program in the VM to completion. A signal counts as status -signal. */
export async function run(vm: UserspaceVM, spec: ExecSpec): Promise<Run> {
  const result = await vm.exec({ maxOutputBytes: 4 * 1024 ** 2, ...spec });
  return { status: result.exit.kind === "exited" ? result.exit.code : -result.exit.signalNumber, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

/** Runs Python source with the image's python3 and returns its trimmed standard output; any other outcome is a failure. */
export async function python(vm: UserspaceVM, source: string, env: Readonly<Record<string, string>> = {}): Promise<string> {
  const result = await run(vm, { command: "/usr/bin/python3", args: ["-c", source], env });
  if (result.status !== 0) throw new Error(`python3 exited ${String(result.status)}: ${result.stderr.trim().slice(-1500)}`);
  return result.stdout.trim();
}

export async function sha256(text: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), byte => byte.toString(16).padStart(2, "0")).join("");
}

export interface Failure { readonly code: string; readonly reason: string; readonly message: string }

/** Waits for a call that must fail and describes the failure the way the SDK reports it. */
export async function expectFailure(work: Promise<unknown>): Promise<Failure> {
  try { await work; } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
      const detail: unknown = "detail" in error ? error.detail : undefined;
      const reason = typeof detail === "object" && detail !== null && "reason" in detail ? String(detail.reason) : "";
      return { code: String(error.code), reason, message: String(error.message) };
    }
    throw error;
  }
  throw new Error("Expected the call to fail");
}

export function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** JSON text with the keys of every object in sorted order, so that two values compare by content and not by key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  });
}

export function expectEqual(actual: unknown, expected: unknown, label: string): void {
  const left = canonical(actual), right = canonical(expected);
  if (left !== right) throw new Error(`${label}: expected ${right}, got ${left}`);
}

/** Waits until `check` holds, looking again every quarter second, for at most `seconds`. */
export async function until(check: () => Promise<boolean>, what: string, seconds: number): Promise<void> {
  for (let attempt = 0; attempt < seconds * 4; attempt += 1) {
    if (await check()) return;
    await new Promise(resolve => { setTimeout(resolve, 250); });
  }
  throw new Error(`Gave up waiting for ${what} after ${String(seconds)} s`);
}

export type Scenario = readonly [name: string, run: () => Promise<string>];

/** Runs scenarios one after another, recording each outcome; one failing does not stop the next. `only` narrows the run to the scenarios whose name contains one of its comma-separated parts. */
export async function runScenarios(scenarios: readonly Scenario[], only = "", diagnostics: () => string = () => ""): Promise<readonly ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const [name, scenario] of scenarios) {
    if (only !== "" && !name.startsWith("start:") && !only.split(",").some(part => name.includes(part.trim()))) continue;
    const started = performance.now();
    try {
      const detail = await scenario();
      results.push({ name, ok: true, detail: `${detail} (${((performance.now() - started) / 1000).toFixed(1)} s)` });
    } catch (error: unknown) {
      const extra = diagnostics();
      results.push({ name, ok: false, detail: `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}${extra === "" ? "" : `\n      diagnostics: ${extra}`}` });
    }
    console.log(`scenario ${results[results.length - 1]?.ok === true ? "passed" : "FAILED"}: ${name}`);
  }
  return results;
}

export interface OpenOptions { readonly workspaceId?: string }

/** A Userspace VM on the self-hosted engine and the signed development image the harness serves. */
export function openVM(config: SuiteConfig, options: OpenOptions = {}): Promise<UserspaceVM> {
  const image = defineImage({ mode: "userspace", ...config.image });
  return createVM({
    mode: "userspace", image, memoryMiB: 1536, runtime: { hosting: "self-hosted", baseUrl: `${config.origin}/engine/` }, network: { mode: "local" },
    restorePoint: "none", commandInterceptors: "off", ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
  });
}
