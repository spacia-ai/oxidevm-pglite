import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { kit } from "@oxidevm/sdk/wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveSource, MAX_ARCHIVE_PIECES } from "../src/archive.ts";
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

  it("refuses a symbolic link and an empty file", async () => {
    fs.writeFileSync(path.join(base, "target.tar"), "x");
    fs.symlinkSync(path.join(base, "target.tar"), path.join(base, "link.tar"));
    fs.writeFileSync(path.join(base, "empty.tar"), "");
    await expect(source(path.join(base, "link.tar")).load()).rejects.toThrow(`The import archive ${path.join(base, "link.tar")} is neither a regular file nor a directory of pieces`);
    await expect(source(path.join(base, "empty.tar")).load()).rejects.toThrow(`The import archive ${path.join(base, "empty.tar")} is empty`);
  });

  it("joins the regular files of a directory in name order, the way a page writes an archive over 16 MiB", async () => {
    const directory = path.join(base, "pieces");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "002"), "C");
    fs.writeFileSync(path.join(directory, "000"), "AA");
    fs.writeFileSync(path.join(directory, "001"), "B");
    const loaded = await source(directory).load();
    expect(loaded.path).toBe(directory);
    expect(await loaded.archive.text()).toBe("AABC");
    expect(loaded.archive.type).toBe("");
  });

  it("refuses an empty directory, a piece that is not a regular file, and too many pieces", async () => {
    const directory = path.join(base, "pieces");
    fs.mkdirSync(directory);
    await expect(source(directory).load()).rejects.toThrow(`The import archive directory ${directory} is empty`);
    fs.mkdirSync(path.join(directory, "000"));
    await expect(source(directory).load()).rejects.toThrow(`The import archive piece ${directory}/000 is not a regular file`);
    fs.rmdirSync(path.join(directory, "000"));
    for (let index = 0; index <= MAX_ARCHIVE_PIECES; index += 1) fs.writeFileSync(path.join(directory, String(index).padStart(3, "0")), "x");
    await expect(source(directory).load()).rejects.toThrow(`The import archive directory ${directory} has more than 64 pieces`);
  });

  it("marks a gzip archive so that PGlite decompresses it", async () => {
    const file = path.join(base, "import.tar.gz");
    fs.writeFileSync(file, Uint8Array.of(0x1f, 0x8b, 8, 0));
    expect((await source(file).load()).archive.type).toBe("application/x-gzip");
  });

  it("accepts exactly 256 MiB and refuses one byte more", async () => {
    const file = path.join(base, "large.tar");
    fs.writeFileSync(file, "");
    fs.truncateSync(file, MAX_ARCHIVE_BYTES);
    expect((await source(file).load()).archive.size).toBe(MAX_ARCHIVE_BYTES);
    fs.truncateSync(file, MAX_ARCHIVE_BYTES + 1);
    await expect(source(file).load()).rejects.toThrow(`The import archive ${file} exceeds the 256 MiB limit`);
  });

  it("counts the pieces of a directory together against the limit", async () => {
    const directory = path.join(base, "pieces");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "000"), "");
    fs.truncateSync(path.join(directory, "000"), MAX_ARCHIVE_BYTES);
    fs.writeFileSync(path.join(directory, "001"), "x");
    await expect(source(directory).load()).rejects.toThrow(`The import archive ${directory} exceeds the 256 MiB limit`);
  });
});
