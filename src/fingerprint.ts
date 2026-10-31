import type { PGlite } from "@electric-sql/pglite";

type Queryable = Pick<PGlite, "query">;
type Row = Record<string, unknown>;

const USER_TABLES = "n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'";

const TABLES = `SELECT n.nspname AS schema, c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','m') AND ${USER_TABLES} ORDER BY 1,2`;
const COLUMNS = `SELECT n.nspname AS schema,c.relname AS name,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped AND ${USER_TABLES} ORDER BY 1,2,3`;
const CONSTRAINTS = `SELECT n.nspname AS schema,c.conname,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE ${USER_TABLES} ORDER BY 1,2,3`;
const SEQUENCES = "SELECT * FROM pg_sequences WHERE schemaname NOT LIKE 'pg_%' AND schemaname<>'information_schema' ORDER BY schemaname,sequencename";
const VIEWS = "SELECT schemaname,viewname,definition FROM pg_views WHERE schemaname NOT LIKE 'pg_%' AND schemaname<>'information_schema' ORDER BY 1,2";

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A SHA-256 over what makes a database what it is: its tables, columns, constraints, sequences, views and
 * the digest of every row. The migration compares the legacy database with the copy it made. 64-bit values
 * (sequence limits) arrive as `bigint`, which JSON cannot hold, so they are written as text.
 */
export async function fingerprint(db: Queryable): Promise<string> {
  const tables = await db.query<{ schema: string; name: string }>(TABLES);
  const parts: unknown[] = [];
  for (const sql of [COLUMNS, CONSTRAINTS, SEQUENCES, VIEWS]) parts.push((await db.query<Row>(sql)).rows);
  for (const table of tables.rows) {
    const result = await db.query<{ count: string; digest: string }>(
      `SELECT count(*)::text AS count, md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY md5(to_jsonb(t)::text)),'')) AS digest FROM ${quote(table.schema)}.${quote(table.name)} t`,
    );
    parts.push({ table, ...result.rows[0] });
  }
  const text = JSON.stringify(parts, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value);
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}
