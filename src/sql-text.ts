/**
 * Reads the keywords of a SQL text without mistaking comments, quoted identifiers or string constants
 * for commands, so that the JSON endpoint can refuse COPY (it has no channel for the data).
 */

const DOLLAR_TAG = /\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/y;
const WORD_START = /[A-Za-z_]/u;
const WORD_PART = /[A-Za-z_0-9$]/u;
const SEPARATORS = "();,";

/** Where the nested block comment that starts at `start` ends (the text length when it never does). */
function skipBlockComment(sql: string, start: number): number {
  let index = start + 2, depth = 1;
  while (index < sql.length && depth > 0) {
    if (sql.startsWith("/*", index)) { depth += 1; index += 2; }
    else if (sql.startsWith("*/", index)) { depth -= 1; index += 2; }
    else index += 1;
  }
  return index;
}

/**
 * Where the quoted text that starts at `start` ends. A doubled quote stays inside the text. A backslash
 * escapes the next character only in an `E'...'` constant: with standard_conforming_strings on, which the
 * wire handler announces, it is an ordinary character everywhere else.
 */
function skipQuoted(sql: string, start: number, escapes: boolean): number {
  const quote = sql.charAt(start);
  let index = start + 1;
  while (index < sql.length) {
    const char = sql.charAt(index);
    if (char === "\\" && escapes) { index += 2; continue; }
    index += 1;
    if (char === quote) {
      if (sql.charAt(index) !== quote) break;
      index += 1;
    }
  }
  return index;
}

/** The dollar-quoted constant at `start`, as the index after it, or `undefined` when `$` starts something else. */
function skipDollarQuoted(sql: string, start: number): number | undefined {
  DOLLAR_TAG.lastIndex = start;
  const tag = DOLLAR_TAG.exec(sql)?.[0];
  if (tag === undefined) return undefined;
  const end = sql.indexOf(tag, start + tag.length);
  return end < 0 ? sql.length : end + tag.length;
}

/** Upper-cased words and the separators `( ) ; ,`; every quoted text, whatever it holds, is the word `quoted`. */
export function sqlWords(sql: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql.charAt(index);
    if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index + 2);
      index = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", index)) {
      index = skipBlockComment(sql, index);
    } else if (char === "'" || char === '"') {
      index = skipQuoted(sql, index, false);
      words.push("quoted");
    } else if (char === "$") {
      const end = skipDollarQuoted(sql, index);
      if (end !== undefined) words.push("quoted");
      index = end ?? index + 1;
    } else if (WORD_START.test(char)) {
      let end = index + 1;
      while (end < sql.length && WORD_PART.test(sql.charAt(end))) end += 1;
      const word = sql.slice(index, end);
      if (word.toUpperCase() === "E" && sql.charAt(end) === "'") {
        // An escape string constant: the same scan as a quoted text, but a backslash escapes.
        index = skipQuoted(sql, end, true);
        words.push("quoted");
      } else {
        words.push(word.toUpperCase());
        index = end;
      }
    } else {
      if (SEPARATORS.includes(char)) words.push(char);
      index += 1;
    }
  }
  return words;
}

/** True when the text is, or contains after a semicolon, a COPY command. */
export function isCopyCommand(sql: string): boolean {
  const words = sqlWords(sql);
  return words[0] === "COPY" || words.some((word, index) => word === ";" && words[index + 1] === "COPY");
}
