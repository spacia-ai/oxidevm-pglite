import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const GUEST = join(dirname(fileURLToPath(import.meta.url)), "../../guest");

export interface PythonRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a guest script with the machine's python3, as the VM's `/usr/bin/python3` would, feeds it `input` and
 * waits for it to exit. The native tests of the guest scripts use it; nothing is mocked.
 */
export function runPython(args: readonly string[], input: string, environment: Readonly<Record<string, string>> = {}): Promise<PythonRun> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-u", "-B", ...args], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env["PATH"] ?? "", PYTHONDONTWRITEBYTECODE: "1", ...environment } });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => { resolve({ code, stdout, stderr }); });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
