import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeLock } from "../scripts/upstream.ts";

const root = path.join(import.meta.dirname, "..");
const notices = fs.readFileSync(path.join(root, "NOTICES.txt"), "utf8");
const lock = decodeLock(JSON.parse(fs.readFileSync(path.join(root, "upstream/lock.json"), "utf8")));

interface Section { readonly name: string; readonly declared: string; readonly text: string }

/** The verbatim license texts, each between lines that carry the sha256 of the text. */
function sections(): Section[] {
  const found: Section[] = [];
  const pattern = /^-----8<----- BEGIN (\S+) sha256=([0-9a-f]{64}) -----8<-----\n([\s\S]*?)^-----8<----- END \1 -----8<-----$/gmu;
  for (const match of notices.matchAll(pattern)) found.push({ name: match[1] ?? "", declared: match[2] ?? "", text: match[3] ?? "" });
  return found;
}

describe("NOTICES.txt", () => {
  it("names the release it ships in: the version in its first lines is the module's version", () => {
    // The file is one of the release's checksummed files, so a stale version here is published as is.
    const version = /^\s*version: "([^"]+)",$/mu.exec(fs.readFileSync(path.join(root, "module.ts"), "utf8"))?.[1];
    expect(version).toBeDefined();
    expect(/^This release \(oxidevm-pglite ([^)]+)\) contains:$/mu.exec(notices)?.[1]).toBe(version);
  });

  it("holds the license texts of every component it lists", () => {
    expect(sections().map(section => section.name)).toEqual([
      "pglite-license", "postgresql-license", "unicode-license", "emscripten-license", "musl-copyright", "llvm-license", "libxml2-license", "snowball-license",
    ]);
  });

  it("carries each text exactly as published: the digest on its first line is the digest of the text", () => {
    for (const section of sections()) expect(createHash("sha256").update(section.text).digest("hex"), section.name).toBe(section.declared);
  });

  it("carries PGlite's Apache License exactly as the locked package ships it", () => {
    const license = lock.files.find(file => file.name === "PGLITE-LICENSE");
    expect(license).toBeDefined();
    expect(sections().find(section => section.name === "pglite-license")?.declared).toBe(license?.sha256);
  });

  it("carries the PostgreSQL License, with its two copyright holders and the University of California disclaimer", () => {
    const text = sections().find(section => section.name === "postgresql-license")?.text ?? "";
    expect(text).toContain("PostgreSQL Global Development Group");
    expect(text).toContain("The Regents of the University of California");
    expect(text).toContain("IN NO EVENT SHALL THE UNIVERSITY OF CALIFORNIA BE LIABLE");
  });

  it("names the pinned package, its tarball digests and the PostgreSQL version", () => {
    expect(notices).toContain(lock.package.sha256);
    expect(notices).toContain(lock.package.integrity);
    expect(notices).toContain("PostgreSQL 18.6");
    expect(notices).toContain("Copyright 2026 Spacia B.V.");
  });
});
