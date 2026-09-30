import { describe, it, expect, vi, afterAll } from "vitest";
import { readdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const paths = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "talome-core-perf-backup-"));
  const dbPath = path.join(root, "talome.db");
  const backupDir = path.join(root, "backups");
  // Workers are reused across test files — remember and restore the env.
  const previousEnv = { DATABASE_PATH: process.env.DATABASE_PATH, TALOME_BACKUP_DIR: process.env.TALOME_BACKUP_DIR };
  process.env.DATABASE_PATH = dbPath;
  process.env.TALOME_BACKUP_DIR = backupDir;
  return { root, dbPath, backupDir, previousEnv };
});

// The server connection: same file as DATABASE_PATH, so the module reuses it.
vi.mock("../db/index.js", async () => {
  const { default: Db } = await import("better-sqlite3");
  const client = new Db(paths.dbPath);
  client.pragma("journal_mode = WAL");
  client.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insert = client.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
  for (let i = 0; i < 2000; i++) insert.run(`k${i}`, "x".repeat(200));
  return { db: { $client: client } };
});

import { snapshotNowAsync } from "../services/self-backup.js";
import { db } from "../db/index.js";

afterAll(() => {
  (db.$client as Database.Database).close();
  for (const [key, value] of Object.entries(paths.previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(paths.root, { recursive: true, force: true });
});

describe("snapshotNowAsync", () => {
  it("writes a consistent talome-db-*.db copy via the online backup API", async () => {
    const res = await snapshotNowAsync();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path).toMatch(/talome-db-\d{8}-\d{4}\.db$/);

    const copy = new Database(res.path, { readonly: true });
    const row = copy.prepare("SELECT COUNT(*) AS n FROM settings").get() as { n: number };
    copy.close();
    expect(row.n).toBe(2000);
    // No temp file left behind.
    expect(readdirSync(paths.backupDir).some((f) => f.endsWith(".partial"))).toBe(false);
  });

  it("shares one backup between concurrent callers", async () => {
    const [a, b] = await Promise.all([snapshotNowAsync(), snapshotNowAsync()]);
    expect(a).toBe(b);
  });

  it("keeps the same retention (7 newest snapshots)", async () => {
    // Seed 9 older snapshots with distinct mtimes.
    for (let i = 0; i < 9; i++) {
      const f = join(paths.backupDir, `talome-db-2020010${i}-0000.db`);
      writeFileSync(f, "old");
      const t = new Date(2020, 0, 1 + i);
      utimesSync(f, t, t);
    }
    const res = await snapshotNowAsync();
    expect(res.ok).toBe(true);
    const snapshots = readdirSync(paths.backupDir).filter((f) => f.startsWith("talome-db-") && f.endsWith(".db"));
    expect(snapshots).toHaveLength(7);
    if (res.ok) expect(snapshots).toContain(res.path.split("/").pop());
  });

  it("removes .partial files left by a crash, but not recent ones", async () => {
    const stale = join(paths.backupDir, "talome-db-20200101-0000.db.partial");
    const recent = join(paths.backupDir, "talome-db-20990101-0000.db.partial");
    writeFileSync(stale, "half");
    writeFileSync(recent, "in progress");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    const res = await snapshotNowAsync();
    expect(res.ok).toBe(true);
    const files = readdirSync(paths.backupDir);
    expect(files).not.toContain("talome-db-20200101-0000.db.partial");
    expect(files).toContain("talome-db-20990101-0000.db.partial");
  });
});
