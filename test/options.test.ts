import { describe, expect, it } from "vitest";
import { resolveDataDir, resolveLegacyName } from "../src/options.ts";

describe("resolveDataDir", () => {
  it("accepts absolute, normalized paths inside the workspace", () => {
    for (const value of ["/workspace/pgdata", "/workspace/a", "/workspace/data/pg-1.2_x", "/workspace/deep/er/still/pgdata", "/workspace/_oxidevm2", "/workspace/.hidden"]) {
      expect(resolveDataDir(value), value).toBe(value);
    }
  });

  it("refuses anything else, naming the option", () => {
    const refused = [
      "", "pgdata", "workspace/pgdata", "/", "/workspace", "/workspace/", "/workspace/pgdata/", "/workspace//pgdata", "/workspace/./pgdata", "/workspace/../etc",
      "/workspace/pgdata/..", "/workspacex/pgdata", "/tmp/pgdata", "/etc/pgdata", "/workspace/_oxidevm", "/workspace/_oxidevm/pgdata", "/workspace/_oxidevm/", "/workspace/pg\0data",
    ];
    for (const value of refused) expect(() => resolveDataDir(value), JSON.stringify(value)).toThrow(/dataDir/u);
  });

  it("explains what is allowed", () => {
    expect(() => resolveDataDir("/tmp/x")).toThrow("The dataDir option must be an absolute path inside /workspace, outside /workspace/_oxidevm, without empty, . or .. segments");
  });
});

describe("resolveLegacyName", () => {
  it("means no migration for an empty name", () => {
    expect(resolveLegacyName("")).toBeUndefined();
  });

  it("accepts the name of an IndexedDB database", () => {
    for (const value of ["oxidevm-pyodide-v1-pglite", "a", "my db/with spaces & symbols", "ünïcode"]) expect(resolveLegacyName(value), value).toBe(value);
  });

  it("refuses control characters", () => {
    for (const value of ["a\nb", "a\tb", "a\u0000b", "a\u007fb", "\u001f"]) expect(() => resolveLegacyName(value), JSON.stringify(value)).toThrow(/legacyIndexedDb/u);
  });
});
