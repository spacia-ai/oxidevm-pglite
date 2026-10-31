import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../src/fingerprint.ts";

let db: PGlite;
beforeAll(async () => { db = await PGlite.create(); });
afterAll(async () => { await db.close(); });

/** Fingerprints a database that holds exactly `statements`: the one shared instance is emptied first. */
async function fresh(statements: string): Promise<string> {
  await db.exec("DROP SCHEMA IF EXISTS other CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await db.exec(statements);
  return fingerprint(db);
}

describe("fingerprint", () => {
  it("is a SHA-256 hex digest that is the same for the same schema and rows", async () => {
    const sql = "CREATE TABLE people(id integer PRIMARY KEY, name text NOT NULL DEFAULT 'x'); INSERT INTO people VALUES (1, 'a'), (2, 'b');";
    const first = await fresh(sql), second = await fresh(sql);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(second).toBe(first);
  });

  it("does not depend on the order rows were inserted", async () => {
    const forward = await fresh("CREATE TABLE t(n integer); INSERT INTO t VALUES (1), (2), (3);");
    const backward = await fresh("CREATE TABLE t(n integer); INSERT INTO t VALUES (3), (2), (1);");
    expect(backward).toBe(forward);
  });

  it("changes when a row, a column type, a constraint, a view or the table name changes", async () => {
    const base = "CREATE TABLE t(n integer, label text); INSERT INTO t VALUES (1, 'a');";
    const reference = await fresh(base);
    const variants = [
      "CREATE TABLE t(n integer, label text); INSERT INTO t VALUES (1, 'b');",
      "CREATE TABLE t(n integer, label text); INSERT INTO t VALUES (1, 'a'), (2, 'a');",
      "CREATE TABLE t(n bigint, label text); INSERT INTO t VALUES (1, 'a');",
      "CREATE TABLE t(n integer NOT NULL, label text); INSERT INTO t VALUES (1, 'a');",
      "CREATE TABLE t(n integer, label text DEFAULT 'd'); INSERT INTO t VALUES (1, 'a');",
      "CREATE TABLE t(n integer PRIMARY KEY, label text); INSERT INTO t VALUES (1, 'a');",
      `${base} CREATE VIEW v AS SELECT n FROM t;`,
      "CREATE TABLE u(n integer, label text); INSERT INTO u VALUES (1, 'a');",
      `${base} CREATE SCHEMA other; CREATE TABLE other.t(n integer);`,
    ];
    const seen = new Set([reference]);
    for (const sql of variants) {
      const digest = await fresh(sql);
      expect(seen.has(digest), sql).toBe(false);
      seen.add(digest);
    }
  });

  it("fingerprints a database with sequences, whose 64-bit limits do not fit a JavaScript number", async () => {
    const digest = await fresh("CREATE TABLE s(id serial PRIMARY KEY, label text); INSERT INTO s(label) VALUES ('a'), ('b'); CREATE SEQUENCE extra;");
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await fresh("CREATE TABLE s(id serial PRIMARY KEY, label text); INSERT INTO s(label) VALUES ('a'), ('b'), ('c'); CREATE SEQUENCE extra;")).not.toBe(digest);
  });

  it("quotes names that need it", async () => {
    const digest = await fresh('CREATE TABLE "we""ird name"("Col" integer); INSERT INTO "we""ird name" VALUES (1);');
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("ignores the system catalogs: any empty database yields the same digest", async () => {
    const other = await PGlite.create();
    try {
      expect(await fingerprint(other)).toBe(await fresh(""));
    } finally {
      await other.close();
    }
  });
});
