/**
 * Migrations for the MCP stdio process.
 *
 * stdio can start before the main server has migrated the database — after a
 * git pull or an evolution run, until core restarts — or while core is not
 * running at all. Its drizzle schema selects every column of every table it
 * reads (app_catalog.umbrel_meta, store_sources.last_parsed_rev,
 * backups.method, backup_schedules.destination_id, …), so a subset of the
 * migrations is not enough: it runs the full set. Every step is idempotent,
 * and the column helpers tolerate core running the same ALTERs concurrently.
 *
 * stdout carries MCP frames only, so migration console output goes to `log`.
 */

import { format } from "node:util";
import { runMigrations } from "../migrate.js";
import { runTrustMigrations } from "./trust.js";
import { runWireBackendMigrations } from "./wire-backend.js";

/** Run every migration; returns false (after logging) when the full set failed. */
export function runStdioMigrations(log: (line: string) => void): boolean {
  const saved = { log: console.log, info: console.info };
  const toLog = (...args: unknown[]) => log(format(...args));
  console.log = toLog;
  console.info = toLog;
  try {
    runMigrations();
    return true;
  } catch (err) {
    log(`[mcp-stdio] migrations failed: ${err instanceof Error ? err.message : String(err)}`);
    // Still make sure the tables this process always writes (approvals, audit
    // actor columns, notification links) exist, as before the full set ran here.
    for (const [name, step] of [["trust", runTrustMigrations], ["wire-backend", runWireBackendMigrations]] as const) {
      try {
        step();
      } catch (stepErr) {
        log(`[mcp-stdio] ${name} migrations failed: ${stepErr instanceof Error ? stepErr.message : String(stepErr)}`);
      }
    }
    return false;
  } finally {
    console.log = saved.log;
    console.info = saved.info;
  }
}
