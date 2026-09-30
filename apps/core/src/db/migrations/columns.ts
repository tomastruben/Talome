/**
 * Column helpers shared by the idempotent migration modules.
 *
 * The main server and the MCP stdio process both run migrations against the
 * same database, possibly at the same moment. "Check PRAGMA table_info, then
 * ALTER TABLE" is not atomic across processes: both can see the column
 * missing, and the second ALTER then fails with "duplicate column name".
 * addColumnIfMissing treats that as success — the column exists, which is
 * all the migration wanted.
 */

import { sql } from "drizzle-orm";
import { db } from "../index.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdentifier(kind: string, name: string): void {
  if (!IDENTIFIER.test(name)) throw new Error(`Invalid ${kind} name: ${name}`);
}

/** Column names of a table (empty when the table does not exist). */
export function tableColumns(table: string): Set<string> {
  assertIdentifier("table", table);
  const rows = db.all(sql.raw(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * True for SQLite's error when ADD COLUMN names a column that already exists.
 * Drizzle wraps driver errors ("Failed to run the query …"), so the cause
 * chain is searched too.
 */
export function isDuplicateColumnError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 5; e = e.cause, depth++) {
    if (/duplicate column name/i.test(e.message)) return true;
  }
  return false;
}

/**
 * Add a column unless it exists. Returns true when this call added it.
 * Race-tolerant: a concurrent ALTER from another process that wins between
 * the check and our ALTER is not an error.
 */
export function addColumnIfMissing(table: string, column: string, ddl: string): boolean {
  assertIdentifier("column", column);
  if (tableColumns(table).has(column)) return false;
  try {
    db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`));
    return true;
  } catch (err) {
    if (isDuplicateColumnError(err)) return false;
    throw err;
  }
}
