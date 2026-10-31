import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LinuxError } from "@oxidevm/sdk/js-process";
import { kit } from "@oxidevm/sdk/wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGuestFiles } from "../src/guest-files.ts";
import type { GuestFileHost } from "../src/guest-files.ts";
import { createNodeFiles } from "./support/node-files.ts";

let base = "", directory = "";
let writes: string[];
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pglite-guest-files-")));
  directory = path.join(base, "_oxidevm");
  writes = [];
});
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const artifacts = new Map([["one.py", "print('one')\n"], ["two.py", "print('two')\n"]]);
const files = (): { artifact: string; to: string; mode: number }[] => [
  { artifact: "one.py", to: path.join(directory, "one.py"), mode: 0o644 },
  { artifact: "two.py", to: path.join(directory, "sub-two.py"), mode: 0o600 },
];

function host(): GuestFileHost {
  const { files: nodeFiles } = createNodeFiles();
  return {
    fs: { ...nodeFiles, writeFile(target, bytes) { writes.push(String(target)); nodeFiles.writeFile(target, bytes); } },
    artifacts: { bytes: name => { const text = artifacts.get(name); return text === undefined ? Promise.reject(new Error(`no artifact ${name}`)) : Promise.resolve(encode(text)); } },
    errno: kit.errno,
    directory,
    unique: () => "tmp",
  };
}

const read = (name: string): string => fs.readFileSync(path.join(directory, name), "utf8");
const mode = (name: string): number => fs.statSync(path.join(directory, name)).mode & 0o777;

describe("ensureGuestFiles", () => {
  it("creates the directory and writes every file with its pinned content and mode", async () => {
    await ensureGuestFiles(host(), files());
    expect(read("one.py")).toBe("print('one')\n");
    expect(read("sub-two.py")).toBe("print('two')\n");
    expect(mode("one.py")).toBe(0o644);
    expect(mode("sub-two.py")).toBe(0o600);
    expect(fs.readdirSync(directory).sort()).toEqual(["one.py", "sub-two.py"]);
  });

  it("leaves files that already hold the pinned content alone", async () => {
    await ensureGuestFiles(host(), files());
    writes.length = 0;
    await ensureGuestFiles(host(), files());
    expect(writes).toEqual([]);
  });

  it("replaces a file whose content differs, also one of the same length, without leaving a temporary file", async () => {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "one.py"), "print('ONE')\n");
    fs.writeFileSync(path.join(directory, "sub-two.py"), "x");
    await ensureGuestFiles(host(), files());
    expect(read("one.py")).toBe("print('one')\n");
    expect(read("sub-two.py")).toBe("print('two')\n");
    expect(fs.readdirSync(directory).sort()).toEqual(["one.py", "sub-two.py"]);
  });

  it("works when the directory already exists", async () => {
    fs.mkdirSync(directory);
    await ensureGuestFiles(host(), files());
    expect(read("one.py")).toBe("print('one')\n");
  });

  it("restores the mode of a file whose content is right", async () => {
    await ensureGuestFiles(host(), files());
    fs.chmodSync(path.join(directory, "one.py"), 0o666);
    await ensureGuestFiles(host(), files());
    expect(mode("one.py")).toBe(0o644);
  });

  it("fails clearly for an artifact that is not there, and for a path that is a directory", async () => {
    await expect(ensureGuestFiles(host(), [{ artifact: "missing.py", to: path.join(directory, "missing.py"), mode: 0o644 }])).rejects.toThrow("no artifact missing.py");
    fs.mkdirSync(path.join(directory, "one.py"));
    await expect(ensureGuestFiles(host(), files())).rejects.toBeInstanceOf(LinuxError);
  });
});
