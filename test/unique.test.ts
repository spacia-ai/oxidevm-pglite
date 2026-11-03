import { describe, expect, it } from "vitest";
import { uniqueSuffix } from "../src/unique.ts";

describe("uniqueSuffix", () => {
  it("is 32 hex digits from the random source, different every time", () => {
    const seen = new Set(Array.from({ length: 64 }, () => uniqueSuffix()));
    expect(seen.size).toBe(64);
    for (const value of seen) expect(value).toMatch(/^[0-9a-f]{32}$/u);
  });
});
