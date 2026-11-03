// The shared harness of the real-engine tests. It does what a developer does, then runs the result:
//   1. builds this repository's release with `oxidevm wasm build`;
//   2. installs it into a fresh project with the real CLI (`oxidevm wasm add file:… --yes`), which stages the files and
//      generates the typed handle, and type-checks the page against that handle with the strict flags;
//   3. builds the page with Vite, serves it with the pinned engine and a signed Userspace image, and drives Chromium.
//
//   pnpm test:browser [core] [crash] [migration]
//   OXIDEVM_TEST_USERSPACE_IMAGE=<image reference JSON> OXIDEVM_TEST_USERSPACE_IMAGE_DIR=<bundle dist> pnpm test:browser
//   OXIDEVM_MODULE_FRAME_DIR=<module-frame directory> serves another build of the SDK module frame than the installed one
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";
import { build } from "vite";
import { decodeProjectConfig, getSDKRelease, pinnedEngineCompliance } from "@oxidevm/sdk/image-builder";
import type { ScenarioResult, SuiteConfig } from "./page/protocol.ts";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const CLIENTS_ARCHIVE = join(root, ".cache/postgres-clients.tar.gz");
const SUITE_TIMEOUT_MS = 40 * 60_000;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2024", "module": "ESNext", "moduleResolution": "Bundler", "lib": ["ES2024", "DOM", "DOM.Iterable"],
    "strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true, "noPropertyAccessFromIndexSignature": true,
    "noImplicitOverride": true, "noImplicitReturns": true, "noEmit": true, "skipLibCheck": false, "types": ["emscripten", "node"]
  },
  "include": ["src"]
}
`;

export class MissingPrerequisite extends Error {}

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new MissingPrerequisite(`Set ${name} (${hint}).`);
  return value;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The lock of the native PostgreSQL clients, which are staged by `scripts/stage-postgres-clients.ts` and never committed. */
async function verifiedClients(): Promise<void> {
  const lock: unknown = JSON.parse(await readFile(join(root, "test/postgres-clients.lock.json"), "utf8"));
  const expected: unknown = typeof lock === "object" && lock !== null ? Reflect.get(lock, "sha256") : undefined;
  const bytes = await readFile(CLIENTS_ARCHIVE).catch(() => undefined);
  if (bytes === undefined) throw new MissingPrerequisite(`The native PostgreSQL clients are not staged: run node scripts/stage-postgres-clients.ts (needs Docker), or copy a staged tarball to ${CLIENTS_ARCHIVE}.`);
  assert.equal(sha256(bytes), expected, `${CLIENTS_ARCHIVE} does not match test/postgres-clients.lock.json`);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".html": "text/html", ".css": "text/css",
};

interface Layout {
  readonly project: string;
  readonly dist: string;
  readonly engineDir: string;
  readonly complianceDir: string | undefined;
  readonly imageDir: string;
  readonly imagePrefix: string;
  /** The SDK's module frame (engine ADR 0028) and the headers its `frame.json` says the frame must be served with. */
  readonly moduleFrame: { readonly dir: string; readonly headers: readonly (readonly [string, string])[] };
}

/** The installed SDK's module frame; `OXIDEVM_MODULE_FRAME_DIR` serves another build of it (an SDK checkout with a fix). */
const MODULE_FRAME = process.env["OXIDEVM_MODULE_FRAME_DIR"] ?? join(root, "node_modules/@oxidevm/sdk/assets/module-frame");

/** The response headers `frame.json` prescribes for the module frame's files; without them the frame's CSP is missing. */
async function moduleFrameHeaders(): Promise<readonly (readonly [string, string])[]> {
  const text = await readFile(join(MODULE_FRAME, "frame.json"), "utf8").catch(() => undefined);
  if (text === undefined) throw new MissingPrerequisite(`${MODULE_FRAME}/frame.json is missing: the installed @oxidevm/sdk has no module frame (SDK 0.0.10 and later have one).`);
  const parsed: unknown = JSON.parse(text);
  const headers: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "headers") : undefined;
  assert(typeof headers === "object" && headers !== null && !Array.isArray(headers), "frame.json has no headers object");
  return Object.entries(headers).map(([name, value]: [string, unknown]) => {
    assert(typeof value === "string", `frame.json header ${name} is not a string`);
    return [name, value] as const;
  });
}

export interface HarnessOptions { readonly keep: boolean; readonly verbose: boolean; readonly only: string }

export class Harness {
  readonly #browser: Browser;
  readonly #server: Server;
  readonly #output: string;
  readonly #config: Omit<SuiteConfig, "suite" | "only">;
  readonly #options: HarnessOptions;

  private constructor(browser: Browser, server: Server, output: string, config: Omit<SuiteConfig, "suite" | "only">, options: HarnessOptions) {
    this.#browser = browser;
    this.#server = server;
    this.#output = output;
    this.#config = config;
    this.#options = options;
  }

  /** Builds, installs, type-checks, bundles and serves everything; fails early and clearly when a prerequisite is missing. */
  static async start(options: HarnessOptions): Promise<Harness> {
    const imageFile = required("OXIDEVM_TEST_USERSPACE_IMAGE", "an image reference JSON");
    const imageDir = required("OXIDEVM_TEST_USERSPACE_IMAGE_DIR", "the directory of the image bundle");
    const cli = join(root, "node_modules/@oxidevm/cli/dist/bin.js");
    const engineId = getSDKRelease().engineRelease.replace(/^sha256:/u, "");
    const engineDir = process.env["OXIDEVM_ENGINE_DIR"] ?? join(homedir(), ".cache/oxidevm/engine", engineId);
    const compliance = pinnedEngineCompliance();
    const complianceDir = compliance === null ? undefined : process.env["OXIDEVM_ENGINE_COMPLIANCE_DIR"] ?? join(homedir(), ".cache/oxidevm/engine/compliance", compliance.sha256);
    for (const path of [cli, engineDir, imageDir, ...(complianceDir === undefined ? [] : [complianceDir]), join(root, "node_modules/@electric-sql/pglite/dist/pglite.wasm")]) {
      await stat(path).catch(() => { throw new MissingPrerequisite(`${path} is missing.`); });
    }
    await verifiedClients();

    const output = await mkdtemp(join(tmpdir(), "oxidevm-pglite-browser-"));
    try {
      await execute(process.execPath, [cli, "wasm", "build"], { cwd: root, maxBuffer: 16 * 1024 ** 2 });
      const project = join(output, "project");
      await Harness.#install(project, cli, root);
      const dist = join(output, "dist");
      await Harness.#bundle(project, dist, options);

      const referenceJSON: unknown = JSON.parse(await readFile(imageFile, "utf8"));
      const reference = decodeProjectConfig({ mode: "userspace", image: referenceJSON }).image;
      assert(reference !== undefined, "The image reference JSON is not a signed image reference");
      const moduleFrame = { dir: MODULE_FRAME, headers: await moduleFrameHeaders() };
      const layout: Layout = { project, dist, engineDir, complianceDir, imageDir, imagePrefix: `${dirname(new URL(reference.manifestUrl, "http://x").pathname)}/`, moduleFrame };
      const server = createServer((request, response) => { Harness.#serve(layout, request.url ?? "/", response); });
      await new Promise<void>(ready => { server.listen(0, "127.0.0.1", ready); });
      const address = server.address();
      assert(address !== null && typeof address !== "string");
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const browser = await chromium.launch({ headless: true, args: ["--js-flags=--experimental-wasm-return-call"] });
      return new Harness(browser, server, output, {
        origin,
        image: { manifestUrl: new URL(reference.manifestUrl, origin).href, manifestSHA256: reference.manifestSHA256, trust: reference.trust },
        clientsURL: `${origin}/clients/postgres-clients.tar.gz`,
        legacyURLs: { wasm: `${origin}/legacy/pglite.wasm`, initdb: `${origin}/legacy/initdb.wasm`, data: `${origin}/legacy/pglite.data` },
      }, options);
    } catch (error: unknown) {
      await rm(output, { recursive: true, force: true });
      throw error;
    }
  }

  /** A fresh project that uses the release the way an application does: installed with the real CLI from a `file:` source. */
  static async #install(project: string, cli: string, repository: string): Promise<void> {
    await mkdir(join(project, "src"), { recursive: true });
    await mkdir(join(project, "node_modules/@oxidevm"), { recursive: true });
    await mkdir(join(project, "node_modules/@electric-sql"), { recursive: true });
    await mkdir(join(project, "node_modules/@types"), { recursive: true });
    await symlink(join(repository, "node_modules/@oxidevm/sdk"), join(project, "node_modules/@oxidevm/sdk"));
    await symlink(join(repository, "node_modules/@electric-sql/pglite"), join(project, "node_modules/@electric-sql/pglite"));
    // PGlite's published declarations use the Emscripten and Node.js ambient types without declaring them.
    for (const name of ["emscripten", "node"]) await symlink(join(repository, "node_modules/@types", name), join(project, "node_modules/@types", name));
    await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "pglite-qualification", private: true, type: "module" }, null, 2)}\n`);
    await writeFile(join(project, "tsconfig.json"), TSCONFIG);
    await writeFile(join(project, "index.html"), '<!doctype html>\n<meta charset="utf-8">\n<title>PGlite module qualification</title>\n<script type="module" src="/src/main.ts"></script>\n');
    for (const name of await readdir(join(repository, "test/browser/page"))) {
      if (name === "oxidevm.modules.generated.ts") continue; // the real generated file takes its place
      await cp(join(repository, "test/browser/page", name), join(project, "src", name));
    }
    await cp(join(repository, "dist"), join(project, "vendor/pglite"), { recursive: true });
    const { stdout } = await execute(process.execPath, [cli, "wasm", "add", "file:vendor/pglite", "--yes", "--project", project, "--json"], { cwd: project });
    assert(stdout.includes('"kind":"result"') && stdout.includes('"status":"added"'), `wasm add: ${stdout}`);
    const doctor = await execute(process.execPath, [cli, "wasm", "doctor", "--project", project, "--json"], { cwd: project }).catch((error: unknown) => ({ stdout: error instanceof Error && "stdout" in error ? String(error.stdout) : String(error) }));
    assert(doctor.stdout.includes('"result":"passed"'), `wasm doctor should pass on a freshly installed project: ${doctor.stdout.slice(0, 600)}`);
    // The page, type-checked against the handle generated from the real release.
    await execute(process.execPath, [join(repository, "node_modules/typescript/bin/tsc"), "-p", join(project, "tsconfig.json")], { cwd: project, maxBuffer: 16 * 1024 ** 2 }).catch((error: unknown) => {
      throw new Error(`the page does not type-check against the generated handle:\n${error instanceof Error && "stdout" in error ? String(error.stdout) : String(error)}`, { cause: error });
    });
  }

  static async #bundle(project: string, dist: string, options: HarnessOptions): Promise<void> {
    // The staged files are emitted as files, as real modules (larger than a bundler's inline limit) are.
    await build({ root: project, configFile: false, logLevel: options.verbose ? "info" : "warn", base: "/page/", build: { outDir: dist, emptyOutDir: true, target: "esnext", assetsInlineLimit: 0 }, worker: { format: "es" } });
    const emitted = (await readdir(dist, { recursive: true })).filter(name => /(?:adapter|pglite|initdb)/u.test(name));
    assert(emitted.some(name => name.endsWith(".wasm")) && emitted.some(name => name.includes("adapter")), `the build did not emit the staged module files; it emitted: ${(await readdir(dist, { recursive: true })).join(", ")}`);
  }

  static #serve(layout: Layout, url: string, response: ServerResponse): void {
    const path = new URL(url, "http://localhost").pathname;
    for (const [name, value] of [["Cross-Origin-Opener-Policy", "same-origin"], ["Cross-Origin-Embedder-Policy", "require-corp"], ["Cross-Origin-Resource-Policy", "same-origin"]] as const) response.setHeader(name, value);
    const dist = path.slice("/page/".length);
    // The module frame lives beside the engine assets (`<runtime.baseUrl>module-frame/`), served with frame.json's headers.
    if (path.startsWith("/engine/module-frame/")) for (const [name, value] of layout.moduleFrame.headers) response.setHeader(name, value);
    const frameFile = path.slice("/engine/module-frame/".length) || "index.html";
    const file = path.startsWith("/engine/module-frame/") ? (["index.html", "broker.js", "runner.js"].includes(frameFile) ? join(layout.moduleFrame.dir, frameFile) : undefined)
      : path.startsWith("/engine/compliance/") && layout.complianceDir !== undefined ? join(layout.complianceDir, path.slice("/engine/compliance/".length + 65))
      : path.startsWith("/engine/") ? join(layout.engineDir, path.slice("/engine/".length))
      : path.startsWith(layout.imagePrefix) ? join(layout.imageDir, path.slice(layout.imagePrefix.length))
      : path === "/clients/postgres-clients.tar.gz" ? CLIENTS_ARCHIVE
      : path.startsWith("/legacy/") ? join(root, "node_modules/@electric-sql/pglite/dist", path.slice("/legacy/".length))
      : path.startsWith("/page/") ? join(layout.dist, dist === "" ? "index.html" : dist)
      : undefined;
    response.setHeader("Content-Type", CONTENT_TYPES[extname(path === "/engine/module-frame/" ? "index.html" : path)] ?? "application/octet-stream");
    if (file === undefined) { response.writeHead(404); response.end(); return; }
    const stream = createReadStream(file);
    stream.on("error", () => { process.stderr.write(`404: ${path}\n`); response.writeHead(404); response.end(); });
    stream.pipe(response);
  }

  /** A browser context of its own: storage (OPFS, IndexedDB) is shared by its pages and by nothing else. */
  newContext(): Promise<BrowserContext> {
    return this.#browser.newContext();
  }

  async open(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();
    page.setDefaultTimeout(SUITE_TIMEOUT_MS);
    page.on("console", message => { if (this.#options.verbose) process.stderr.write(`browser: ${message.text()}\n`); });
    page.on("pageerror", error => { process.stderr.write(`page error: ${error.message}\n`); });
    await page.goto(`${this.#config.origin}/page/index.html`);
    return page;
  }

  /** Runs one suite in a page and returns what its scenarios reported. */
  async runSuite(page: Page, suite: string): Promise<readonly ScenarioResult[]> {
    const work = page.evaluate(async (input: SuiteConfig) => {
      const run: unknown = Reflect.get(window, "runModuleSuite");
      if (typeof run !== "function") throw new Error("The page did not register runModuleSuite");
      const outcome: unknown = await Reflect.apply(run, undefined, [input]);
      return outcome;
    }, { ...this.#config, suite, only: this.#options.only });
    const expired = new Promise<never>((_resolve, reject) => { setTimeout(() => { reject(new Error(`Suite ${suite} did not finish within ${String(SUITE_TIMEOUT_MS / 60_000)} minutes`)); }, SUITE_TIMEOUT_MS).unref(); });
    return decodeResults(await Promise.race([work, expired]));
  }

  async close(): Promise<void> {
    await this.#browser.close();
    this.#server.close();
    if (!this.#options.keep) await rm(this.#output, { recursive: true, force: true });
    else process.stderr.write(`kept ${this.#output}\n`);
  }
}

function decodeResults(value: unknown): readonly ScenarioResult[] {
  assert(Array.isArray(value), "The page returned no scenario results");
  return Array.from<unknown>(value).map(entry => {
    assert(typeof entry === "object" && entry !== null, "A scenario result is not an object");
    const name: unknown = Reflect.get(entry, "name"), ok: unknown = Reflect.get(entry, "ok"), detail: unknown = Reflect.get(entry, "detail");
    assert(typeof name === "string" && typeof ok === "boolean" && typeof detail === "string", "A scenario result has the wrong fields");
    return { name, ok, detail };
  });
}

/** Prints results the way the sample's tests did, and returns how many failed. */
export function report(results: readonly ScenarioResult[]): number {
  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed += 1;
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n      ${result.detail}\n`);
  }
  return failed;
}

export async function writeResults(results: readonly ScenarioResult[]): Promise<void> {
  await mkdir(join(root, ".cache/test-results"), { recursive: true });
  await writeFile(join(root, ".cache/test-results/browser.json"), `${JSON.stringify({ results }, null, 2)}\n`);
}
