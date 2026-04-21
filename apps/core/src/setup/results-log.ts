/**
 * Results Log — Preventing Re-Attempts
 *
 * Tracks every setup attempt so the AI never retries a failed approach.
 * Failed approaches are injected into the AI context each iteration,
 * forcing it to try different strategies.
 */

import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

export interface SetupAttempt {
  id: string;
  runId: string;
  appId: string;
  action: string;
  approach: string;
  status: "success" | "failure" | "skipped";
  result?: string;
  error?: string;
  durationMs: number;
  settingsChanged: string[];
  createdAt: string;
}

interface LogAttemptParams {
  runId: string;
  appId: string;
  action: string;
  approach: string;
  status: "success" | "failure" | "skipped";
  result?: string;
  error?: string;
  durationMs: number;
  settingsChanged?: string[];
}

function generateId(): string {
  return `sa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Log a setup attempt to the database. */
export function logAttempt(params: LogAttemptParams): void {
  const id = generateId();
  const now = new Date().toISOString();
  const settingsChanged = JSON.stringify(params.settingsChanged ?? []);
  const result = params.result ? JSON.stringify(params.result) : null;

  db.run(sql`
    INSERT INTO setup_attempts (id, run_id, app_id, action, approach, status, result, error, duration_ms, settings_changed, created_at)
    VALUES (${id}, ${params.runId}, ${params.appId}, ${params.action}, ${params.approach}, ${params.status}, ${result}, ${params.error ?? null}, ${params.durationMs}, ${settingsChanged}, ${now})
  `);

  // Update attempts count on the run
  db.run(sql`
    UPDATE setup_runs SET attempts_count = attempts_count + 1 WHERE id = ${params.runId}
  `);
}

/** Check if a specific (appId, action, approach) combination has failed before. */
export function hasFailedBefore(appId: string, action: string, approach: string): boolean {
  const row = db.get<{ count: number }>(sql`
    SELECT COUNT(*) as count FROM setup_attempts
    WHERE app_id = ${appId} AND action = ${action} AND approach = ${approach} AND status = 'failure'
  `);
  return (row?.count ?? 0) > 0;
}

/** Get all failed approaches for an app — injected into AI context to prevent retries. */
export function getFailedApproaches(appId: string): Array<{
  action: string;
  approach: string;
  error: string | null;
  timestamp: string;
}> {
  return db.all<{
    action: string;
    approach: string;
    error: string | null;
    timestamp: string;
  }>(sql`
    SELECT action, approach, error, created_at as timestamp
    FROM setup_attempts
    WHERE app_id = ${appId} AND status = 'failure'
    ORDER BY created_at DESC
    LIMIT 50
  `);
}

/** Get all failed approaches across all apps — for global context injection. */
export function getAllFailedApproaches(): Array<{
  appId: string;
  action: string;
  approach: string;
  error: string | null;
  timestamp: string;
}> {
  return db.all<{
    appId: string;
    action: string;
    approach: string;
    error: string | null;
    timestamp: string;
  }>(sql`
    SELECT app_id as appId, action, approach, error, created_at as timestamp
    FROM setup_attempts
    WHERE status = 'failure'
    ORDER BY created_at DESC
    LIMIT 100
  `);
}

/** Get all attempts for a specific run. */
export function getRunAttempts(runId: string): SetupAttempt[] {
  const rows = db.all<{
    id: string;
    run_id: string;
    app_id: string;
    action: string;
    approach: string;
    status: string;
    result: string | null;
    error: string | null;
    duration_ms: number;
    settings_changed: string;
    created_at: string;
  }>(sql`
    SELECT * FROM setup_attempts WHERE run_id = ${runId} ORDER BY created_at ASC
  `);

  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    appId: r.app_id,
    action: r.action,
    approach: r.approach,
    status: r.status as SetupAttempt["status"],
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    durationMs: r.duration_ms,
    settingsChanged: JSON.parse(r.settings_changed) as string[],
    createdAt: r.created_at,
  }));
}

/** Get recent attempts (last N) across all runs. */
export function getRecentAttempts(limit = 20): SetupAttempt[] {
  const rows = db.all<{
    id: string;
    run_id: string;
    app_id: string;
    action: string;
    approach: string;
    status: string;
    result: string | null;
    error: string | null;
    duration_ms: number;
    settings_changed: string;
    created_at: string;
  }>(sql`
    SELECT * FROM setup_attempts ORDER BY created_at DESC LIMIT ${limit}
  `);

  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    appId: r.app_id,
    action: r.action,
    approach: r.approach,
    status: r.status as SetupAttempt["status"],
    result: r.result ?? undefined,
    error: r.error ?? undefined,
    durationMs: r.duration_ms,
    settingsChanged: JSON.parse(r.settings_changed) as string[],
    createdAt: r.created_at,
  }));
}
