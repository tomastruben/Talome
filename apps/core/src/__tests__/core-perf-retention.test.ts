import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

// Retention runs against an explicit in-memory handle; keep the module from
// opening the real database or reading real settings.
vi.mock("../db/index.js", () => ({ db: { $client: null } }));
vi.mock("../utils/settings.js", () => ({ getSetting: vi.fn(() => undefined) }));

import {
  runRetention,
  deleteInBatches,
  resolveRetentionConfig,
  DEFAULT_RETENTION,
  RETENTION_SETTING_KEYS,
} from "../db/retention.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function createDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, action TEXT NOT NULL, tier TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 1, details TEXT NOT NULL DEFAULT '');
    CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL DEFAULT 'info', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', read INTEGER NOT NULL DEFAULT 0, source_id TEXT, created_at TEXT NOT NULL);
    CREATE TABLE ai_usage_log (id TEXT PRIMARY KEY, model TEXT NOT NULL, tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, context TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE system_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'info', source TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    CREATE TABLE evolution_runs (id TEXT PRIMARY KEY, task TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL);
    CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);
  `);
  return sqlite;
}

let sqlite: Database.Database;

beforeEach(() => {
  sqlite = createDb();
});

afterEach(() => {
  sqlite.close();
});

function count(table: string, where = "1=1"): number {
  return (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

describe("deleteInBatches", () => {
  it("deletes in batches of the given size and yields between batches", async () => {
    const insert = sqlite.prepare("INSERT INTO audit_log (timestamp, action, tier) VALUES (?, 'a', 'read')");
    sqlite.transaction(() => {
      for (let i = 0; i < 2500; i++) insert.run(iso(200));
      for (let i = 0; i < 10; i++) insert.run(iso(1));
    })();

    const runSpy = vi.fn();
    const realPrepare = sqlite.prepare.bind(sqlite);
    const spyDb = new Proxy(sqlite, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (source: string) => {
            const stmt = realPrepare(source);
            return new Proxy(stmt, {
              get(t, p, r) {
                if (p === "run") return (...args: unknown[]) => { runSpy(args); return t.run(...args); };
                return Reflect.get(t, p, r);
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    let immediates = 0;
    const realSetImmediate = globalThis.setImmediate;
    const setImmediateSpy = vi.spyOn(globalThis, "setImmediate").mockImplementation(((cb: () => void) => {
      immediates++;
      return realSetImmediate(cb);
    }) as typeof setImmediate);

    const deleted = await deleteInBatches(spyDb, "audit_log", "timestamp < ?", [iso(90)], 1000);
    setImmediateSpy.mockRestore();

    expect(deleted).toBe(2500);
    expect(runSpy).toHaveBeenCalledTimes(3); // 1000 + 1000 + 500
    expect(runSpy.mock.calls.every(([args]) => (args as unknown[])[1] === 1000)).toBe(true);
    expect(immediates).toBe(2); // yielded after each full batch
    expect(count("audit_log")).toBe(10);
  });
});

describe("runRetention", () => {
  it("prunes each table by its window and keeps recent/unread data", async () => {
    const audit = sqlite.prepare("INSERT INTO audit_log (timestamp, action, tier) VALUES (?, 'a', 'read')");
    const notif = sqlite.prepare("INSERT INTO notifications (title, read, created_at) VALUES ('t', ?, ?)");
    const usage = sqlite.prepare("INSERT INTO ai_usage_log (id, model, context, created_at) VALUES (?, 'm', 'chat', ?)");
    const events = sqlite.prepare("INSERT INTO system_events (id, type, source, message, created_at) VALUES (?, 't', 's', 'm', ?)");
    sqlite.transaction(() => {
      audit.run(iso(100)); audit.run(iso(80));
      notif.run(1, iso(40)); notif.run(1, iso(10)); notif.run(0, iso(400));
      usage.run("u1", iso(95)); usage.run("u2", iso(29));
      events.run("e1", iso(91)); events.run("e2", iso(5));
    })();

    const result = await runRetention({ sqlite, config: DEFAULT_RETENTION, now: NOW });

    expect(result.errors).toEqual({});
    expect(count("audit_log")).toBe(1);
    expect(count("notifications", "read = 1")).toBe(1);
    // Unread notifications are kept forever by default.
    expect(count("notifications", "read = 0")).toBe(1);
    expect(count("ai_usage_log")).toBe(1);
    expect(count("system_events")).toBe(1);
    expect(result.deleted).toMatchObject({
      audit_log: 1,
      notifications_read: 1,
      ai_usage_log: 1,
      system_events: 1,
    });
    // Missing tables (container_events, remediation_log, install_errors) are skipped, not errors.
    expect(result.deleted.container_events).toBeUndefined();
  });

  it("keeps the newest N evolution runs and never deletes running ones", async () => {
    const insert = sqlite.prepare("INSERT INTO evolution_runs (id, task, scope, status, started_at) VALUES (?, 't', 's', ?, ?)");
    sqlite.transaction(() => {
      for (let i = 0; i < 30; i++) insert.run(`r${i}`, "applied", iso(30 - i));
      insert.run("still-running", "running", iso(100));
    })();

    await runRetention({ sqlite, config: { ...DEFAULT_RETENTION, evolutionRunsKeep: 10 }, now: NOW });

    const remaining = (sqlite.prepare("SELECT id FROM evolution_runs ORDER BY started_at DESC").all() as Array<{ id: string }>).map((r) => r.id);
    expect(remaining).toContain("still-running");
    expect(remaining.filter((id) => id !== "still-running")).toEqual(
      Array.from({ length: 10 }, (_, i) => `r${29 - i}`),
    );
  });
});

describe("resolveRetentionConfig", () => {
  it("uses defaults when settings are absent", () => {
    expect(resolveRetentionConfig(() => undefined)).toEqual(DEFAULT_RETENTION);
  });

  it("applies overrides with safety floors", () => {
    const settings: Record<string, string> = {
      [RETENTION_SETTING_KEYS.auditLogDays]: "30",
      [RETENTION_SETTING_KEYS.aiUsageLogDays]: "7", // below the 31-day budget window
      [RETENTION_SETTING_KEYS.readNotificationsDays]: "0", // 0 not allowed here → floor 1
      [RETENTION_SETTING_KEYS.unreadNotificationsDays]: "0", // 0 = keep forever
      [RETENTION_SETTING_KEYS.systemEventsDays]: "garbage",
      [RETENTION_SETTING_KEYS.evolutionRunsKeep]: "2",
    };
    const config = resolveRetentionConfig((k) => settings[k]);
    expect(config.auditLogDays).toBe(30);
    expect(config.aiUsageLogDays).toBe(31);
    expect(config.readNotificationsDays).toBe(1);
    expect(config.unreadNotificationsDays).toBe(0);
    expect(config.systemEventsDays).toBe(DEFAULT_RETENTION.systemEventsDays);
    expect(config.evolutionRunsKeep).toBe(10);
  });
});
