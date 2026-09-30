import { describe, it, expect, vi, afterAll } from "vitest";
import { readFileSync, writeFileSync, openSync, writeSync, closeSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-verify");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { createAppBackup } = await import("../backup/engine.js");
const { verifyBackup } = await import("../backup/verify.js");
const { getBackupRow } = await import("../backup/store.js");
const { integrityCheckSync } = await import("../backup/sqlite-integrity.js");
const { writeNotification } = await import("../db/notifications.js");

afterAll(() => env.cleanup());

const COMPOSE = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
`;

function makeSqlite(path: string, rows = 50): void {
  const db = new Database(path);
  db.pragma("journal_mode = DELETE");
  db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("CREATE INDEX idx_items_name ON items(name)");
  const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
  const tx = db.transaction(() => {
    for (let i = 0; i < rows; i++) insert.run(`item-${i}-${"x".repeat(200)}`);
  });
  tx();
  db.close();
}

async function backupApp(appId: string, files: Record<string, string | Buffer>, setup?: (appDir: string) => void) {
  const { appDir } = await installFakeApp(env.root, appId, COMPOSE, files);
  setup?.(appDir);
  resetDocker([{ id: `${appId}-c`, name: appId, service: "app", image: "example/app:1.0" }]);
  const result = await createAppBackup(appId);
  if (!result.success) throw new Error(result.error);
  return result;
}

describe("verifyBackup", () => {
  it("verifies a healthy backup with a test restore and SQLite integrity check", async () => {
    const result = await backupApp("goodapp", { "config/settings.json": "{}" }, (dir) => makeSqlite(join(dir, "config", "app.db")));
    const v = await verifyBackup(result.backupId);
    expect(v.errors).toEqual([]);
    expect(v.status).toBe("verified");
    const sqliteCheck = v.checks.find((c) => c.name.startsWith("sqlite ") && c.name.endsWith("app.db"));
    expect(sqliteCheck?.ok).toBe(true);
    expect(v.checks.find((c) => c.name === "test restore checksums")?.ok).toBe(true);
    const row = getBackupRow(result.backupId)!;
    expect(row.verify_status).toBe("verified");
    expect(row.verified_at).toBeTruthy();
    expect(JSON.parse(row.verify_detail!).checks.length).toBeGreaterThan(0);
  });

  it("detects a corrupted archive", async () => {
    const result = await backupApp("corruptapp", { "config/a.txt": "a".repeat(10_000), "config/b.txt": "b" });
    const buf = readFileSync(result.archivePath);
    const mid = Math.floor(buf.length / 2);
    for (let i = mid; i < mid + 8; i++) buf[i] ^= 0xff;
    writeFileSync(result.archivePath, buf);
    const v = await verifyBackup(result.backupId);
    expect(v.status).toBe("failed");
    expect(v.errors.join(" ")).toMatch(/archive checksum/);
    expect(getBackupRow(result.backupId)!.verify_status).toBe("failed");
    expect(vi.mocked(writeNotification)).toHaveBeenCalledWith("critical", expect.stringContaining("verification failed"), expect.any(String), "corruptapp");
  });

  it("detects files whose content no longer matches the manifest", async () => {
    const result = await backupApp("tamperapp", { "config/a.txt": "original" });
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf-8"));
    const entry = manifest.files.find((f: { path: string }) => f.path.endsWith("a.txt"));
    entry.sha256 = "0".repeat(64);
    writeFileSync(result.manifestPath, JSON.stringify(manifest));
    const v = await verifyBackup(result.backupId);
    expect(v.status).toBe("failed");
    expect(v.errors.join(" ")).toMatch(/checksum mismatch .*a\.txt/);
  });

  it("fails when the archive is missing", async () => {
    const result = await backupApp("missingapp", { "config/a.txt": "a" });
    rmSync(result.archivePath);
    const v = await verifyBackup(result.backupId);
    expect(v.status).toBe("failed");
    expect(v.errors.join(" ")).toMatch(/missing/);
  });

  it("fails the SQLite integrity check for a corrupted database", async () => {
    const result = await backupApp("badsqlite", { "config/readme.txt": "x" }, (dir) => {
      const dbPath = join(dir, "config", "broken.db");
      makeSqlite(dbPath, 400);
      // Smash a b-tree page in the middle of the file
      const size = statSync(dbPath).size;
      const fd = openSync(dbPath, "r+");
      const pageSize = 4096;
      const page = Math.max(2, Math.floor(size / pageSize / 2));
      writeSync(fd, Buffer.alloc(pageSize, 0xab), 0, pageSize, page * pageSize);
      closeSync(fd);
    });
    const v = await verifyBackup(result.backupId);
    expect(v.status).toBe("failed");
    const check = v.checks.find((c) => c.name.endsWith("broken.db"));
    expect(check?.ok).toBe(false);
    // the archive itself is fine — only the integrity check fails
    expect(v.checks.find((c) => c.name === "archive checksum")?.ok).toBe(true);
  });

  it("validates SQL dumps inside dump-method backups", async () => {
    await installFakeApp(
      env.root,
      "dumpverify",
      `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
  db:
    image: mariadb:11
    volumes:
      - ./mysql:/var/lib/mysql
`,
      { "config/x.txt": "x", "mysql/ibdata1": "raw" },
    );
    resetDocker([
      { id: "dv-web", name: "dumpverify-web", service: "web", image: "example/web:1" },
      { id: "dv-db", name: "dumpverify-db", service: "db", image: "mariadb:11" },
    ]);
    dockerState.dumps.set("db", "-- MariaDB dump 10.19  Distrib 11.4\n--\nCREATE DATABASE app;\n-- Dump completed on 2026-01-01  2:00:00\n");
    const result = await createAppBackup("dumpverify");
    if (!result.success) throw new Error(result.error);
    expect(result.method).toBe("dump");
    const v = await verifyBackup(result.backupId);
    expect(v.errors).toEqual([]);
    expect(v.checks.find((c) => c.name === "dump db")?.ok).toBe(true);
  });
});

describe("integrityCheckSync", () => {
  it("reports ok for a valid database and an error for garbage", () => {
    const good = join(env.root, "good.db");
    makeSqlite(good);
    expect(integrityCheckSync(good).ok).toBe(true);
    const bad = join(env.root, "bad.db");
    writeFileSync(bad, Buffer.concat([Buffer.from("SQLite format 3\u0000"), Buffer.alloc(4096, 0xee)]));
    expect(integrityCheckSync(bad).ok).toBe(false);
  });
});
