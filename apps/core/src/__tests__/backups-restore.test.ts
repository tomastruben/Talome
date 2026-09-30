import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { prepareBackupEnv, installFakeApp, resetDocker, dockerState } from "./helpers/backups-fixture.js";

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-restore");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { createAppBackup } = await import("../backup/engine.js");
const { restoreAppBackup } = await import("../backup/restore.js");
const { getBackupRow, getRestoreRow, setAppBackupConfig, listAppBackups } = await import("../backup/store.js");

afterAll(() => env.cleanup());

const FAST = { healthTimeoutMs: 300, pollIntervalMs: 20 };

const COMPOSE = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
      - ./settings.yml:/app/settings.yml
`;

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

async function prepare(appId: string) {
  const { appDir, composePath } = await installFakeApp(env.root, appId, COMPOSE, {
    "config/app.conf": "version=1",
    "config/data/items.json": "[1,2,3]",
    "settings.yml": "theme: dark\n",
  });
  setAppBackupConfig(appId, { excludePatterns: ["cache/"] });
  resetDocker([{ id: `${appId}-c`, name: appId, service: "app", image: "example/app:1.0" }]);
  const backup = await createAppBackup(appId);
  if (!backup.success) throw new Error(backup.error);
  // Drift after the backup
  write(join(appDir, "config/app.conf"), "version=2");
  write(join(appDir, "config/new-file.txt"), "created later");
  write(join(appDir, "config/cache/blob.bin"), "cache content");
  write(join(appDir, "settings.yml"), "theme: light\n");
  dockerState.events = [];
  return { appDir, composePath, backup };
}

describe("restoreAppBackup", () => {
  it("restores data with a safety backup, keeps excluded paths, and checks health", async () => {
    const { appDir, backup } = await prepare("restoreok");
    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    if (!r.success) return;

    expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=1");
    expect(readFileSync(join(appDir, "config/data/items.json"), "utf-8")).toBe("[1,2,3]");
    expect(existsSync(join(appDir, "config/new-file.txt"))).toBe(false);
    expect(readFileSync(join(appDir, "settings.yml"), "utf-8")).toBe("theme: dark\n");
    // excluded paths were never backed up — they are carried over, not deleted
    expect(readFileSync(join(appDir, "config/cache/blob.bin"), "utf-8")).toBe("cache content");
    // no leftovers next to the volumes
    expect(readdirSync(appDir).filter((n) => n.includes(".talome-"))).toEqual([]);

    expect(r.health.healthy).toBe(true);
    expect(dockerState.events).toContain("startApp");
    const safety = getBackupRow(r.safetyBackupId!)!;
    expect(safety.purpose).toBe("pre-restore");
    expect(safety.status).toBe("completed");
    expect(getRestoreRow(r.restoreId)!.status).toBe("completed");
  });

  it("rolls back to the pre-restore state when the app is unhealthy afterwards", async () => {
    const { appDir, backup } = await prepare("restorebad");
    dockerState.containers[0].crashOnStart = true;

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.rolledBack).toBe(true);
    expect(r.error).toMatch(/not healthy/);
    expect(r.safetyBackupId).toBeTruthy();

    // the drifted (pre-restore) state is back
    expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=2");
    expect(readFileSync(join(appDir, "config/new-file.txt"), "utf-8")).toBe("created later");
    expect(readFileSync(join(appDir, "config/cache/blob.bin"), "utf-8")).toBe("cache content");
    expect(readFileSync(join(appDir, "settings.yml"), "utf-8")).toBe("theme: light\n");
    expect(readdirSync(appDir).filter((n) => n.includes(".talome-"))).toEqual([]);
    // started once for the restore attempt and once after rolling back
    expect(dockerState.events.filter((e) => e === "startApp")).toHaveLength(2);
    expect(getRestoreRow(r.restoreId!)!.status).toBe("rolled_back");
  });

  it("refuses to restore a corrupted archive and changes nothing", async () => {
    const { appDir, backup } = await prepare("restorecorrupt");
    const buf = readFileSync(backup.archivePath);
    buf[Math.floor(buf.length / 2)] ^= 0xff;
    writeFileSync(backup.archivePath, buf);
    const before = listAppBackups("restorecorrupt").length;

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toMatch(/checksum/);
    expect(readFileSync(join(appDir, "config/app.conf"), "utf-8")).toBe("version=2");
    expect(listAppBackups("restorecorrupt").length).toBe(before); // no safety backup taken
    expect(dockerState.events).toEqual([]);
  });

  it("restores the compose snapshot for Talome-managed compose files", async () => {
    const { composePath, backup } = await prepare("restorecompose");
    const original = readFileSync(composePath, "utf-8");
    writeFileSync(composePath, original.replace("example/app:1.0", "example/app:2.0"));
    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    expect(readFileSync(composePath, "utf-8")).toBe(original);
  });

  it("reloads database dumps into a fresh data directory", async () => {
    const { appDir } = await installFakeApp(
      env.root,
      "restorepg",
      `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
  db:
    image: postgres:16
    volumes:
      - ./pgdata:/var/lib/postgresql/data
`,
      { "config/a.txt": "a", "pgdata/PG_VERSION": "16" },
    );
    resetDocker([
      { id: "rp-web", name: "restorepg-web", service: "web", image: "example/web:1" },
      { id: "rp-db", name: "restorepg-db", service: "db", image: "postgres:16" },
    ]);
    const backup = await createAppBackup("restorepg");
    if (!backup.success) throw new Error(backup.error);
    expect(backup.method).toBe("dump");
    write(join(appDir, "pgdata/corrupted"), "junk");
    dockerState.events = [];

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    expect(dockerState.events).toContain("composeUp:db");
    expect(dockerState.events).toContain("putArchive");
    expect(dockerState.events).toContain("exec:psql");
    // the old raw data directory was replaced by a fresh one for the dump load
    expect(existsSync(join(appDir, "pgdata/corrupted"))).toBe(false);
    expect(readdirSync(appDir).filter((n) => n.includes(".talome-"))).toEqual([]);
  });

  it("prepares the dump load for a database that runs as its own user (e.g. bitnami, uid 1001)", async () => {
    const { chmodSync, statSync, writeFileSync: wf } = await import("node:fs");
    const { readTarGz } = await import("../backup/tar.js");
    const { appDir } = await installFakeApp(
      env.root,
      "restorebitnami",
      `services:
  web:
    image: example/web:1
    volumes:
      - ./config:/config
  db:
    image: bitnami/postgresql:16
    volumes:
      - ./pgdata:/bitnami/postgresql
`,
      { "config/a.txt": "a", "pgdata/data/PG_VERSION": "16" },
    );
    chmodSync(join(appDir, "pgdata"), 0o775);
    resetDocker([
      { id: "rb-web", name: "restorebitnami-web", service: "web", image: "example/web:1" },
      { id: "rb-db", name: "restorebitnami-db", service: "db", image: "bitnami/postgresql:16" },
    ]);
    const backup = await createAppBackup("restorebitnami");
    if (!backup.success) throw new Error(backup.error);
    expect(backup.method).toBe("dump");
    dockerState.execUid = "1001";
    dockerState.execGid = "0";

    const r = await restoreAppBackup(backup.backupId, FAST);
    expect(r.success).toBe(true);
    // the fresh data directory keeps the previous one's permissions (not a Talome-only 0700)
    expect(statSync(join(appDir, "pgdata")).mode & 0o777).toBe(0o775);
    // the dump inside the container belongs to the user psql runs as
    const loadHeaders = async () => {
      const headers: Array<{ uid: number; gid: number; mode: number }> = [];
      for (const [i, buf] of dockerState.putArchives.entries()) {
        const p = join(env.root, `load-${i}.tar.gz`);
        wf(p, buf);
        await readTarGz(p, async (h, body) => {
          for await (const _chunk of body) {
            // drain
          }
          if (h.type === "file") headers.push({ uid: h.uid, gid: h.gid, mode: h.mode & 0o777 });
        });
      }
      return headers;
    };
    expect(await loadHeaders()).toEqual([{ uid: 1001, gid: 0, mode: 0o600 }]);

    // Container user unknown: root-owned and readable by any user
    dockerState.execUid = "";
    dockerState.putArchives = [];
    const again = await restoreAppBackup(backup.backupId, FAST);
    expect(again.success).toBe(true);
    expect(await loadHeaders()).toEqual([{ uid: 0, gid: 0, mode: 0o644 }]);
  });

  it("plans the owner and mode of a re-created database data directory", async () => {
    const { freshDataDirPlan } = await import("../backup/restore.js");
    expect(freshDataDirPlan(null, 1000)).toEqual({ mode: 0o700 });
    expect(freshDataDirPlan({ uid: 1000, gid: 1000, mode: 0o40750 }, 1000)).toEqual({ mode: 0o750 });
    expect(freshDataDirPlan({ uid: 999, gid: 999, mode: 0o40700 }, 0)).toEqual({ mode: 0o700, chown: { uid: 999, gid: 999 } });
    // owned by the database user, Talome not root: cannot chown → let that user initialise it
    expect(freshDataDirPlan({ uid: 1001, gid: 0, mode: 0o40700 }, 1000)).toEqual({ mode: 0o777 });
  });

  it("rejects backups without a manifest (legacy format)", async () => {
    const { db } = await import("../db/index.js");
    const { sql } = await import("drizzle-orm");
    db.run(sql`INSERT INTO backups (id, app_id, status, file_path, started_at, completed_at, triggered_by) VALUES ('legacy-1', 'restoreok', 'completed', '/tmp/x.tar.gz', ${new Date().toISOString()}, ${new Date().toISOString()}, 'manual')`);
    const r = await restoreAppBackup("legacy-1", FAST);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/older Talome version/);
  });
});
