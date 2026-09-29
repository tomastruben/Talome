import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

vi.hoisted(() => {
  const dir = process.env.TMPDIR || "/tmp";
  process.env.DATABASE_PATH = `${dir}/talome-migrations-concurrency-${process.pid}-${Date.now()}/talome.db`;
});

import { sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { runBackupsMigrations } from "../db/migrations/backups.js";
import { runOpsUpdatesMigrations } from "../db/migrations/ops-updates.js";
import { runStoreCompatMigrations } from "../db/migrations/store-compat.js";
import { runTrustMigrations } from "../db/migrations/trust.js";
import { runWireBackendMigrations } from "../db/migrations/wire-backend.js";
import { runOutcomeProbesMigrations } from "../db/migrations/outcome-probes.js";
import { addColumnIfMissing, tableColumns } from "../db/migrations/columns.js";
import { runStdioMigrations } from "../db/migrations/stdio.js";

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  runMigrations();
  vi.mocked(console.log).mockRestore();
});

afterAll(() => {
  rmSync(dirname(process.env.DATABASE_PATH as string), { recursive: true, force: true });
});

/**
 * Make PRAGMA table_info omit `hidden` columns — i.e. this process read the
 * table before another process (core vs. MCP stdio) added them. The ALTER
 * that follows then hits "duplicate column name". Returns the ALTERs issued.
 */
function simulateConcurrentAlter(hidden: Record<string, readonly string[]>): { alters: string[]; restore: () => void } {
  const client = db.$client;
  const realPrepare = client.prepare.bind(client);
  const alters: string[] = [];
  const spy = vi.spyOn(client, "prepare").mockImplementation(((source: string) => {
    // SQLite reports "duplicate column name" while preparing the ALTER.
    if (/^\s*ALTER TABLE/i.test(source)) alters.push(source.trim());
    const stmt = realPrepare(source);
    const table = /^\s*PRAGMA table_info\((\w+)\)/i.exec(source)?.[1];
    const hide = table ? hidden[table] : undefined;
    if (!hide) return stmt;
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop === "all") {
          return (...args: unknown[]) =>
            (target.all(...(args as [])) as Array<{ name: string }>).filter((row) => !hide.includes(row.name));
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }) as typeof client.prepare);
  return { alters, restore: () => spy.mockRestore() };
}

describe("column migrations racing another process", () => {
  it.each([
    ["backups", runBackupsMigrations, { backups: ["method", "verify_detail"], backup_schedules: ["destination_id", "keep_monthly"] }],
    ["ops-updates", runOpsUpdatesMigrations, { app_operations: ["owner_pid"], update_snapshots: ["previous_env"], automation_runs: ["finished_at"], automation_step_runs: ["step_index"] }],
    ["store-compat", runStoreCompatMigrations, { app_catalog: ["umbrel_meta"], store_sources: ["last_parsed_rev"] }],
    ["trust", runTrustMigrations, { mcp_tokens: ["scopes"], audit_log: ["actor_kind"] }],
    ["wire-backend", runWireBackendMigrations, { notifications: ["link"], automations: ["actor_scopes"] }],
    ["outcome-probes", runOutcomeProbesMigrations, { verification_results: ["summary", "duration_ms"] }],
  ] as const)("%s tolerates a concurrent ALTER between its check and its own ALTER", (_name, run, hidden) => {
    const race = simulateConcurrentAlter(hidden);
    try {
      expect(() => run()).not.toThrow();
    } finally {
      race.restore();
    }
    // The race really happened: the module issued its ALTERs against existing columns.
    expect(race.alters.length).toBeGreaterThan(0);
  });

  it("still reports real errors", () => {
    let error: unknown;
    try {
      addColumnIfMissing("no_such_table_here", "x", "TEXT");
    } catch (err) {
      error = err;
    }
    expect(String((error as Error | undefined)?.cause ?? error)).toMatch(/no such table/);
    expect(() => addColumnIfMissing("backups", "bad name", "TEXT")).toThrow(/Invalid column name/);
  });
});

describe("MCP stdio migrations", () => {
  it("brings a database the new core has not migrated yet up to the stdio process's drizzle schema", () => {
    // A DB last migrated by an older core: no store-compat / backups columns.
    db.run(sql`ALTER TABLE app_catalog DROP COLUMN umbrel_meta`);
    db.run(sql`ALTER TABLE store_sources DROP COLUMN last_parsed_rev`);
    db.run(sql`ALTER TABLE backups DROP COLUMN method`);
    db.run(sql`ALTER TABLE backup_schedules DROP COLUMN destination_id`);
    expect(() => db.select().from(schema.appCatalog).all()).toThrow(/no such column/);

    const stdout = vi.spyOn(console, "log");
    const lines: string[] = [];
    try {
      expect(runStdioMigrations((line) => lines.push(line))).toBe(true);
    } finally {
      // Nothing reached stdout (it carries MCP frames only) — the log went to the callback.
      expect(stdout).not.toHaveBeenCalled();
      stdout.mockRestore();
    }
    expect(lines.join("\n")).toContain("Database migrations complete");

    expect(tableColumns("app_catalog").has("umbrel_meta")).toBe(true);
    expect(tableColumns("store_sources").has("last_parsed_rev")).toBe(true);
    expect(tableColumns("backups").has("method")).toBe(true);
    expect(tableColumns("backup_schedules").has("destination_id")).toBe(true);
    expect(() => db.select().from(schema.appCatalog).all()).not.toThrow();
    expect(() => db.select().from(schema.storeSources).all()).not.toThrow();
    expect(() => db.select().from(schema.backups).all()).not.toThrow();
    expect(() => db.select().from(schema.backupSchedules).all()).not.toThrow();
  });

  it("is what mcp-stdio runs at startup (the full set, not a subset)", () => {
    const source = readFileSync(fileURLToPath(new URL("../mcp-stdio.ts", import.meta.url)), "utf-8");
    expect(source).toMatch(/import \{ runStdioMigrations \} from "\.\/db\/migrations\/stdio\.js"/);
    expect(source).toMatch(/runStdioMigrations\(/);
    expect(source).not.toMatch(/runTrustMigrations\(|runWireBackendMigrations\(/);
    // Before the session is created, so the first tool call sees the migrated schema.
    expect(source.indexOf("runStdioMigrations(")).toBeLessThan(source.indexOf("createMcpSession("));
  });
});
