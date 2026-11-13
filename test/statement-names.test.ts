import { describe, expect, it } from "vitest";
import { join } from "../src/bytes.ts";
import { scopeStatementName } from "../src/statement-names.ts";
import { cstring, int16 } from "./support/wire.ts";

const prefix = new TextEncoder().encode("3~");
const code = (letter: string): number => letter.charCodeAt(0);

describe("scopeStatementName", () => {
  it("prefixes the name a Parse defines, and says when it is the unnamed statement", () => {
    const rest = join(cstring("SELECT 1"), int16(0));
    expect(scopeStatementName(code("P"), join(cstring("S_1"), rest), prefix)).toEqual({ body: join(cstring("3~S_1"), rest), defines: new TextEncoder().encode("3~S_1"), unnamed: false });
    expect(scopeStatementName(code("P"), join(cstring(""), rest), prefix)).toEqual({ body: join(cstring("3~"), rest), defines: prefix, unnamed: true });
  });

  it("prefixes the statement of a Bind and leaves its portal alone", () => {
    const rest = join(int16(0), int16(0), int16(0));
    expect(scopeStatementName(code("B"), join(cstring("portal"), cstring("S_1"), rest), prefix)).toEqual({ body: join(cstring("portal"), cstring("3~S_1"), rest) });
    expect(scopeStatementName(code("B"), join(cstring(""), cstring(""), rest), prefix)).toEqual({ body: join(cstring(""), cstring("3~"), rest) });
  });

  it("prefixes the statement of a Describe or Close, and leaves a portal's name alone", () => {
    expect(scopeStatementName(code("D"), join(Uint8Array.of(code("S")), cstring("S_1")), prefix)).toEqual({ body: join(Uint8Array.of(code("S")), cstring("3~S_1")) });
    expect(scopeStatementName(code("C"), join(Uint8Array.of(code("S")), cstring("S_1")), prefix)).toEqual({ body: join(Uint8Array.of(code("S")), cstring("3~S_1")), removes: new TextEncoder().encode("3~S_1") });
    const portal = join(Uint8Array.of(code("P")), cstring("cursor"));
    expect(scopeStatementName(code("D"), portal, prefix)).toEqual({ body: portal });
    expect(scopeStatementName(code("C"), portal, prefix)).toEqual({ body: portal });
  });

  it("passes every other message, and a name that never ends, unchanged", () => {
    const text = cstring("SELECT 'P', 'S_1'");
    for (const type of ["Q", "E", "S", "H", "X", "d"]) expect(scopeStatementName(code(type), text, prefix)).toEqual({ body: text });
    const endless = new TextEncoder().encode("S_1");
    expect(scopeStatementName(code("P"), endless, prefix)).toEqual({ body: endless });
    expect(scopeStatementName(code("B"), endless, prefix)).toEqual({ body: endless });
    expect(scopeStatementName(code("B"), join(cstring("portal"), endless), prefix)).toEqual({ body: join(cstring("portal"), endless) });
    expect(scopeStatementName(code("C"), join(Uint8Array.of(code("S")), endless), prefix)).toEqual({ body: join(Uint8Array.of(code("S")), endless) });
    expect(scopeStatementName(code("D"), new Uint8Array(0), prefix)).toEqual({ body: new Uint8Array(0) });
  });
});
