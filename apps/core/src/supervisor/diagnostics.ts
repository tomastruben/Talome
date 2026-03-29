// ── Diagnostics Bundle Collection ────────────────────────────────────────────
//
// Collects crash context for AI diagnosis. Uses execSync for git commands and
// os module for system resources. Reads SQLite directly for evolution/audit data.

import { execSync } from "node:child_process";
import { cpus, freemem, totalmem } from "node:os";
import Database from "better-sqlite3";
import type { DiagnosticsBundle } from "./types.js";

// ── System resources ─────────────────────────────────────────────────────────

function getCpuPercent(): number {
  try {
    const cores = cpus();
    const total = cores.reduce((sum, c) => {
      const t = Object.values(c.times).reduce((a, b) => a + b, 0);
      return sum + (1 - c.times.idle / t);
    }, 0);
    return Math.round((total / cores.length) * 100);
  } catch {
    return -1;
  }
}

function getDiskPercent(): number {
  try {
    const out = execSync("df -k / | tail -1", { encoding: "utf-8", timeout: 5000 });
    const parts = out.trim().split(/\s+/);
    // macOS: Use%, Linux: Use%
    const pctStr = parts.find((p) => p.endsWith("%"));
    return pctStr ? parseInt(pctStr, 10) : -1;
  } catch {
    return -1;
  }
}

// ── Git context ──────────────────────────────────────────────────────────────

function gitExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", cwd, timeout: 5000 }).trim();
  } catch {
    return "(unavailable)";
  }
}

// ── DB context ───────────────────────────────────────────────────────────────

function queryEvolutionRuns(sqlite: Database.Database): string {
  try {
    const rows = sqlite.prepare(
      `SELECT id, task, status, started_at, completed_at
       FROM evolution_runs
       ORDER BY started_at DESC LIMIT 5`,
    ).all() as Array<{ id: string; task: string; status: string; started_at: string; completed_at: string | null }>;
    if (rows.length === 0) return "None in last 24 hours";
    return rows
      .map((r) => `  ${r.status.padEnd(12)} ${r.task.slice(0, 60)} (${r.started_at})`)
      .join("\n");
  } catch {
    return "(table not available)";
  }
}

function queryAuditLog(sqlite: Database.Database): string {
  try {
    const rows = sqlite.prepare(
      `SELECT timestamp, action, tier FROM audit_log ORDER BY id DESC LIMIT 5`,
    ).all() as Array<{ timestamp: string; action: string; tier: string }>;
    if (rows.length === 0) return "None";
    return rows
      .map((r) => `  [${r.tier}] ${r.action.slice(0, 80)} (${r.timestamp})`)
      .join("\n");
  } catch {
    return "(table not available)";
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function collectDiagnostics(
  processName: string,
  exitCode: number | null,
  exitSignal: string | null,
  crashCount: number,
  logBuffer: string[],
  projectRoot: string,
  dbPath: string,
): DiagnosticsBundle {
  // Open a read-only DB connection for queries
  let sqlite: Database.Database | null = null;
  let evolutionRuns = "(unavailable)";
  let auditEntries = "(unavailable)";

  try {
    sqlite = new Database(dbPath, { readonly: true });
    sqlite.pragma("journal_mode = WAL");
    evolutionRuns = queryEvolutionRuns(sqlite);
    auditEntries = queryAuditLog(sqlite);
  } catch {
    // DB may not be available — that's fine, we still have other diagnostics
  } finally {
    try { sqlite?.close(); } catch { /* ignore */ }
  }

  const memTotal = totalmem();
  const memFree = freemem();
  const memUsed = memTotal - memFree;

  return {
    processName,
    exitCode,
    exitSignal,
    crashCount,
    logTail: logBuffer.slice(-200).join("\n"),
    recentCommits: gitExec("git log --oneline -5", projectRoot),
    uncommittedChanges: gitExec("git diff --stat", projectRoot),
    systemResources: {
      cpu: getCpuPercent(),
      memPercent: Math.round((memUsed / memTotal) * 100),
      diskPercent: getDiskPercent(),
    },
    recentEvolutionRuns: evolutionRuns,
    recentAuditEntries: auditEntries,
  };
}
