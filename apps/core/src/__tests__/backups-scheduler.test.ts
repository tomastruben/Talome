import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { prepareBackupEnv, installFakeApp, resetDocker } from "./helpers/backups-fixture.js";

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));

const env = prepareBackupEnv("backups-scheduler");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { db } = await import("../db/index.js");
const { sql } = await import("drizzle-orm");
const scheduler = await import("../backup/scheduler.js");
const { listCompletedBackups, setVerifyState } = await import("../backup/store.js");
const { writeNotification } = await import("../db/notifications.js");

afterAll(() => env.cleanup());

const COMPOSE = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
`;

function addSchedule(id: string, appId: string | null, cron: string, createdAt: Date, extra: Record<string, number | null> = {}) {
  db.run(sql`INSERT INTO backup_schedules (id, app_id, cron, retention_days, enabled, created_at, keep_last)
    VALUES (${id}, ${appId}, ${cron}, 30, 1, ${createdAt.toISOString()}, ${extra.keep_last ?? null})`);
  return db.get(sql`SELECT * FROM backup_schedules WHERE id = ${id}`) as import("../backup/scheduler.js").ScheduleRow;
}

describe("scheduled backups", () => {
  it("applies keep-last retention after each successful scheduled backup", async () => {
    await installFakeApp(env.root, "sched", COMPOSE, { "config/a.txt": "a" });
    resetDocker([]);
    const schedule = addSchedule("s-keep", "sched", "0 2 * * *", new Date(), { keep_last: 2 });
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await scheduler.runScheduledBackup(schedule, "sched"));
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(results.every((r) => r.success)).toBe(true);
    const remaining = listCompletedBackups("sched");
    expect(remaining).toHaveLength(2);
    const first = results[0];
    if (first.success) expect(existsSync(first.archivePath)).toBe(false);
    expect(vi.mocked(writeNotification)).toHaveBeenCalledWith("info", "Backup completed", expect.stringContaining("sched"));
  });
});

describe("maintenance checks", () => {
  it("flags apps with a schedule but no recent successful backup", async () => {
    await installFakeApp(env.root, "staleapp", COMPOSE, { "config/a.txt": "a" });
    const now = new Date();
    addSchedule("s-stale", "staleapp", "0 3 * * *", new Date(now.getTime() - 3 * 86_400_000));
    expect(scheduler.findStaleBackups(now).map((a) => a.appId)).toContain("staleapp");

    db.run(sql`INSERT INTO backups (id, app_id, status, started_at, completed_at, triggered_by, purpose)
      VALUES ('recent-ok', 'staleapp', 'completed', ${now.toISOString()}, ${now.toISOString()}, 'schedule', 'schedule')`);
    expect(scheduler.findStaleBackups(now).map((a) => a.appId)).not.toContain("staleapp");
  });

  it("does not flag a schedule that is newer than its interval", async () => {
    await installFakeApp(env.root, "newsched", COMPOSE, { "config/a.txt": "a" });
    addSchedule("s-new", "newsched", "0 3 * * 0", new Date());
    expect(scheduler.findStaleBackups(new Date()).map((a) => a.appId)).not.toContain("newsched");
  });

  it("verifies the backup the dashboard shows, not a newer safety backup", async () => {
    const now = new Date();
    const t1 = new Date(now.getTime() - 3 * 3600_000).toISOString();
    const t2 = new Date(now.getTime() - 2 * 3600_000).toISOString();
    db.run(sql`INSERT INTO backups (id, app_id, status, started_at, completed_at, triggered_by, manifest_path, purpose)
      VALUES ('p-sched', 'purposeapp', 'completed', ${t1}, ${t1}, 'schedule', '/x/manifest.json', 'schedule')`);
    db.run(sql`INSERT INTO backups (id, app_id, status, started_at, completed_at, triggered_by, manifest_path, purpose)
      VALUES ('p-safety', 'purposeapp', 'completed', ${t2}, ${t2}, 'manual', '/x/manifest.json', 'pre-update')`);
    // A verified safety backup doesn't reset the weekly timer either
    setVerifyState("p-safety", "verified", now.toISOString(), "{}");
    const due = scheduler.findBackupsDueForVerification(now);
    expect(due).toContain("p-sched");
    expect(due).not.toContain("p-safety");
  });

  it("selects the newest backup per app for weekly verification", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 3600_000).toISOString();
    db.run(sql`INSERT INTO backups (id, app_id, status, started_at, completed_at, triggered_by, manifest_path)
      VALUES ('v-old', 'verifyapp', 'completed', ${old}, ${old}, 'manual', '/x/manifest.json')`);
    const newer = new Date(now.getTime() - 3600_000).toISOString();
    db.run(sql`INSERT INTO backups (id, app_id, status, started_at, completed_at, triggered_by, manifest_path)
      VALUES ('v-new', 'verifyapp', 'completed', ${newer}, ${newer}, 'manual', '/x/manifest.json')`);
    expect(scheduler.findBackupsDueForVerification(now)).toContain("v-new");
    expect(scheduler.findBackupsDueForVerification(now)).not.toContain("v-old");

    setVerifyState("v-new", "verified", now.toISOString(), "{}");
    expect(scheduler.findBackupsDueForVerification(now)).not.toContain("v-new");

    const eightDaysAgo = new Date(now.getTime() - 8 * 86_400_000).toISOString();
    setVerifyState("v-new", "verified", eightDaysAgo, "{}");
    expect(scheduler.findBackupsDueForVerification(now)).toContain("v-new");
  });

  it("uses GFS counts when set and retention_days otherwise", () => {
    const base = { id: "x", app_id: null, cron: "0 2 * * *", cloud_target: null, retention_days: 14, enabled: 1, last_run_at: null, created_at: "" };
    expect(scheduler.schedulePolicy(base)).toEqual({ keepLast: null, keepDaily: null, keepWeekly: null, keepMonthly: null, maxAgeDays: 14 });
    expect(scheduler.schedulePolicy({ ...base, keep_daily: 7, keep_weekly: 4 })).toEqual({
      keepLast: null,
      keepDaily: 7,
      keepWeekly: 4,
      keepMonthly: null,
    });
  });
});
