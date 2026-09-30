import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";

vi.hoisted(() => {
  const dir = process.env.TMPDIR || "/tmp";
  process.env.DATABASE_PATH = `${dir}/talome-migrations-drift-${process.pid}-${Date.now()}/talome.db`;
});

import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { runMigrations } from "../db/migrate.js";
import { tableColumns } from "../db/migrations/columns.js";

/**
 * Early Talome databases (the owner's production one among them) were created
 * with older table shapes that CREATE TABLE IF NOT EXISTS never updates. Seed
 * those legacy shapes before migrating, so a column the code writes but the
 * migrations never add fails here instead of silently on a live server.
 */
function seedLegacyTables(): void {
  const client = db.$client;
  client.exec(`
    CREATE TABLE container_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      container_id TEXT NOT NULL,
      container_name TEXT NOT NULL,
      previous_state TEXT,
      new_state TEXT NOT NULL,
      reason TEXT,
      context TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL
    );
    INSERT INTO container_events (container_id, container_name, new_state, timestamp)
      VALUES ('abc', 'jellyfin', 'running', '2026-03-11T23:33:17.172Z');
    CREATE TABLE install_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      service TEXT,
      command TEXT,
      stderr TEXT,
      parsed_issue TEXT,
      suggestion TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO install_errors (app_id, created_at) VALUES ('sonarr', '2026-03-12T01:00:00.000Z');
  `);
}

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  seedLegacyTables();
  runMigrations();
  runMigrations(); // must be idempotent on the upgraded database
  vi.mocked(console.log).mockRestore();
});

afterAll(() => {
  rmSync(dirname(process.env.DATABASE_PATH as string), { recursive: true, force: true });
});

/** Tables another process creates itself (the terminal daemon owns its own). */
const CREATED_ELSEWHERE = new Set(["terminal_sessions"]);

describe("migrations bring every table to the shape the code uses", () => {
  it("every drizzle table and column exists after migrating a legacy database", () => {
    const problems: string[] = [];
    for (const value of Object.values(schema)) {
      if (!(value instanceof SQLiteTable)) continue;
      const cfg = getTableConfig(value);
      if (CREATED_ELSEWHERE.has(cfg.name)) continue;
      const have = tableColumns(cfg.name);
      if (have.size === 0) {
        problems.push(`missing table ${cfg.name}`);
        continue;
      }
      const missing = cfg.columns.map((c) => c.name).filter((c) => !have.has(c));
      if (missing.length) problems.push(`${cfg.name}: ${missing.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("renames legacy container_events.timestamp to created_at and keeps the rows", () => {
    const cols = tableColumns("container_events");
    expect(cols.has("created_at")).toBe(true);
    expect(cols.has("timestamp")).toBe(false);
    const row = db.$client.prepare("SELECT container_name, created_at FROM container_events WHERE container_id = 'abc'").get();
    expect(row).toEqual({ container_name: "jellyfin", created_at: "2026-03-11T23:33:17.172Z" });
  });

  it("adds the install_errors columns later code writes, keeping existing rows", () => {
    const cols = tableColumns("install_errors");
    expect(cols.has("exit_code")).toBe(true);
    expect(cols.has("variables_involved")).toBe(true);
    const row = db.$client.prepare("SELECT app_id, variables_involved FROM install_errors").get();
    expect(row).toEqual({ app_id: "sonarr", variables_involved: "[]" });
  });
});
