import Database from "better-sqlite3";
import { existsSync } from "node:fs";

export interface SqliteIntegrityResult {
  ok: boolean;
  detail: string;
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\u0000", "latin1");

/** True when the buffer starts with the SQLite file header. */
export function hasSqliteMagic(header: Buffer): boolean {
  return header.length >= SQLITE_MAGIC.length && header.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
}

function runCheck(path: string, readonly: boolean): SqliteIntegrityResult {
  const conn = new Database(path, { readonly, fileMustExist: true });
  try {
    const rows = conn.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const messages = rows.map((r) => r.integrity_check);
    const ok = messages.length === 1 && messages[0] === "ok";
    return { ok, detail: ok ? "ok" : messages.slice(0, 5).join("; ") };
  } finally {
    conn.close();
  }
}

/**
 * PRAGMA integrity_check on a SQLite file, opened read-only. Only ever call
 * this on an extracted copy: if the copy carries a WAL file that a read-only
 * connection can't replay, it is re-opened read-write (the copy is disposable).
 */
export function integrityCheckSync(path: string): SqliteIntegrityResult {
  try {
    return runCheck(path, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (existsSync(`${path}-wal`) && /readonly|unable to open|cannot open/i.test(message)) {
      try {
        return runCheck(path, false);
      } catch (retryErr) {
        return { ok: false, detail: retryErr instanceof Error ? retryErr.message : String(retryErr) };
      }
    }
    return { ok: false, detail: message };
  }
}
