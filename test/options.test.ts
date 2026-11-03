import { describe, expect, it } from "vitest";
import { resolveDataDir, resolveImportArchive } from "../src/options.ts";

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

describe("resolveImportArchive", () => {
  const dataDir = "/workspace/pgdata";

  it("means no import for an empty value", () => {
    expect(resolveImportArchive("", dataDir)).toBeUndefined();
  });

  it("accepts absolute, normalized paths inside the workspace, the module's own directory included", () => {
    for (const value of ["/workspace/pglite-import.tar", "/workspace/_oxidevm/import.tar", "/workspace/pgdata.tar", "/workspace/pgdata-old/x.tar", "/workspace/a b/ünïcode.tar"]) {
      expect(resolveImportArchive(value, dataDir), value).toBe(value);
    }
  });

  it("refuses a path outside the workspace, not normalized, or inside the data directory it is loaded into", () => {
    const refused = ["x.tar", "/tmp/x.tar", "/workspace", "/workspace/", "/workspace//x.tar", "/workspace/./x.tar", "/workspace/../x.tar", "/workspace/x.tar/", "/workspace/x\0.tar", "/workspace/pgdata", "/workspace/pgdata/import.tar"];
    for (const value of refused) expect(() => resolveImportArchive(value, dataDir), JSON.stringify(value)).toThrow("The importArchive option must be empty or an absolute path inside /workspace, outside the data directory, without empty, . or .. segments");
    expect(() => resolveImportArchive("/workspace/db/main/x.tar", "/workspace/db/main")).toThrow(/importArchive/u);
    expect(resolveImportArchive("/workspace/db/x.tar", "/workspace/db/main")).toBe("/workspace/db/x.tar");
  });
});
