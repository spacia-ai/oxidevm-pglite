// Runs the real-engine suites of the PGlite module in a browser. See harness.ts for what it needs.
//
//   node test/browser/run.ts [core] [crash] [migration] [refusal] [--browser=chromium|firefox|webkit] [--verbose] [--keep] [--only=<text in a scenario name>]
//
// Without suite names, Chromium and Firefox run core, crash and migration; WebKit runs refusal, because the SDK's module
// frame needs blob workers that WebKit does not isolate, so every start there must fail with a typed refusal.
import { BROWSERS, Harness, MissingPrerequisite, isBrowserName, report, writeResults } from "./harness.ts";
import type { BrowserName } from "./harness.ts";
import type { ScenarioResult } from "./page/protocol.ts";

const SUITES = ["core", "crash", "migration", "refusal"] as const;
type Suite = (typeof SUITES)[number];

function isSuite(value: string): value is Suite {
  return SUITES.some(suite => suite === value);
}

function defaultSuites(browser: BrowserName): readonly Suite[] {
  return browser === "webkit" ? ["refusal"] : ["core", "crash", "migration"];
}

/** One page, one suite: a VM per suite, because each suite owns the module and its workspace. */
async function single(harness: Harness, suite: "core" | "migration" | "refusal"): Promise<readonly ScenarioResult[]> {
  const context = await harness.newContext();
  try {
    return await harness.runSuite(await harness.open(context), suite);
  } finally {
    await context.close();
  }
}

/**
 * Seeds a database, ends the page abruptly, and checks in a new page of the same context what the workspace kept.
 * Chromium kills the renderer (`Page.crash`). Firefox and WebKit have no such call in Playwright, so there the page is
 * closed without `beforeunload`: its workers are terminated and no shutdown code of the module or the SDK runs.
 */
async function crash(harness: Harness): Promise<readonly ScenarioResult[]> {
  const context = await harness.newContext();
  try {
    const first = await harness.open(context);
    const seeded = await harness.runSuite(first, "crash-seed");
    if (seeded.some(result => !result.ok)) return seeded;
    if (harness.browserName === "chromium") {
      const session = await context.newCDPSession(first);
      const crashed = first.waitForEvent("crash", { timeout: 30_000 });
      session.send("Page.crash").catch(() => undefined);
      await crashed;
    } else {
      await first.close({ runBeforeUnload: false });
    }
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
  const browser = flags.find(flag => flag.startsWith("--browser="))?.slice("--browser=".length) ?? "chromium";
  if (!isBrowserName(browser)) {
    process.stderr.write(`Unknown browser ${browser}; the browsers are ${BROWSERS.join(", ")}.\n`);
    return 2;
  }
  const unknown = names.filter(name => !isSuite(name));
  if (unknown.length > 0) {
    process.stderr.write(`Unknown suite ${unknown.join(", ")}; the suites are ${SUITES.join(", ")}.\n`);
    return 2;
  }
  const selected = names.length === 0 ? defaultSuites(browser) : SUITES.filter(suite => names.includes(suite));
  let harness: Harness;
  try {
    harness = await Harness.start({ keep: flags.includes("--keep"), verbose: flags.includes("--verbose"), only, browser });
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
      process.stdout.write(`\n== ${suite} (${browser})\n`);
      const outcome = suite === "crash" ? await crash(harness) : await single(harness, suite);
      report(outcome);
      results.push(...outcome);
    }
  } finally {
    await harness.close();
  }
  await writeResults(browser, results);
  const failed = results.filter(result => !result.ok).length;
  process.stdout.write(`\n${String(results.length - failed)} of ${String(results.length)} scenarios passed in ${browser}\n`);
  return failed === 0 && results.length > 0 ? 0 : 1;
}

process.exitCode = await main();
