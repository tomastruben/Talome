import { describe, it, expect, vi, afterAll } from "vitest";
import { prepareBackupEnv, installFakeApp, resetDocker } from "./helpers/backups-fixture.js";

// Scheduled backup outcomes use the same titles for every app ("Backup
// failed", "Backup completed"). They are written after the backup operation
// has finished, so the per-operation outcome dedupe does not cover them: they
// must not be dropped by the 10-minute exact-title dedupe either, or one
// app's failure hides another's.

vi.mock("../backup/docker-ops.js", async () => (await import("./helpers/backups-fixture.js")).dockerOpsMock());
vi.mock("../notifications/channels.js", () => ({ dispatchToChannels: vi.fn(async () => {}) }));
vi.mock("../routes/notifications.js", () => ({ pushToMessaging: vi.fn(async () => {}) }));

const env = prepareBackupEnv("backups-scheduler-notifications");
const { runMigrations } = await import("../db/migrate.js");
runMigrations();
const { db, schema } = await import("../db/index.js");
const { eq, sql } = await import("drizzle-orm");
const scheduler = await import("../backup/scheduler.js");

afterAll(() => env.cleanup());

const COMPOSE = `services:
  app:
    image: example/app:1.0
    volumes:
      - ./config:/config
`;

function addSchedule(id: string, appId: string) {
  db.run(sql`INSERT INTO backup_schedules (id, app_id, cron, retention_days, enabled, created_at)
    VALUES (${id}, ${appId}, '0 3 * * *', 30, 1, ${new Date().toISOString()})`);
  return db.get(sql`SELECT * FROM backup_schedules WHERE id = ${id}`) as import("../backup/scheduler.js").ScheduleRow;
}

function rows(title: string) {
  return db.select().from(schema.notifications).where(eq(schema.notifications.title, title)).all();
}

describe("scheduled backup outcome notifications", () => {
  it("notifies every app's failure, even when two apps fail within minutes", async () => {
    // Neither app is installed: both backups fail
    const a = await scheduler.runScheduledBackup(addSchedule("s-fa", "fail-a"), "fail-a");
    const b = await scheduler.runScheduledBackup(addSchedule("s-fb", "fail-b"), "fail-b");
    expect(a.success).toBe(false);
    expect(b.success).toBe(false);
    const failed = rows("Backup failed");
    expect(failed.map((r) => r.sourceId).sort()).toEqual(["fail-a", "fail-b"]);
  });

  it("notifies every app's completed backup", async () => {
    await installFakeApp(env.root, "ok-a", COMPOSE, { "config/a.txt": "a" });
    await installFakeApp(env.root, "ok-b", COMPOSE, { "config/a.txt": "b" });
    resetDocker([]);
    expect((await scheduler.runScheduledBackup(addSchedule("s-oa", "ok-a"), "ok-a")).success).toBe(true);
    expect((await scheduler.runScheduledBackup(addSchedule("s-ob", "ok-b"), "ok-b")).success).toBe(true);
    expect(rows("Backup completed").map((r) => r.sourceId).sort()).toEqual(["ok-a", "ok-b"]);
  });
});
