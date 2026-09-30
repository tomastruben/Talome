import { describe, it, expect, vi, beforeAll } from "vitest";

// Outcome notifications (update, rollback, restore, …) must never be dropped
// by the title/source cooldowns: two rollbacks two minutes apart are two
// events. They are de-duplicated per operation instead.

vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${tmp}/talome-notif-dedupe-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

vi.mock("../notifications/channels.js", () => ({ dispatchToChannels: vi.fn(async () => {}) }));
vi.mock("../routes/notifications.js", () => ({ pushToMessaging: vi.fn(async () => {}) }));

import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { writeNotification } from "../db/notifications.js";
import { withAppOperation } from "../ops/operations.js";

beforeAll(() => {
  runMigrations();
});

function rows(title: string) {
  return db.select().from(schema.notifications).where(eq(schema.notifications.title, title)).all();
}

describe("outcome notifications", () => {
  it("writes every rollback of an update, even with the same title minutes apart", async () => {
    for (let i = 0; i < 2; i++) {
      await withAppOperation("probe-a", "update", "test", async () => {
        writeNotification("warning", "Update of Update Probe rolled back", `attempt ${i}`, "probe-a");
        return { success: false };
      });
    }
    expect(rows("Update of Update Probe rolled back")).toHaveLength(2);
  });

  it("writes a successful update after an earlier one inside the 'updated' cooldown", async () => {
    for (let i = 0; i < 2; i++) {
      await withAppOperation("probe-b", "update", "test", async () => {
        writeNotification("info", "Update Probe updated", `to ${i}`, "probe-b");
        return { success: true };
      });
    }
    expect(rows("Update Probe updated")).toHaveLength(2);
  });

  it("does not let a long app name's 30-character prefix merge different outcomes", async () => {
    const name = "A Rather Long Application Name For Testing";
    await withAppOperation("probe-c", "update", "test", async () => {
      writeNotification("warning", `Update of ${name} aborted`, "", "probe-c");
      return { success: false };
    });
    await withAppOperation("probe-c", "update", "test", async () => {
      writeNotification("critical", `Update of ${name} failed`, "", "probe-c");
      return { success: false };
    });
    expect(rows(`Update of ${name} aborted`)).toHaveLength(1);
    expect(rows(`Update of ${name} failed`)).toHaveLength(1);
  });

  it("writes each restore outcome", async () => {
    for (let i = 0; i < 2; i++) {
      await withAppOperation("probe-d", "restore", "test", async () => {
        writeNotification("info", "probe-d restored", "", "probe-d");
        return { success: true };
      });
    }
    expect(rows("probe-d restored")).toHaveLength(2);
  });

  it("still de-duplicates the same title within one operation", async () => {
    await withAppOperation("probe-e", "update", "test", async () => {
      writeNotification("warning", "Update of E rolled back", "", "probe-e");
      writeNotification("warning", "Update of E rolled back", "", "probe-e");
      return { success: false };
    });
    expect(rows("Update of E rolled back")).toHaveLength(1);
  });

  it("de-duplicates by an explicit operation id", () => {
    writeNotification("info", "F restored", "", "probe-f", { operationId: "op-1" });
    writeNotification("info", "F restored", "", "probe-f", { operationId: "op-1" });
    writeNotification("info", "F restored", "", "probe-f", { operationId: "op-2" });
    expect(rows("F restored")).toHaveLength(2);
  });

  it("keeps the title dedupe for notifications outside an outcome operation", async () => {
    writeNotification("info", "CPU usage high", "", "monitor");
    writeNotification("info", "CPU usage high", "", "monitor");
    expect(rows("CPU usage high")).toHaveLength(1);
    // start/stop/restart failures can repeat in automated loops — still cooled down
    for (let i = 0; i < 2; i++) {
      await withAppOperation("probe-g", "start", "test", async () => {
        writeNotification("critical", "Failed to start G", "", "probe-g");
        return { success: false };
      });
    }
    expect(rows("Failed to start G")).toHaveLength(1);
  });
});
