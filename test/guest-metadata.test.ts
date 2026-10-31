import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUEST, runPython } from "./support/python.ts";

const script = path.join(GUEST, "pg-metadata.py");
let root = "", outside = "";

beforeEach(() => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pglite-metadata-")));
  root = path.join(base, "pgdata");
  outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
});
afterEach(() => { fs.rmSync(path.dirname(root), { recursive: true, force: true }); });

const request = (target: string, atimeMs: unknown = 1_700_000_000_000, mtimeMs: unknown = 1_700_000_001_000): string =>
  `${JSON.stringify({ op: "utimes", path: target, atimeMs, mtimeMs })}\n`;

async function replies(input: string, roots: readonly string[] = [root]): Promise<readonly unknown[]> {
  const run = await runPython([script, ...roots], input);
  expect(run.code, run.stderr).toBe(0);
  return run.stdout.split("\n").filter(line => line !== "").map((line): unknown => JSON.parse(line));
}

describe("pg-metadata.py", () => {
  it("sets the access and modification times of a file inside the database", async () => {
    const file = path.join(root, "table");
    fs.writeFileSync(file, "x");
    expect(await replies(request(file))).toEqual([{ ok: true }]);
    const stat = fs.statSync(file);
    expect(stat.atimeMs).toBe(1_700_000_000_000);
    expect(stat.mtimeMs).toBe(1_700_000_001_000);
  });

  it("keeps sub-millisecond precision, accepts the root itself, and works on directories", async () => {
    const directory = path.join(root, "base");
    fs.mkdirSync(directory);
    expect(await replies(request(directory, 1_700_000_000_000.5, 1_700_000_002_000.25) + request(root))).toEqual([{ ok: true }, { ok: true }]);
    expect(Math.abs(fs.statSync(directory).mtimeMs - 1_700_000_002_000.25)).toBeLessThan(0.01);
    expect(fs.statSync(root).mtimeMs).toBe(1_700_000_001_000);
  });

  it("answers one reply per request and keeps serving after a failure", async () => {
    const file = path.join(root, "kept");
    fs.writeFileSync(file, "x");
    const answers = await replies(request(path.join(root, "missing")) + "not json\n" + request(file));
    expect(answers).toHaveLength(3);
    expect(answers[0]).toMatchObject({ ok: false, errno: 2 });
    expect(answers[1]).toMatchObject({ ok: false, errno: 22 });
    expect(answers[2]).toEqual({ ok: true });
  });

  it("refuses paths outside the database, including dot segments and symbolic links", async () => {
    const secret = path.join(outside, "secret");
    fs.writeFileSync(secret, "x");
    const before = fs.statSync(secret).mtimeMs;
    fs.symlinkSync(outside, path.join(root, "escape"));
    fs.symlinkSync(secret, path.join(root, "link"));
    const attempts = [secret, path.join(root, "..", "outside", "secret"), path.join(root, "escape", "secret"), path.join(root, "link"), `${root}-sibling`, "/"];
    const answers = await replies(attempts.map(target => request(target)).join(""));
    expect(answers).toEqual(attempts.map(() => ({ ok: false, errno: 22, error: "Metadata path is outside the database" })));
    expect(fs.statSync(secret).mtimeMs).toBe(before);
  });

  it("refuses everything when it was started without a directory", async () => {
    const file = path.join(root, "unlisted");
    fs.writeFileSync(file, "x");
    expect(await replies(request(file), [])).toEqual([{ ok: false, errno: 22, error: "Metadata path is outside the database" }]);
  });

  it("serves several directories", async () => {
    const other = path.join(outside, "second");
    fs.writeFileSync(other, "x");
    expect(await replies(request(other), [root, outside])).toEqual([{ ok: true }]);
  });

  it("refuses malformed requests with errno 22", async () => {
    const file = path.join(root, "target");
    fs.writeFileSync(file, "x");
    const valid = { op: "utimes", path: file, atimeMs: 1, mtimeMs: 2 };
    const raw = [
      JSON.stringify({ ...valid, op: "chmod" }),
      JSON.stringify({ ...valid, extra: 1 }),
      JSON.stringify({ op: "utimes", path: file, atimeMs: 1 }),
      JSON.stringify({ ...valid, path: "relative/file" }),
      JSON.stringify({ ...valid, path: 42 }),
      JSON.stringify({ ...valid, path: `${file}\u0000x` }),
      JSON.stringify({ ...valid, atimeMs: true }),
      JSON.stringify({ ...valid, atimeMs: "1" }),
      JSON.stringify({ ...valid, mtimeMs: -1 }),
      JSON.stringify({ ...valid, mtimeMs: 1e300 }),
      `{"op":"utimes","path":${JSON.stringify(file)},"atimeMs":NaN,"mtimeMs":2}`,
      `{"op":"utimes","path":${JSON.stringify(file)},"atimeMs":1,"mtimeMs":Infinity}`,
      "[]",
      "null",
      "",
      "x".repeat(5000),
    ];
    const answers = await replies(raw.map(line => `${line}\n`).join(""));
    expect(answers).toHaveLength(raw.length);
    for (const [index, answer] of answers.entries()) expect(answer, raw[index]).toMatchObject({ ok: false, errno: 22 });
    expect(fs.statSync(file).mtimeMs).not.toBe(2);
  });

  it("handles a last request without a trailing newline and exits cleanly at the end of input", async () => {
    const file = path.join(root, "final");
    fs.writeFileSync(file, "x");
    expect(await replies(request(file).trimEnd())).toEqual([{ ok: true }]);
    expect(await replies("")).toEqual([]);
  });
});
