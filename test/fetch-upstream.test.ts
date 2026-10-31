import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../scripts/fetch-upstream.ts";
import { isRecord } from "../src/decode.ts";
import type { Environment } from "../scripts/fetch-upstream.ts";
import { buildLock, decodeLock, differences, extractFiles, integrity, sha256, verifyTarball } from "../scripts/upstream.ts";
import type { UpstreamLock } from "../scripts/upstream.ts";

let work = "";
beforeEach(() => { work = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-upstream-")); });
afterEach(() => { fs.rmSync(work, { recursive: true, force: true }); });

/** Builds a gzipped tarball with the given files below `package/`, the way `npm pack` lays one out. */
async function pack(files: Readonly<Record<string, string | Uint8Array>>): Promise<Uint8Array> {
  const source = fs.mkdtempSync(path.join(work, "src-"));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(source, "package", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const chunks: Buffer[] = [];
  const stream = tar.create({ gzip: true, cwd: source, portable: true }, ["package"]);
  stream.on("data", (chunk: Buffer) => { chunks.push(chunk); });
  await new Promise<void>((resolve, reject) => { stream.on("end", resolve); stream.on("error", reject); });
  return Buffer.concat(chunks);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

const FILES = { "dist/a.wasm": Uint8Array.of(0, 97, 115, 109), "dist/b.data": "data", LICENSE: "license text", "dist/ignored.txt": "not locked" };

function lockFor(tarball: Uint8Array, version = "1.0.0"): UpstreamLock {
  const lock: UpstreamLock = {
    schemaVersion: 1,
    package: { name: "@scope/pkg", version, license: "Apache-2.0", tarball: `https://registry.npmjs.org/@scope/pkg/-/pkg-${version}.tgz`, bytes: tarball.length, sha256: sha256(tarball), integrity: integrity(tarball) },
    files: [
      { name: "a.wasm", path: "package/dist/a.wasm", bytes: 4, sha256: sha256(Uint8Array.of(0, 97, 115, 109)) },
      { name: "b.data", path: "package/dist/b.data", bytes: 4, sha256: sha256(new TextEncoder().encode("data")) },
      { name: "LICENSE", path: "package/LICENSE", bytes: 12, sha256: sha256(new TextEncoder().encode("license text")) },
    ],
  };
  return decodeLock(JSON.parse(JSON.stringify(lock)));
}

describe("the committed lock", () => {
  it("decodes and names the files the manifest ships", () => {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../upstream/lock.json"), "utf8"));
    const lock = decodeLock(parsed);
    expect(lock.package).toMatchObject({ name: "@electric-sql/pglite", version: "0.5.14", license: "Apache-2.0" });
    expect(lock.files.map(file => file.name)).toEqual(["pglite.wasm", "initdb.wasm", "pglite.data", "PGLITE-LICENSE"]);
  });
});

describe("decodeLock", () => {
  async function valid(): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(JSON.stringify(lockFor(await pack(FILES))));
    return asRecord(parsed);
  }

  it("refuses anything that is not exactly a lock", async () => {
    const base = await valid();
    const pkg = asRecord(base["package"]);
    const files = Array.from<unknown>(Array.isArray(base["files"]) ? base["files"] : []).map(asRecord);
    const cases: [string, unknown][] = [
      ["not an object", []],
      ["extra key", { ...base, extra: 1 }],
      ["missing key", { schemaVersion: 1, package: pkg }],
      ["schema version", { ...base, schemaVersion: 2 }],
      ["no files", { ...base, files: [] }],
      ["file extra key", { ...base, files: [{ ...files[0], extra: 1 }] }],
      ["short sha256", { ...base, files: [{ ...files[0], sha256: "abc" }] }],
      ["upper-case sha256", { ...base, files: [{ ...files[0], sha256: "A".repeat(64) }] }],
      ["path outside the package", { ...base, files: [{ ...files[0], path: "../etc/passwd" }] }],
      ["name with a slash", { ...base, files: [{ ...files[0], name: "dir/a.wasm" }] }],
      ["negative size", { ...base, files: [{ ...files[0], bytes: -1 }] }],
      ["duplicate name", { ...base, files: [files[0], { ...files[1], name: files[0]?.["name"] }] }],
      ["duplicate path", { ...base, files: [files[0], { ...files[1], path: files[0]?.["path"] }] }],
      ["tarball elsewhere", { ...base, package: { ...pkg, tarball: "https://evil.example/pkg.tgz" } }],
      ["bad integrity", { ...base, package: { ...pkg, integrity: "sha1-abc" } }],
      ["package extra key", { ...base, package: { ...pkg, extra: 1 } }],
    ];
    for (const [label, value] of cases) expect(() => decodeLock(value), label).toThrow();
    expect(() => decodeLock(base)).not.toThrow();
  });
});

describe("verifyTarball", () => {
  it("accepts the locked tarball and refuses any other", async () => {
    const tarball = await pack(FILES), lock = lockFor(tarball);
    expect(() => { verifyTarball(tarball, lock); }).not.toThrow();
    const longer = Uint8Array.from([...tarball, 0]);
    expect(() => { verifyTarball(longer, lock); }).toThrow(/bytes, the lock says/u);
    const flipped = Uint8Array.from(tarball);
    flipped[100] = (flipped[100] ?? 0) ^ 1;
    expect(() => { verifyTarball(flipped, lock); }).toThrow("sha256 does not match");
    const otherIntegrity = { ...lock, package: { ...lock.package, integrity: integrity(new Uint8Array(1)) } };
    expect(() => { verifyTarball(tarball, otherIntegrity); }).toThrow("integrity does not match");
  });
});

describe("extractFiles", () => {
  it("returns exactly the locked files and ignores the rest of the package", async () => {
    const tarball = await pack(FILES), lock = lockFor(tarball);
    const files = await extractFiles(tarball, lock);
    expect([...files.keys()]).toEqual(["a.wasm", "b.data", "LICENSE"]);
    expect([...files.get("a.wasm") ?? []]).toEqual([0, 97, 115, 109]);
    expect(files.get("LICENSE")?.toString()).toBe("license text");
  });

  it("refuses a file that is missing, resized or altered", async () => {
    const tarball = await pack(FILES), lock = lockFor(tarball);
    const without = await pack({ "dist/a.wasm": Uint8Array.of(0, 97, 115, 109), LICENSE: "license text" });
    await expect(extractFiles(without, lock)).rejects.toThrow("The tarball has no package/dist/b.data");
    const resized = await pack({ ...FILES, "dist/b.data": "data!" });
    await expect(extractFiles(resized, lock)).rejects.toThrow("b.data is 5 bytes, the lock says 4");
    const altered = await pack({ ...FILES, "dist/b.data": "dota" });
    await expect(extractFiles(altered, lock)).rejects.toThrow("b.data does not match the sha256 in the lock");
  });
});

describe("differences", () => {
  it("lists missing and changed files", async () => {
    const lock = lockFor(await pack(FILES));
    const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(differences(new Map([["a.wasm", Uint8Array.of(0, 97, 115, 109)], ["b.data", enc("data")], ["LICENSE", enc("license text")]]), lock)).toEqual([]);
    expect(differences(new Map([["a.wasm", Uint8Array.of(0, 97, 115, 109)], ["b.data", enc("dota")]]), lock)).toEqual(["b.data does not match the lock", "LICENSE is missing"]);
    expect(differences(new Map([["a.wasm", Uint8Array.of(0, 97, 115, 109, 1)]]), lock)[0]).toBe("a.wasm does not match the lock");
  });
});

describe("buildLock", () => {
  it("records the new version's sizes and digests, and the registry's integrity", async () => {
    const first = await pack(FILES), lock = lockFor(first);
    const next = await pack({ ...FILES, "dist/b.data": "newer data" });
    const updated = await buildLock(lock, "1.0.1", next, integrity(next));
    expect(updated.package).toMatchObject({ version: "1.0.1", tarball: "https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.1.tgz", bytes: next.length, sha256: sha256(next), integrity: integrity(next) });
    expect(updated.files.find(file => file.name === "b.data")).toMatchObject({ bytes: 10, sha256: sha256(new TextEncoder().encode("newer data")) });
    expect(updated.files.find(file => file.name === "a.wasm")?.sha256).toBe(lock.files[0]?.sha256);
  });

  it("refuses a tarball that is not the one the registry publishes", async () => {
    const tarball = await pack(FILES), lock = lockFor(tarball);
    await expect(buildLock(lock, "1.0.1", tarball, integrity(new Uint8Array(3)))).rejects.toThrow("does not match the integrity the registry publishes");
  });
});

describe("fetch-upstream", () => {
  function repository(tarball: Uint8Array, lock?: UpstreamLock): { root: string; environment: Environment; lines: string[]; requests: string[] } {
    const root = fs.mkdtempSync(path.join(work, "repo-"));
    fs.mkdirSync(path.join(root, "upstream"));
    fs.writeFileSync(path.join(root, "upstream/lock.json"), JSON.stringify(lock ?? lockFor(tarball)));
    const lines: string[] = [], requests: string[] = [];
    const environment: Environment = {
      root,
      out: line => { lines.push(line); },
      fetch: (url) => {
        requests.push(url);
        if (url.endsWith(".tgz")) return Promise.resolve(new Response(Buffer.from(tarball)));
        return Promise.resolve(Response.json({ dist: { integrity: integrity(tarball) } }));
      },
    };
    return { root, environment, lines, requests };
  }

  it("downloads, verifies and writes the locked files into upstream/", async () => {
    const tarball = await pack(FILES);
    const { root, environment, lines, requests } = repository(tarball);
    await run([], environment);
    expect(requests).toEqual(["https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz"]);
    expect(fs.readFileSync(path.join(root, "upstream/LICENSE"), "utf8")).toBe("license text");
    expect(fs.readdirSync(path.join(root, "upstream")).sort()).toEqual(["LICENSE", "a.wasm", "b.data", "lock.json"]);
    expect(lines).toEqual(["Wrote 3 files from @scope/pkg@1.0.0 to upstream/"]);
    await run(["--verify"], environment);
    expect(lines[1]).toBe("upstream/ matches the lock for @scope/pkg@1.0.0 (3 files)");
  });

  it("writes nothing when the download is not the locked tarball", async () => {
    const tarball = await pack(FILES);
    const { root, environment } = repository(await pack({ ...FILES, "dist/b.data": "tampered" }), lockFor(tarball));
    await expect(run([], environment)).rejects.toThrow(/bytes, the lock says|sha256 does not match/u);
    expect(fs.readdirSync(path.join(root, "upstream"))).toEqual(["lock.json"]);
  });

  it("uses a local tarball without the network", async () => {
    const tarball = await pack(FILES);
    const { root, environment, requests } = repository(tarball);
    const local = path.join(work, "local.tgz");
    fs.writeFileSync(local, tarball);
    await run(["--tarball", local], environment);
    expect(requests).toEqual([]);
    expect(fs.existsSync(path.join(root, "upstream/a.wasm"))).toBe(true);
  });

  it("reports mirrored files that were changed after the fetch", async () => {
    const tarball = await pack(FILES);
    const { root, environment } = repository(tarball);
    await run([], environment);
    fs.writeFileSync(path.join(root, "upstream/a.wasm"), "changed");
    fs.rmSync(path.join(root, "upstream/b.data"));
    await expect(run(["--verify"], environment)).rejects.toThrow(/a\.wasm does not match the lock[\s\S]*b\.data is missing/u);
  });

  it("updates the lock to another version using the registry's integrity", async () => {
    const tarball = await pack(FILES);
    const { root, environment, requests, lines } = repository(tarball);
    await run(["--update", "1.0.0"], environment);
    expect(requests).toEqual(["https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz", "https://registry.npmjs.org/@scope%2fpkg/1.0.0"]);
    expect(decodeLock(JSON.parse(fs.readFileSync(path.join(root, "upstream/lock.json"), "utf8"))).package.version).toBe("1.0.0");
    expect(lines[0]).toContain("Wrote upstream/lock.json");
  });

  it("refuses unknown options and malformed versions", async () => {
    const { environment } = repository(await pack(FILES));
    await expect(run(["--frobnicate"], environment)).rejects.toThrow("Unknown option --frobnicate");
    await expect(run(["--update", "latest"], environment)).rejects.toThrow("Usage: --update VERSION");
    await expect(run(["--update"], environment)).rejects.toThrow("Usage: --update VERSION");
  });

  it("fails when the registry does not answer", async () => {
    const tarball = await pack(FILES);
    const { environment } = repository(tarball);
    const down: Environment = { ...environment, fetch: () => Promise.resolve(new Response("", { status: 503 })) };
    await expect(run([], down)).rejects.toThrow("answered HTTP 503");
  });
});
