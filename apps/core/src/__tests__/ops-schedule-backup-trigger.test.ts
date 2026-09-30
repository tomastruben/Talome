import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

// Per-file SQLite database — must be set before db/index.ts is imported.
vi.hoisted(() => {
  const tmp = process.env.TMPDIR ?? "/tmp";
  process.env.DATABASE_PATH = `${tmp.replace(/\/$/, "")}/talome-schedule-backup-trigger-${process.pid}-${Date.now()}.db`;
});

const m = vi.hoisted(() => ({
  fireTrigger: vi.fn(),
  runScheduledBackup: vi.fn(async () => {}),
}));

// The real automation engine, observed through a spy.
vi.mock("../automation/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../automation/engine.js")>();
  m.fireTrigger.mockImplementation(actual.fireTrigger);
  return { ...actual, fireTrigger: m.fireTrigger };
});
vi.mock("../ai/agent.js", () => ({ runAutomationPrompt: vi.fn(async () => "ok") }));
vi.mock("../ai/automation-safe-tools.js", () => ({ getAutomationSafeToolNames: () => new Set<string>() }));
vi.mock("../approval/engine.js", () => ({ requiresApproval: () => false }));
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));
vi.mock("../docker/client.js", () => ({
  listContainers: vi.fn(async () => []),
  getSystemStats: vi.fn(),
  checkInterContainerConnectivity: vi.fn(async () => []),
  runWithContainerListCache: vi.fn((fn: () => unknown) => fn()),
  restartContainer: vi.fn(async () => {}),
}));
vi.mock("../docker/talome-network.js", () => ({ verifyTalomeNetworkAttachments: vi.fn(async () => ({})) }));
vi.mock("../db/retention.js", () => ({ startRetentionScheduler: vi.fn(() => () => {}) }));
vi.mock("../stores/lifecycle.js", () => ({ refreshAppStatuses: vi.fn(async () => {}) }));
vi.mock("../stores/update-checker.js", () => ({ maybeCheckUpdates: vi.fn() }));
vi.mock("../evolution/suggest.js", () => ({ generateSuggestions: vi.fn() }));
vi.mock("../evolution/auto-execute.js", () => ({ maybeAutoExecute: vi.fn(async () => {}) }));
vi.mock("../setup/triggers.js", () => ({ maybeRunScheduledSetup: vi.fn(async () => {}) }));
vi.mock("../ops/maintenance.js", () => ({ isContainerUnderOperation: vi.fn(() => false) }));
vi.mock("../backup/index.js", () => ({
  runScheduledBackup: m.runScheduledBackup,
  runBackupMaintenance: vi.fn(async () => {}),
}));

import { sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { fireTrigger } from "../automation/engine.js";
import { checkBackupSchedules } from "../monitor.js";
import { writeNotification } from "../db/notifications.js";

function addScheduleAutomation(id: string, trigger: Record<string, unknown>): void {
  db.insert(schema.automations).values({
    id,
    name: `Auto ${id}`,
    enabled: true,
    trigger: JSON.stringify(trigger),
    actions: "[]",
    workflowVersion: 2,
    steps: JSON.stringify([{ id: "s1", type: "notify", level: "info", title: "ran" }]),
    createdAt: new Date().toISOString(),
  }).run();
}

function runsOf(automationId: string): number {
  return db.select().from(schema.automationRuns).all().filter((r) => r.automationId === automationId).length;
}

/** Let the fire-and-forget work started by the monitor settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  db.delete(schema.automationStepRuns).run();
  db.delete(schema.automationRuns).run();
  db.delete(schema.automations).run();
  db.run(sql`DELETE FROM backup_schedules`);
});

describe("backup schedules never fire cron automations", () => {
  it("a backup schedule tick does not run a schedule automation (weekly cron, no app filter)", async () => {
    addScheduleAutomation("weekly-update", { type: "schedule", cron: "0 3 * * 0" });
    // Every minute, all apps (app_id null): due on this tick.
    db.run(sql`INSERT INTO backup_schedules (id, app_id, cron, retention_days, enabled, created_at)
      VALUES ('nightly', NULL, '* * * * *', 7, 1, ${new Date().toISOString()})`);

    await checkBackupSchedules();
    await settle();

    expect(m.fireTrigger).not.toHaveBeenCalledWith("schedule", expect.anything());
    expect(runsOf("weekly-update")).toBe(0);
  });

  it("a per-app backup schedule does not run a schedule automation scoped to the same app", async () => {
    addScheduleAutomation("app-scoped", { type: "schedule", cron: "0 3 * * 0", appId: "sonarr" });
    db.run(sql`INSERT INTO backup_schedules (id, app_id, cron, retention_days, enabled, created_at)
      VALUES ('sonarr-nightly', 'sonarr', '* * * * *', 7, 1, ${new Date().toISOString()})`);

    await checkBackupSchedules();
    await settle();

    expect(runsOf("app-scoped")).toBe(0);
    // The backup itself still runs.
    expect(m.runScheduledBackup).toHaveBeenCalledWith(expect.objectContaining({ id: "sonarr-nightly" }), "sonarr");
  });

  it("the engine runs a schedule automation only on a tick that names it", async () => {
    addScheduleAutomation("nightly-prune", { type: "schedule", cron: "0 4 * * *" });

    // A "schedule" trigger that names no automation (e.g. some other scheduler's tick).
    expect(await fireTrigger("schedule", { scheduleId: "nightly", type: "backup", appId: null })).toEqual([]);
    expect(runsOf("nightly-prune")).toBe(0);

    // Its own cron tick (automation/cron.ts passes its id) runs it.
    const [result] = await fireTrigger("schedule", { automationId: "nightly-prune", cron: "0 4 * * *" });
    expect(result?.success).toBe(true);
    expect(runsOf("nightly-prune")).toBe(1);
  });
});

describe("scheduled backup errors", () => {
  it("notifies each app's error as its own outcome (never title-deduplicated against another app's)", async () => {
    m.runScheduledBackup.mockImplementation(async () => {
      throw new Error("boom");
    });
    for (const appId of ["app-x", "app-y"]) {
      db.run(sql`INSERT INTO backup_schedules (id, app_id, cron, retention_days, enabled, created_at)
        VALUES (${`sched-${appId}`}, ${appId}, '* * * * *', 7, 1, ${new Date().toISOString()})`);
    }

    await checkBackupSchedules();
    await settle();

    for (const appId of ["app-x", "app-y"]) {
      expect(vi.mocked(writeNotification)).toHaveBeenCalledWith("warning", "Backup failed", `${appId}: boom`, appId, { dedupe: false });
    }
    m.runScheduledBackup.mockImplementation(async () => {});
  });
});
