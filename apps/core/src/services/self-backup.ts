/**
 * Self-backup — periodic atomic snapshots of Talome's own SQLite database.
 *
 * Why: the `backups` feature backs up *user apps*. Talome's own data —
 * memories, settings (including encrypted API keys), installed apps,
 * conversations — lives in `talome.db` and had no snapshot mechanism.
 * A volume-corruption event or accidental `rm` used to be unrecoverable.
 *
 * How: the scheduled snapshot uses SQLite's online backup API (via
 * better-sqlite3 on the server's own connection), which copies pages in
 * small steps between event-loop turns — the server keeps serving requests
 * while a ~40MB database is copied. The manual `snapshotNow()` keeps using
 * `VACUUM INTO` (synchronous, compacted copy). We keep the last N
 * snapshots in `$BACKUP_DIR` and prune older ones. `BACKUP_DIR` defaults to `/app/backups` inside the Docker image
 * (backed by the `talome-backups` named volume) or `~/.talome/backups`
 * for native installs.
 */

import Database from "better-sqlite3";
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { db } from "../db/index.js";

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

/** Pages copied per backup step; each step runs on its own event-loop turn. */
const BACKUP_PAGES_PER_STEP = 256;

let snapshotInFlight: Promise<{ ok: true; path: string } | { ok: false; error: string }> | null = null;

function resolveSourceConnection(): Database.Database | null {
  // Only reuse the server's connection when it is the same database file —
  // then writes made during the copy are picked up without restarting it.
  const client = db.$client as Database.Database | undefined;
  if (client && client.open && client.name === resolveDbPath()) return client;
  return null;
}

/**
 * Non-blocking snapshot via SQLite's online backup API. Same file naming and
 * pruning as {@link snapshotNow}. The copy is written to a temp file and
 * renamed into place, so a crash mid-backup never leaves a truncated
 * `talome-db-*.db` that would count toward retention.
 */
export function snapshotNowAsync(): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (snapshotInFlight) return snapshotInFlight;
  snapshotInFlight = (async (): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
    const backupDir = resolveBackupDir();
    const out = join(backupDir, `talome-db-${formatTimestamp(new Date())}.db`);
    const tmp = `${out}.partial`;
    let own: Database.Database | null = null;
    try {
      mkdirSync(backupDir, { recursive: true });
      if (existsSync(tmp)) unlinkSync(tmp);
      const source = resolveSourceConnection() ?? (own = new Database(resolveDbPath(), { readonly: true }));
      await source.backup(tmp, { progress: () => BACKUP_PAGES_PER_STEP });
      renameSync(tmp, out);
      pruneOldSnapshots(backupDir);
      return { ok: true, path: out };
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      try { own?.close(); } catch { /* ignore */ }
    }
  })().finally(() => {
    snapshotInFlight = null;
  });
  return snapshotInFlight;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSelfBackup() {
  if (timer) return; // idempotent
  if (process.env.TALOME_SELF_BACKUP_DISABLED === "true") return;

  // First snapshot 1 minute after boot — long enough for the app to settle,
  // short enough to catch users who start Talome and immediately power-cycle.
  const first = setTimeout(() => {
    void snapshotNowAsync().then((res) => {
      if (!res.ok) console.error("[self-backup] initial snapshot failed:", res.error);
      else console.log("[self-backup] initial snapshot written:", res.path);
    });
  }, 60_000);
  first.unref?.();

  timer = setInterval(() => {
    void snapshotNowAsync().then((res) => {
      if (!res.ok) console.error("[self-backup] scheduled snapshot failed:", res.error);
    });
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
