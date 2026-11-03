import { describe, expect, it } from "vitest";
import { decodeMarker, encodeMarker } from "../src/marker.ts";
import type { StorageMarker } from "../src/marker.ts";

const fingerprint = "a".repeat(64);
const valid: StorageMarker = { version: 1, source: "new", fingerprint, backup: null };
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe("storage marker", () => {
  it("round-trips with the key order the sample wrote, for each source, the 0.1.0 migration included", () => {
    expect(new TextDecoder().decode(encodeMarker(valid))).toBe(`{"version":1,"source":"new","fingerprint":"${fingerprint}","backup":null}`);
    expect(decodeMarker(encodeMarker(valid))).toEqual(valid);
    const migrated: StorageMarker = { version: 1, source: "indexeddb", fingerprint, backup: "/workspace/_oxidevm/pglite-indexeddb-1.tar" };
    expect(decodeMarker(encodeMarker(migrated))).toEqual(migrated);
    const imported: StorageMarker = { version: 1, source: "archive", fingerprint, backup: "/workspace/pglite-import.tar" };
    expect(decodeMarker(encodeMarker(imported))).toEqual(imported);
  });

  it("refuses another version as unsupported", () => {
    for (const version of [2, 0, "1", null]) expect(() => decodeMarker(bytes({ ...valid, version })), String(version)).toThrow("Unsupported VM PostgreSQL storage marker");
  });

  it("refuses text that is not JSON as unreadable", () => {
    for (const raw of [new TextEncoder().encode("{"), Uint8Array.of(0xff, 0xfe), new Uint8Array(0)]) expect(() => decodeMarker(raw)).toThrow("Unreadable VM PostgreSQL storage marker");
  });

  it("refuses a malformed version 1 marker", () => {
    const broken: unknown[] = [
      null, [], "x", {}, { version: 1 },
      { ...valid, extra: true },
      { version: 1, source: "new", fingerprint },
      { ...valid, source: "other" },
      { ...valid, fingerprint: "xyz" },
      { ...valid, fingerprint: "A".repeat(64) },
      { ...valid, backup: 7 },
      { ...valid, backup: undefined },
    ];
    for (const value of broken) expect(() => decodeMarker(bytes(value)), JSON.stringify(value)).toThrow("Invalid VM PostgreSQL storage marker");
  });
});
