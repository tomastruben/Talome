/**
 * Self-backup — periodic atomic snapshots of Talome's own SQLite database.
 *
 * Why: the `backups` feature backs up *user apps*. Talome's own data —
 * memories, settings (including encrypted API keys), installed apps,
 * conversations — lives in `talome.db` and had no snapshot mechanism.
 * A volume-corruption event or accidental `rm` used to be unrecoverable.
 *
 * How: `VACUUM INTO` writes a clean copy of the DB without blocking
 * readers. We keep the last N snapshots in `$BACKUP_DIR` and prune older
 * ones. `BACKUP_DIR` defaults to `/app/backups` inside the Docker image
 * (backed by the `talome-backups` named volume) or `~/.talome/backups`
 * for native installs.
 */

import Database from "better-sqlite3";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const BACKUP_INTERVAL_MS = Number(process.env.TALOME_SELF_BACKUP_INTERVAL_MS) || 24 * 60 * 60 * 1000;
const MAX_SNAPSHOTS = Number(process.env.TALOME_SELF_BACKUP_KEEP) || 7;

function resolveBackupDir(): string {
  if (process.env.TALOME_BACKUP_DIR) return process.env.TALOME_BACKUP_DIR;
  // In Docker, /app/backups is mounted as a named volume.
  if (process.env.NODE_ENV === "production" && process.cwd().startsWith("/app")) {
    return "/app/backups";
  }
  return join(homedir(), ".talome", "backups");
}

function resolveDbPath(): string {
  return process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db");
}

function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function pruneOldSnapshots(dir: string) {
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("talome-db-") && f.endsWith(".db"))
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const { f } of files.slice(MAX_SNAPSHOTS)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* best effort */
      }
    }
  } catch {
    /* dir missing — nothing to prune */
  }
}

export function snapshotNow(): { ok: true; path: string } | { ok: false; error: string } {
  const dbPath = resolveDbPath();
  const backupDir = resolveBackupDir();
  mkdirSync(backupDir, { recursive: true });

  const out = join(backupDir, `talome-db-${formatTimestamp(new Date())}.db`);

  let sqlite: Database.Database | null = null;
  try {
    sqlite = new Database(dbPath, { readonly: true });
    // VACUUM INTO produces a clean, integrity-checked copy without blocking
    // other connections. It's the SQLite-recommended online backup mechanism
    // for small-to-medium databases.
    sqlite.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    pruneOldSnapshots(backupDir);
    return { ok: true, path: out };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { sqlite?.close(); } catch { /* ignore */ }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSelfBackup() {
  if (timer) return; // idempotent
  if (process.env.TALOME_SELF_BACKUP_DISABLED === "true") return;

  // First snapshot 1 minute after boot — long enough for the app to settle,
  // short enough to catch users who start Talome and immediately power-cycle.
  const first = setTimeout(() => {
    const res = snapshotNow();
    if (!res.ok) console.error("[self-backup] initial snapshot failed:", res.error);
    else console.log("[self-backup] initial snapshot written:", res.path);
  }, 60_000);
  first.unref?.();

  timer = setInterval(() => {
    const res = snapshotNow();
    if (!res.ok) console.error("[self-backup] scheduled snapshot failed:", res.error);
  }, BACKUP_INTERVAL_MS);
  timer.unref?.();
}

export function stopSelfBackup() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Prevent the backup dir from being quietly mis-parented: make sure the
// resolved parent exists before anything writes to it.
mkdirSync(dirname(resolveBackupDir()), { recursive: true });
