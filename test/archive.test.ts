import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kit } from "@oxidevm/sdk/wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveSource } from "../src/archive.ts";
import { MAX_ARCHIVE_BYTES } from "../src/storage.ts";
import { createNodeFiles } from "./support/node-files.ts";

let base = "";
beforeEach(() => { base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pglite-archive-"))); });
afterEach(() => { fs.rmSync(base, { recursive: true, force: true }); });

const source = (file: string) => archiveSource({ files: createNodeFiles().files, errno: kit.errno }, file);

describe("the importArchive source", () => {
  it("reads the archive whole and names it, leaving the file as it was", async () => {
    const file = path.join(base, "import.tar"), bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
    fs.writeFileSync(file, bytes);
    const loaded = await source(file).load();
    expect(loaded.path).toBe(file);
    expect(new Uint8Array(await loaded.archive.arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(fs.readFileSync(file))).toEqual(bytes);
  });

  it("fails, instead of creating an empty database, when the archive is missing", async () => {
    const file = path.join(base, "missing.tar");
    await expect(source(file).load()).rejects.toThrow(`The import archive ${file} does not exist. Write it before the first start, or leave importArchive empty for a new database.`);
  });

  it("refuses a directory or a symbolic link", async () => {
    fs.mkdirSync(path.join(base, "directory.tar"));
    fs.writeFileSync(path.join(base, "target.tar"), "x");
    fs.symlinkSync(path.join(base, "target.tar"), path.join(base, "link.tar"));
    for (const name of ["directory.tar", "link.tar"]) {
      const file = path.join(base, name);
      await expect(source(file).load(), name).rejects.toThrow(`The import archive ${file} is not a regular file`);
    }
  });

  it("accepts exactly 256 MiB and refuses one byte more", async () => {
    const file = path.join(base, "large.tar");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, MAX_ARCHIVE_BYTES);
    expect((await source(file).load()).archive.size).toBe(MAX_ARCHIVE_BYTES);
    fs.truncateSync(file, MAX_ARCHIVE_BYTES + 1);
    await expect(source(file).load()).rejects.toThrow(`The import archive ${file} exceeds the 256 MiB limit`);
  });
});
