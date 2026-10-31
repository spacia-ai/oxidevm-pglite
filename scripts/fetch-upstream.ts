// Fetches the WebAssembly files this module mirrors from the PGlite npm package, and checks them against upstream/lock.json.
//
//   node scripts/fetch-upstream.ts                  download the tarball, verify it and write upstream/*
//   node scripts/fetch-upstream.ts --tarball FILE   use a local copy of the tarball instead of the network
//   node scripts/fetch-upstream.ts --verify         check the files already in upstream/ (no network)
//   node scripts/fetch-upstream.ts --update VERSION write a lock for another version (network); review the diff
//
// The release carries these files unmodified, so the lock is the only thing that decides what they are.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLock, decodeLock, differences, extractFiles, verifyTarball } from "./upstream.ts";
import type { UpstreamLock } from "./upstream.ts";

export interface Environment {
  /** The repository root: `upstream/` is below it. */
  readonly root: string;
  readonly fetch: (url: string, init: { readonly signal: AbortSignal }) => Promise<Response>;
  readonly out: (line: string) => void;
}

const FETCH_TIMEOUT_MS = 120_000;
const VERSION = /^\d+\.\d+\.\d+$/u;

async function readLock(root: string): Promise<UpstreamLock> {
  const parsed: unknown = JSON.parse(await readFile(join(root, "upstream/lock.json"), "utf8"));
  return decodeLock(parsed);
}

async function download(environment: Environment, url: string): Promise<Uint8Array> {
  const response = await environment.fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${url} answered HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Writes a file so that a reader never sees half of it. */
async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.partial`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

async function verifyDirectory(environment: Environment, lock: UpstreamLock): Promise<void> {
  const present = new Map<string, Uint8Array>();
  for (const file of lock.files) {
    const bytes = await readFile(join(environment.root, "upstream", file.name)).catch(() => undefined);
    if (bytes !== undefined) present.set(file.name, bytes);
  }
  const problems = differences(present, lock);
  if (problems.length > 0) throw new Error(`upstream/ does not match the lock:\n  ${problems.join("\n  ")}\nRun: node scripts/fetch-upstream.ts`);
  environment.out(`upstream/ matches the lock for ${lock.package.name}@${lock.package.version} (${String(lock.files.length)} files)`);
}

/** The integrity string the registry publishes for a version of the package. */
async function registryIntegrity(environment: Environment, name: string, version: string): Promise<string> {
  const response = await environment.fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/${version}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The registry answered HTTP ${String(response.status)} for ${name}@${version}`);
  const document: unknown = await response.json();
  const dist: unknown = typeof document === "object" && document !== null ? Reflect.get(document, "dist") : undefined;
  const value: unknown = typeof dist === "object" && dist !== null ? Reflect.get(dist, "integrity") : undefined;
  if (typeof value !== "string") throw new Error("The registry did not publish an integrity for that version");
  return value;
}

export async function run(argv: readonly string[], environment: Environment): Promise<void> {
  const lock = await readLock(environment.root);
  const [option, value] = argv;
  if (option === "--verify") { await verifyDirectory(environment, lock); return; }
  if (option === "--update") {
    if (value === undefined || !VERSION.test(value)) throw new Error("Usage: --update VERSION");
    const tarball = lock.package.tarball.replace(lock.package.version, value);
    const bytes = await download(environment, tarball);
    const updated = await buildLock(lock, value, bytes, await registryIntegrity(environment, lock.package.name, value));
    await writeFile(join(environment.root, "upstream/lock.json"), `${JSON.stringify(updated, null, 2)}\n`);
    environment.out(`Wrote upstream/lock.json for ${updated.package.name}@${value}. Review the diff, then run this script without options.`);
    return;
  }
  if (option !== undefined && option !== "--tarball") throw new Error(`Unknown option ${option}`);
  const bytes = option === "--tarball" ? new Uint8Array(await readFile(value ?? "")) : await download(environment, lock.package.tarball);
  verifyTarball(bytes, lock);
  const files = await extractFiles(bytes, lock);
  await mkdir(join(environment.root, "upstream"), { recursive: true });
  for (const [name, content] of files) await writeAtomically(join(environment.root, "upstream", name), content);
  environment.out(`Wrote ${String(files.size)} files from ${lock.package.name}@${lock.package.version} to upstream/`);
}

if (import.meta.main) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  run(process.argv.slice(2), { root, fetch: (url, init) => fetch(url, init), out: line => { process.stdout.write(`${line}\n`); } }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
