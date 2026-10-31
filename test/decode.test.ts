import { describe, expect, it } from "vitest";
import { exactKeys, isRecord } from "../src/decode.ts";

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const value of [null, undefined, [], [1], "x", 1, true, () => 0]) expect(isRecord(value), String(value)).toBe(false);
  });
});

describe("exactKeys", () => {
  it("accepts required keys and listed optional keys", () => {
    expect(exactKeys({ a: 1, b: 2 }, ["a"], ["b"])).toBe(true);
    expect(exactKeys({ a: 1 }, ["a"], ["b"])).toBe(true);
    expect(exactKeys({}, [], ["b"])).toBe(true);
  });

  it("rejects a missing required key and any unknown key", () => {
    expect(exactKeys({ b: 2 }, ["a"], ["b"])).toBe(false);
    expect(exactKeys({ a: 1, c: 3 }, ["a"], ["b"])).toBe(false);
    expect(exactKeys({ a: 1 }, [])).toBe(false);
  });

  it("is not fooled by inherited or undefined keys", () => {
    expect(exactKeys({ a: undefined }, ["a"])).toBe(true);
    const inherited: Record<string, unknown> = {};
    Object.setPrototypeOf(inherited, { a: 1 });
    expect(exactKeys(inherited, ["a"])).toBe(false);
  });
});
