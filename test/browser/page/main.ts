import { core } from "./core";
import { crashRecover, crashSeed } from "./crash";
import { migration } from "./migration";
import type { ScenarioResult, SuiteConfig } from "./protocol";
import { refusal } from "./refusal";

const suites: Readonly<Record<string, (config: SuiteConfig) => Promise<readonly ScenarioResult[]>>> = {
  core,
  "crash-seed": crashSeed,
  "crash-recover": crashRecover,
  migration,
  refusal,
};

/** The Node-side harness drives this page: it calls `runModuleSuite` with the served locations. */
async function runModuleSuite(config: SuiteConfig): Promise<readonly ScenarioResult[]> {
  const suite = Object.hasOwn(suites, config.suite) ? suites[config.suite] : undefined;
  if (suite === undefined) throw new Error(`There is no suite ${config.suite}`);
  return suite(config);
}

Object.defineProperty(window, "runModuleSuite", { value: runModuleSuite, enumerable: true });
