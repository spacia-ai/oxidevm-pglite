import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { LinuxError } from "@oxidevm/sdk/js-process";
import { HelperError } from "../src/errors.ts";
import { kit } from "@oxidevm/sdk/wasm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VMPostgresFS } from "../src/vm-fs.ts";
import { createNodeFiles, descriptor } from "./support/node-files.ts";
import type { NodeFilesHarness } from "./support/node-files.ts";

interface Utimes { readonly path: string; readonly atimeMs: number; readonly mtimeMs: number }

let root = "";
let harness: NodeFilesHarness;
let utimes: Utimes[];
let logs: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-vm-fs-"));
  harness = createNodeFiles();
  utimes = [];
  logs = [];
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function adapter(directory = root): VMPostgresFS {
  return new VMPostgresFS(directory, {
    files: harness.files,
    errno: kit.errno,
    directory: kit.directory,
    utimes: (target, atimeMs, mtimeMs) => { utimes.push({ path: target, atimeMs, mtimeMs }); },
    log: line => { logs.push(line); },
  });
}

/** The Emscripten errno a failed adapter call carries, or `undefined` when it carries none. */
function codeOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "number") return error.code;
    throw error;
  }
  throw new Error("Expected the call to fail");
}

const read = (name: string): string => fs.readFileSync(path.join(root, name), "utf8");

describe("VMPostgresFS on real PostgreSQL", () => {
  it("keeps live database files that survive close and reopen, flushes them, and bounds paths", async () => {
    let vmfs = adapter();
    let db = await PGlite.create({ fs: vmfs });
    await db.exec("CREATE TABLE durable(n integer, text_value text); INSERT INTO durable VALUES (42, 'shared');");
    expect(harness.syncs.length).toBeGreaterThan(0);
    expect(read("PG_VERSION").trim()).toBe("18");
    expect(fs.statSync(path.join(root, "base")).isDirectory()).toBe(true);
    await db.close();

    vmfs = adapter();
    db = await PGlite.create({ fs: vmfs });
    expect((await db.query("SELECT * FROM durable")).rows).toEqual([{ n: 42, text_value: "shared" }]);

    harness.failFsync = true;
    await expect(db.query("INSERT INTO durable VALUES (43, 'unacknowledged')")).rejects.toThrow(/Injected storage flush failure/);
    harness.failFsync = false;
    await db.syncToFs();
    await db.close();

    expect(() => vmfs.lstat("/../escape")).toThrow("Invalid PostgreSQL filesystem path");
  });
});

describe("path guard", () => {
  it("maps every path below the root and refuses dot segments and NUL", () => {
    const vmfs = adapter();
    vmfs.mkdir("/a/b", { recursive: true });
    expect(vmfs.lstat("//a///b/").mode & 0o170000).toBe(0o040000);
    for (const bad of ["/../escape", "/a/../../escape", "/./a", "..", "/a/./b", "/a\0b"]) {
      expect(() => vmfs.lstat(bad), bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => vmfs.readdir(bad), bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => vmfs.open(bad, "w"), bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => { vmfs.mkdir(bad); }, bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => { vmfs.unlink(bad); }, bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => { vmfs.rmdir(bad); }, bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => { vmfs.rename(bad, "/x"); }, bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => { vmfs.rename("/a", bad); }, bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => { vmfs.chmod(bad, 0o600); }, bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => { vmfs.truncate(bad, 0); }, bad).toThrow("Invalid PostgreSQL filesystem path");
      expect(() => { vmfs.utimes(bad, 1, 2); }, bad).toThrow("Invalid PostgreSQL filesystem path");
    }
    expect(utimes).toEqual([]);
  });

  it("never touches anything outside the root", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pglite-outside-"));
    try {
      const vmfs = adapter(path.join(outside, "root"));
      fs.mkdirSync(path.join(outside, "root"));
      expect(() => { vmfs.writeFile("/../outside.txt", "x"); }).toThrow("Invalid PostgreSQL filesystem path");
      expect(fs.readdirSync(outside)).toEqual(["root"]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("errno mapping", () => {
  it("reports Linux failures with the Emscripten errno PostgreSQL expects", () => {
    const vmfs = adapter();
    expect(codeOf(() => vmfs.lstat("/missing")), "ENOENT").toBe(44);
    vmfs.writeFile("/file", "x");
    expect(codeOf(() => vmfs.open("/file", "wx")), "EEXIST").toBe(20);
    expect(codeOf(() => vmfs.readdir("/file")), "ENOTDIR").toBe(54);
    vmfs.mkdir("/dir");
    vmfs.writeFile("/dir/inner", "x");
    expect(codeOf(() => { vmfs.rmdir("/dir"); }), "ENOTEMPTY").toBe(55);
    expect(codeOf(() => { vmfs.unlink("/dir"); }), "EISDIR").toBe(31);
    expect(codeOf(() => { vmfs.mkdir("/dir"); }), "EEXIST").toBe(20);
  });

  it("maps an errno without a counterpart to EIO and keeps non-Linux failures as they are", () => {
    const failing = new VMPostgresFS(root, {
      files: { ...harness.files, lstat() { throw new LinuxError(4000); }, fstat() { throw new TypeError("not a host failure"); } },
      errno: kit.errno,
      directory: kit.directory,
      utimes: () => undefined,
    });
    expect(codeOf(() => failing.lstat("/x"))).toBe(29);
    const fd = failing.open("/x", "w");
    expect(() => failing.fstat(fd)).toThrow(TypeError);
  });

  it("reports an unknown descriptor as EBADF", () => {
    const vmfs = adapter();
    expect(codeOf(() => { vmfs.close(12345); })).toBe(8);
    expect(codeOf(() => vmfs.fstat(12345))).toBe(8);
    expect(codeOf(() => vmfs.read(12345, new Uint8Array(1), 0, 1, 0))).toBe(8);
    expect(codeOf(() => vmfs.write(12345, new Uint8Array(1), 0, 1, 0))).toBe(8);
  });
});

describe("open flags", () => {
  it("opens for reading and updating without creating", () => {
    const vmfs = adapter();
    expect(codeOf(() => vmfs.open("/new", "r"))).toBe(44);
    expect(codeOf(() => vmfs.open("/new"))).toBe(44);
    vmfs.writeFile("/new", "abc");
    const fd = vmfs.open("/new", "r+");
    vmfs.write(fd, Uint8Array.of(0x58), 0, 1, 1);
    vmfs.close(fd);
    expect(read("new")).toBe("aXc");
  });

  it("creates and truncates with w, fails on an existing file with wx, and appends with a", () => {
    const vmfs = adapter();
    vmfs.writeFile("/f", "0123456789");
    vmfs.close(vmfs.open("/f", "w"));
    expect(read("f")).toBe("");
    expect(codeOf(() => vmfs.open("/f", "wx"))).toBe(20);
    expect(codeOf(() => vmfs.open("/f", "ax+"))).toBe(20);
    vmfs.writeFile("/g", "abc");
    const fd = vmfs.open("/g", "a");
    vmfs.write(fd, new TextEncoder().encode("def"), 0, 3, 0);
    vmfs.close(fd);
    expect(read("g")).toBe("abcdef");
    vmfs.close(vmfs.open("/h", "w+"));
    vmfs.close(vmfs.open("/i", "wx+"));
    vmfs.close(vmfs.open("/j", "a+"));
    vmfs.close(vmfs.open("/k", "ax"));
    expect(["h", "i", "j", "k"].every(name => fs.existsSync(path.join(root, name)))).toBe(true);
  });

  it("creates files with the requested permissions", () => {
    const vmfs = adapter();
    vmfs.close(vmfs.open("/private", "w", 0o600));
    vmfs.close(vmfs.open("/shared", "w", 0o640));
    expect(fs.statSync(path.join(root, "private")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, "shared")).mode & 0o777).toBe(0o640);
  });

  it("refuses flags it does not know, including names inherited from objects", () => {
    const vmfs = adapter();
    expect(() => vmfs.open("/x", "zz")).toThrow("Unsupported database file flags: zz");
    expect(() => vmfs.open("/x", "constructor")).toThrow("Unsupported database file flags: constructor");
  });
});

describe("reading and writing", () => {
  it("reads and writes at explicit positions", () => {
    const vmfs = adapter();
    const fd = vmfs.open("/data", "w+");
    vmfs.write(fd, new TextEncoder().encode("hello world"), 0, 11, 0);
    vmfs.write(fd, new TextEncoder().encode("WORLD"), 0, 5, 6);
    const buffer = new Uint8Array(20);
    expect(vmfs.read(fd, buffer, 2, 11, 0)).toBe(11);
    expect(new TextDecoder().decode(buffer.subarray(2, 13))).toBe("hello WORLD");
    expect(vmfs.read(fd, buffer, 0, 5, 6)).toBe(5);
    expect(new TextDecoder().decode(buffer.subarray(0, 5))).toBe("WORLD");
    expect(vmfs.read(fd, buffer, 0, 5, 100)).toBe(0);
    vmfs.close(fd);
  });

  it("writes only the requested slice of a buffer, and accepts an ArrayBuffer", () => {
    const vmfs = adapter();
    const fd = vmfs.open("/slice", "w");
    expect(vmfs.write(fd, new TextEncoder().encode("abcdef"), 2, 3, 0)).toBe(3);
    expect(vmfs.write(fd, new TextEncoder().encode("XY").buffer, 0, 2, 3)).toBe(2);
    vmfs.close(fd);
    expect(read("slice")).toBe("cdeXY");
  });

  it("writes whole files from strings or bytes, with the requested mode", () => {
    const vmfs = adapter();
    vmfs.writeFile("/text", "héllo");
    vmfs.writeFile("/bytes", Uint8Array.of(1, 2, 3), { mode: 0o640 });
    expect(read("text")).toBe("héllo");
    expect([...fs.readFileSync(path.join(root, "bytes"))]).toEqual([1, 2, 3]);
    expect(fs.statSync(path.join(root, "bytes")).mode & 0o777).toBe(0o640);
    vmfs.writeFile("/text", "x", { flag: "a" });
    expect(read("text")).toBe("héllox");
  });

  it("fails a write that makes no progress instead of looping", () => {
    const stalled = new VMPostgresFS(root, {
      files: { ...harness.files, write: () => 0 },
      errno: kit.errno,
      directory: kit.directory,
      utimes: () => undefined,
    });
    expect(() => { stalled.writeFile("/stuck", "data"); }).toThrow("Database write made no progress");
  });

  it("describes files in the units PostgreSQL expects", () => {
    const vmfs = adapter();
    vmfs.writeFile("/stat", new Uint8Array(1500));
    const stats = vmfs.lstat("/stat");
    expect(stats).toMatchObject({ size: 1500, blksize: 4096, blocks: 3, rdev: 0, nlink: 1 });
    expect(stats.mode & 0o170000).toBe(0o100000);
    const fd = vmfs.open("/stat", "r");
    expect(vmfs.fstat(fd).size).toBe(1500);
    vmfs.close(fd);
    const native = fs.statSync(path.join(root, "stat"));
    expect(Math.abs(stats.mtime - native.mtimeMs)).toBeLessThan(2);
  });
});

describe("metadata", () => {
  it("applies chmod natively and hands the host only the permission bits", () => {
    const modes: number[] = [];
    const recording = new VMPostgresFS(root, {
      files: { ...harness.files, chmod(target, mode) { modes.push(mode); harness.files.chmod(target, mode); } },
      errno: kit.errno,
      directory: kit.directory,
      utimes: () => undefined,
    });
    recording.writeFile("/mode", "x");
    recording.chmod("/mode", 0o100640);
    expect(modes).toEqual([0o640]);
    expect(fs.statSync(path.join(root, "mode")).mode & 0o7777).toBe(0o640);
  });

  it("truncates natively and refuses invalid lengths", () => {
    const vmfs = adapter();
    vmfs.writeFile("/t", "0123456789");
    vmfs.truncate("/t", 4);
    expect(read("t")).toBe("0123");
    vmfs.truncate("/t", 6);
    expect([...fs.readFileSync(path.join(root, "t"))]).toEqual([48, 49, 50, 51, 0, 0]);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => { vmfs.truncate("/t", bad); }, String(bad)).toThrow("Invalid database file length");
    }
    expect(fs.statSync(path.join(root, "t")).size).toBe(6);
  });

  it("hands utimes to the sidecar with the resolved path, in milliseconds", () => {
    const vmfs = adapter();
    vmfs.writeFile("/times", "x");
    vmfs.utimes("/times", 1_700_000_000_000, 1_700_000_001_500);
    expect(utimes).toEqual([{ path: `${root}/times`, atimeMs: 1_700_000_000_000, mtimeMs: 1_700_000_001_500 }]);
  });

  it("reports a failing utimes sidecar as an Emscripten errno", () => {
    const failing = new VMPostgresFS(root, {
      files: harness.files,
      errno: kit.errno,
      directory: kit.directory,
      utimes: () => { throw new LinuxError(13); },
    });
    expect(codeOf(() => { failing.utimes("/x", 1, 2); })).toBe(2);
  });

  it("reports a failure of the helper process like a failure of the host", () => {
    const failing = new VMPostgresFS(root, {
      files: harness.files,
      errno: kit.errno,
      directory: kit.directory,
      utimes: () => { throw new HelperError("Permission denied", 13); },
    });
    expect(codeOf(() => { failing.utimes("/x", 1, 2); })).toBe(2);
    expect(() => { failing.utimes("/x", 1, 2); }).toThrow("Permission denied");
  });
});

describe("directories", () => {
  it("creates single directories with mode 0700 by default and recursive chains once", () => {
    const vmfs = adapter();
    vmfs.mkdir("/one");
    expect(fs.statSync(path.join(root, "one")).mode & 0o777).toBe(0o700);
    vmfs.mkdir("/a/b/c", { recursive: true });
    vmfs.mkdir("/a/b/c", { recursive: true });
    expect(fs.statSync(path.join(root, "a/b/c")).isDirectory()).toBe(true);
    vmfs.mkdir("/m", { mode: 0o750 });
    expect(fs.statSync(path.join(root, "m")).mode & 0o777).toBe(0o750);
    vmfs.mkdir("/r/s", { recursive: true, mode: 0o750 });
    expect(fs.statSync(path.join(root, "r/s")).mode & 0o777).toBe(0o750);
  });

  it("does not hide a failure that is not 'already exists' while creating a chain", () => {
    const vmfs = adapter();
    vmfs.writeFile("/blocker", "x");
    expect(codeOf(() => { vmfs.mkdir("/blocker/inner", { recursive: true }); })).toBe(54);
  });

  it("lists names without dot entries", () => {
    const vmfs = adapter();
    vmfs.mkdir("/d");
    vmfs.writeFile("/d/one", "1");
    vmfs.writeFile("/d/two", "2");
    expect(vmfs.readdir("/d").sort()).toEqual(["one", "two"]);
    const dotted = new VMPostgresFS(root, {
      files: { ...harness.files, readdir: () => [".", "..", "x"].map(name => ({ name, nameBytes: new TextEncoder().encode(name), type: 8 })) },
      errno: kit.errno,
      directory: kit.directory,
      utimes: () => undefined,
    });
    expect(dotted.readdir("/")).toEqual(["x"]);
  });

  it("renames files and directories, and unlinks files and empty directories", () => {
    const vmfs = adapter();
    vmfs.mkdir("/from");
    vmfs.writeFile("/from/a", "a");
    vmfs.rename("/from", "/to");
    expect(read("to/a")).toBe("a");
    vmfs.unlink("/to/a");
    vmfs.rmdir("/to");
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("flushing", () => {
  it("syncs changed files before their directories, deepest directory first, then forgets them", async () => {
    const vmfs = adapter();
    vmfs.mkdir("/base", { recursive: true });
    vmfs.mkdir("/base/1");
    vmfs.writeFile("/base/1/table", "rows");
    vmfs.writeFile("/PG_VERSION", "18\n");
    harness.syncs.length = 0;
    await vmfs.syncToFs();
    const synced = harness.syncs.map(entry => entry.replace(`fsync:${root}`, ""));
    const lastFile = Math.max(synced.indexOf("/base/1/table"), synced.indexOf("/PG_VERSION"));
    const firstDirectory = Math.min(...["/base/1", "/base", ""].map(directory => synced.indexOf(directory)));
    expect(synced).toContain("/base/1/table");
    expect(synced).toContain("/PG_VERSION");
    expect(lastFile).toBeLessThan(firstDirectory);
    expect(synced.indexOf("/base/1")).toBeLessThan(synced.indexOf("/base"));
    expect(synced.indexOf("/base")).toBeLessThan(synced.indexOf(""));
    harness.syncs.length = 0;
    await vmfs.syncToFs();
    expect(harness.syncs).toEqual([]);
  });

  it("flushes the data of an overwritten file and the directory of an unlinked one", async () => {
    const vmfs = adapter();
    vmfs.writeFile("/gone", "x");
    await vmfs.syncToFs();
    harness.syncs.length = 0;
    vmfs.unlink("/gone");
    await vmfs.syncToFs();
    expect(harness.syncs).toEqual([`fsync:${root}`]);
  });

  it("follows a renamed file so its data is flushed under the new name", async () => {
    const vmfs = adapter();
    const fd = vmfs.open("/old", "w");
    await vmfs.syncToFs();
    vmfs.rename("/old", "/new");
    await vmfs.syncToFs();
    harness.syncs.length = 0;
    vmfs.write(fd, Uint8Array.of(1), 0, 1, 0);
    await vmfs.syncToFs();
    expect(harness.syncs).toContain(`fsync:${root}/new`);
    expect(harness.syncs).not.toContain(`fsync:${root}/old`);
    vmfs.close(fd);
  });

  it("marks created and truncated files, chmod, truncate and utimes targets as changed", async () => {
    const vmfs = adapter();
    vmfs.writeFile("/existing", "x");
    await vmfs.syncToFs();
    for (const change of [
      () => { vmfs.chmod("/existing", 0o600); },
      () => { vmfs.truncate("/existing", 0); },
      () => { vmfs.utimes("/existing", 1, 2); },
      () => { vmfs.close(vmfs.open("/existing", "w")); },
    ]) {
      harness.syncs.length = 0;
      change();
      await vmfs.syncToFs();
      expect(harness.syncs).toContain(`fsync:${root}/existing`);
    }
    harness.syncs.length = 0;
    vmfs.close(vmfs.open("/existing", "r"));
    await vmfs.syncToFs();
    expect(harness.syncs).toEqual([]);
  });

  it("keeps everything dirty when a flush fails, so the next flush retries it", async () => {
    const vmfs = adapter();
    vmfs.writeFile("/retry", "x");
    harness.failFsync = true;
    await expect(vmfs.syncToFs()).rejects.toThrow("Injected storage flush failure");
    harness.failFsync = false;
    harness.syncs.length = 0;
    await vmfs.syncToFs();
    expect(harness.syncs).toEqual([`fsync:${root}/retry`, `fsync:${root}`]);
  });

  it("closes its descriptors after a final flush", async () => {
    const vmfs = adapter();
    const fd = vmfs.open("/open", "w");
    vmfs.write(fd, Uint8Array.of(1), 0, 1, 0);
    harness.syncs.length = 0;
    await vmfs.closeFs();
    expect(harness.syncs).toContain(`fsync:${root}/open`);
    expect(codeOf(() => { vmfs.close(fd); })).toBe(8);
  });

  it("reports a failed relaxed flush at the next change instead of dropping it", async () => {
    const vmfs = adapter();
    vmfs.writeFile("/relaxed", "x");
    harness.failFsync = true;
    await vmfs.syncToFs(true);
    harness.failFsync = false;
    expect(logs.join("\n")).toContain("Injected storage flush failure");
    expect(codeOf(() => { vmfs.writeFile("/after", "y"); })).toBe(29);
    vmfs.writeFile("/after", "y");
    expect(read("after")).toBe("y");
    harness.syncs.length = 0;
    await vmfs.syncToFs();
    expect(harness.syncs).toContain(`fsync:${root}/relaxed`);
  });

  it("does not swallow a failed strict flush", async () => {
    const vmfs = adapter();
    vmfs.writeFile("/strict", "x");
    harness.failFsync = true;
    await expect(vmfs.syncToFs(false)).rejects.toThrow("Injected storage flush failure");
    await expect(vmfs.closeFs()).rejects.toThrow("Injected storage flush failure");
  });
});

describe("test support", () => {
  it("builds descriptors only from valid numbers", () => {
    expect(descriptor(3)).toBe(3);
    expect(() => descriptor(-1)).toThrow(RangeError);
  });
});
