// Runs the real-engine suites of the PGlite module in Chromium. See harness.ts for what it needs.
//
//   node test/browser/run.ts [core] [crash] [migration] [--verbose] [--keep] [--only=<text in a scenario name>]
import { Harness, MissingPrerequisite, report, writeResults } from "./harness.ts";
import type { ScenarioResult } from "./page/protocol.ts";

const SUITES = ["core", "crash", "migration"] as const;
type Suite = (typeof SUITES)[number];

function isSuite(value: string): value is Suite {
  return SUITES.some(suite => suite === value);
}

/** One page, one suite: a VM per suite, because each suite owns the module and its workspace. */
async function single(harness: Harness, suite: "core" | "migration"): Promise<readonly ScenarioResult[]> {
  const context = await harness.newContext();
  try {
    return await harness.runSuite(await harness.open(context), suite);
  } finally {
    await context.close();
  }
}

/** Seeds a database, kills the renderer, and checks in a new page of the same context what the workspace kept. */
async function crash(harness: Harness): Promise<readonly ScenarioResult[]> {
  const context = await harness.newContext();
  try {
    const first = await harness.open(context);
    const seeded = await harness.runSuite(first, "crash-seed");
    if (seeded.some(result => !result.ok)) return seeded;
    const session = await context.newCDPSession(first);
    const crashed = first.waitForEvent("crash", { timeout: 30_000 });
    session.send("Page.crash").catch(() => undefined);
    await crashed;
    const recovered = await harness.runSuite(await harness.open(context), "crash-recover");
    return [...seeded, ...recovered];
  } finally {
    await context.close();
  }
}

async function main(): Promise<number> {
  const flags = process.argv.slice(2);
  const names = flags.filter(flag => !flag.startsWith("--"));
  const only = flags.find(flag => flag.startsWith("--only="))?.slice("--only=".length) ?? "";
  const unknown = names.filter(name => !isSuite(name));
  if (unknown.length > 0) {
    process.stderr.write(`Unknown suite ${unknown.join(", ")}; the suites are ${SUITES.join(", ")}.\n`);
    return 2;
  }
  const selected = names.length === 0 ? SUITES : SUITES.filter(suite => names.includes(suite));
  let harness: Harness;
  try {
    harness = await Harness.start({ keep: flags.includes("--keep"), verbose: flags.includes("--verbose"), only });
  } catch (error: unknown) {
    if (error instanceof MissingPrerequisite) {
      process.stderr.write(`${error.message}\n`);
      return 2;
    }
    throw error;
  }
  const results: ScenarioResult[] = [];
  try {
    for (const suite of selected) {
      process.stdout.write(`\n== ${suite}\n`);
      const outcome = suite === "crash" ? await crash(harness) : await single(harness, suite);
      report(outcome);
      results.push(...outcome);
    }
  } finally {
    await harness.close();
  }
  await writeResults(results);
  const failed = results.filter(result => !result.ok).length;
  process.stdout.write(`\n${String(results.length - failed)} of ${String(results.length)} scenarios passed\n`);
  return failed === 0 && results.length > 0 ? 0 : 1;
}

process.exitCode = await main();
