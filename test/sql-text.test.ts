import { describe, expect, it } from "vitest";
import { isCopyCommand, sqlWords } from "../src/sql-text.ts";

describe("isCopyCommand", () => {
  it("is false for COPY inside strings, identifiers, comments and dollar quotes", () => {
    for (const sql of [
      "SELECT 'COPY data FROM STDIN'",
      'SELECT "COPY" FROM t',
      "/* COPY ignored */ SELECT 42",
      "DO $$ BEGIN RAISE NOTICE 'COPY'; END $$",
      "SELECT $tag$ ; COPY t FROM STDIN $tag$",
      "SELECT 42 -- COPY t FROM STDIN",
      "SELECT 'it''s COPY'",
      'SELECT "a""COPY"',
      "SELECT E'\\'; COPY t FROM STDIN; --'",
      "SELECT e'\\\\' || 'COPY'",
    ]) expect(isCopyCommand(sql), sql).toBe(false);
  });

  it("is true for a COPY statement, also after comments and other statements", () => {
    for (const sql of [
      "COPY t FROM STDIN",
      "copy t to stdout",
      "-- leading comment\n COPY t TO STDOUT",
      "SELECT 42; /* nested /* comment */ here */ COPY t FROM STDIN",
      "SELECT 1;COPY t FROM STDIN",
      "BEGIN; INSERT INTO t VALUES (1); COPY t FROM STDIN",
      "SELECT 'a'; \"b\"; COPY t FROM STDIN",
      // With standard_conforming_strings on (what the wire handler advertises) a backslash is an ordinary
      // character, so the string ends at its second quote and the COPY after it is a statement.
      "SELECT '\\'; COPY t FROM STDIN; --'",
    ]) expect(isCopyCommand(sql), sql).toBe(true);
  });

  it("does not treat words that merely contain COPY as a command", () => {
    for (const sql of ["SELECT copy_of FROM t", "SELECT 1; SELECT copy FROM t", "COPYING", "SELECT t.copy"]) {
      expect(isCopyCommand(sql), sql).toBe(false);
    }
  });

  it("is false for an empty statement and for unterminated constructs", () => {
    for (const sql of ["", "   ", "-- only a comment", "/* unterminated COPY", "'unterminated COPY", "$$ unterminated COPY"]) {
      expect(isCopyCommand(sql), sql).toBe(false);
    }
  });
});

describe("sqlWords", () => {
  it("returns upper-cased words, separators and a marker for quoted text", () => {
    expect(sqlWords("select a, 'x' from \"T\"; copy t")).toEqual(["SELECT", "A", ",", "quoted", "FROM", "quoted", ";", "COPY", "T"]);
  });

  it("reads dollar-quoted bodies as one quoted word", () => {
    expect(sqlWords("do $f$ select ';' $f$ ; copy")).toEqual(["DO", "quoted", ";", "COPY"]);
  });

  it("keeps parentheses as words", () => {
    expect(sqlWords("f(a)")).toEqual(["F", "(", "A", ")"]);
  });
});
