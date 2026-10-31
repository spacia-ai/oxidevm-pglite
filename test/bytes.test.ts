import { describe, expect, it } from "vitest";
import { concat, int32, join, number32 } from "../src/bytes.ts";

describe("int32", () => {
  it("writes four big-endian bytes", () => {
    expect([...int32(0x01020304)]).toEqual([1, 2, 3, 4]);
    expect([...int32(196_608)]).toEqual([0, 3, 0, 0]);
    expect([...int32(0)]).toEqual([0, 0, 0, 0]);
    expect([...int32(0xffff_ffff)]).toEqual([255, 255, 255, 255]);
  });
});

describe("number32", () => {
  it("reads four big-endian bytes from the start of a view", () => {
    expect(number32(Uint8Array.of(0, 3, 0, 0))).toBe(196_608);
    expect(number32(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toBe(0xffff_ffff);
    expect(number32(Uint8Array.of(1, 2, 3, 4, 5, 6))).toBe(0x01020304);
  });

  it("honours the offset of a view into a larger buffer", () => {
    const whole = Uint8Array.of(9, 9, 0, 0, 1, 0, 9);
    expect(number32(whole.subarray(2, 6))).toBe(256);
  });

  it("refuses fewer than four bytes", () => {
    expect(() => number32(Uint8Array.of(1, 2, 3))).toThrow(RangeError);
  });
});

describe("join", () => {
  it("concatenates parts in order into one new array", () => {
    const first = Uint8Array.of(1, 2), second = new Uint8Array(0), third = Uint8Array.of(3);
    const joined = join(first, second, third);
    expect([...joined]).toEqual([1, 2, 3]);
    first[0] = 9;
    expect(joined[0]).toBe(1);
  });

  it("returns an empty array for no parts", () => {
    expect(join().length).toBe(0);
  });
});

describe("concat", () => {
  it("joins a list of any length, which a spread of arguments could not", () => {
    const parts = Array.from({ length: 300_000 }, (_value, index) => Uint8Array.of(index % 251));
    const all = concat(parts);
    expect(all.length).toBe(300_000);
    expect(all[250]).toBe(250);
    expect(all[251]).toBe(0);
    expect(concat([]).length).toBe(0);
  });
});
