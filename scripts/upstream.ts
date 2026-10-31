import { createHash } from "node:crypto";
import { Parser } from "tar";
import type { ReadEntry } from "tar";

/** One file that the release mirrors from the upstream package, byte for byte. */
export interface UpstreamFile {
  /** The name it has in `upstream/` and as an artifact. */
  readonly name: string;
  /** Where it is in the package tarball. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface UpstreamLock {
  readonly schemaVersion: 1;
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly license: string;
    readonly tarball: string;
    readonly bytes: number;
    readonly sha256: string;
    /** The registry's own digest of the tarball (npm `dist.integrity`), a SHA-512 in Subresource Integrity form. */
    readonly integrity: string;
  };
  readonly files: readonly UpstreamFile[];
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactly(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const found = Object.keys(value).sort().join(",");
  if (found !== [...keys].sort().join(",")) throw new Error(`${label} must have exactly the keys ${keys.join(", ")}`);
  return value;
}

function text(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== "string" || value === "" || (pattern !== undefined && !pattern.test(value))) throw new Error(`${label} is invalid`);
  return value;
}

function size(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`);
  return value;
}

const HEX = /^[0-9a-f]{64}$/u;
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TARBALL_PATH = /^package\/[A-Za-z0-9._/-]+$/u;

/** Decodes `upstream/lock.json`, which is read from disk and so arrives as `unknown`. */
export function decodeLock(value: unknown): UpstreamLock {
  const lock = exactly(value, ["schemaVersion", "package", "files"], "lock");
  if (lock["schemaVersion"] !== 1) throw new Error("lock.schemaVersion must be 1");
  const pkg = exactly(lock["package"], ["name", "version", "license", "tarball", "bytes", "sha256", "integrity"], "lock.package");
  if (!Array.isArray(lock["files"]) || lock["files"].length === 0) throw new Error("lock.files must list at least one file");
  const files = Array.from<unknown>(lock["files"]).map((entry, index): UpstreamFile => {
    const item = exactly(entry, ["name", "path", "bytes", "sha256"], `lock.files[${String(index)}]`);
    return { name: text(item["name"], "file name", NAME), path: text(item["path"], "file path", TARBALL_PATH), bytes: size(item["bytes"], "file bytes"), sha256: text(item["sha256"], "file sha256", HEX) };
  });
  if (new Set(files.map(file => file.name)).size !== files.length || new Set(files.map(file => file.path)).size !== files.length) throw new Error("lock.files has duplicates");
  return {
    schemaVersion: 1,
    package: {
      name: text(pkg["name"], "package name"), version: text(pkg["version"], "package version"), license: text(pkg["license"], "package license"),
      tarball: text(pkg["tarball"], "package tarball", /^https:\/\/registry\.npmjs\.org\//u), bytes: size(pkg["bytes"], "package bytes"),
      sha256: text(pkg["sha256"], "package sha256", HEX), integrity: text(pkg["integrity"], "package integrity", SRI),
    },
    files,
  };
}

/** Checks a downloaded tarball against the lock: its size, its sha256 and the registry's integrity string. */
export function verifyTarball(bytes: Uint8Array, lock: UpstreamLock): void {
  const { package: pkg } = lock;
  if (bytes.length !== pkg.bytes) throw new Error(`The tarball is ${String(bytes.length)} bytes, the lock says ${String(pkg.bytes)}`);
  if (sha256(bytes) !== pkg.sha256) throw new Error("The tarball's sha256 does not match the lock");
  if (integrity(bytes) !== pkg.integrity) throw new Error("The tarball's integrity does not match the lock");
}

/** Reads the named paths out of a gzipped tarball. */
export async function readEntries(tarball: Uint8Array, paths: readonly string[]): Promise<Map<string, Buffer>> {
  const wanted = new Set(paths), found = new Map<string, Buffer>();
  const parser = new Parser({ strict: true, filter: path => wanted.has(path) });
  const finished = new Promise<void>((resolve, reject) => {
    parser.on("end", () => { resolve(); });
    parser.on("error", (error: unknown) => { reject(error instanceof Error ? error : new Error("The tarball could not be read")); });
  });
  parser.on("entry", (entry: ReadEntry) => {
    const chunks: Buffer[] = [];
    entry.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    entry.on("end", () => { found.set(entry.path, Buffer.concat(chunks)); });
  });
  parser.end(Buffer.from(tarball));
  await finished;
  return found;
}

/** Extracts the locked files from a tarball that already passed `verifyTarball`, checking each one's size and sha256. */
export async function extractFiles(tarball: Uint8Array, lock: UpstreamLock): Promise<Map<string, Buffer>> {
  const entries = await readEntries(tarball, lock.files.map(file => file.path));
  const extracted = new Map<string, Buffer>();
  for (const file of lock.files) {
    const bytes = entries.get(file.path);
    if (bytes === undefined) throw new Error(`The tarball has no ${file.path}`);
    if (bytes.length !== file.bytes) throw new Error(`${file.name} is ${String(bytes.length)} bytes, the lock says ${String(file.bytes)}`);
    if (sha256(bytes) !== file.sha256) throw new Error(`${file.name} does not match the sha256 in the lock`);
    extracted.set(file.name, bytes);
  }
  return extracted;
}

/** The names of locked files that are missing from, or differ in, a directory (given as name to bytes). */
export function differences(present: ReadonlyMap<string, Uint8Array>, lock: UpstreamLock): string[] {
  return lock.files.flatMap(file => {
    const bytes = present.get(file.name);
    if (bytes === undefined) return [`${file.name} is missing`];
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) return [`${file.name} does not match the lock`];
    return [];
  });
}

/**
 * A lock for another version of the package: the same files at the same paths, with the sizes and digests of
 * the new tarball. The registry's `integrity` for it is passed in and checked, so the lock never records a
 * digest that only this machine computed.
 */
export async function buildLock(previous: UpstreamLock, version: string, tarball: Uint8Array, registryIntegrity: string): Promise<UpstreamLock> {
  if (integrity(tarball) !== registryIntegrity) throw new Error("The downloaded tarball does not match the integrity the registry publishes");
  const entries = await readEntries(tarball, previous.files.map(file => file.path));
  const files = previous.files.map((file): UpstreamFile => {
    const bytes = entries.get(file.path);
    if (bytes === undefined) throw new Error(`The tarball has no ${file.path}`);
    return { name: file.name, path: file.path, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const tarballUrl = previous.package.tarball.replace(previous.package.version, version);
  return decodeLock({
    schemaVersion: 1,
    package: { ...previous.package, version, tarball: tarballUrl, bytes: tarball.length, sha256: sha256(tarball), integrity: registryIntegrity },
    files,
  });
}
