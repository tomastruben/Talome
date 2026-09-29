import { Hono, type Context } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { snapshotNow } from "../services/self-backup.js";
import { requireRole } from "../middleware/role-guard.js";
import {
  deleteBackup,
  verifyBackup,
  loadManifest,
  getAppBackupConfig,
  setAppBackupConfig,
  getBackupRow,
  listAppBackups,
  listRestores,
  getRestoreRow,
  getBackupProgress,
  cancelAppBackup,
  getAppOperation,
  resolveMethod,
  appBackupConfigPatchSchema,
  CONFIGURED_METHODS,
} from "../backup/index.js";
import { bindVolumes, resolveAppContext } from "../backup/compose.js";
import { backupBlockedReason, runBackupOperation, runRestoreOperation, startInBackground } from "../backup/operation.js";
import {
  createDestination,
  createDestinationSchema,
  deleteDestination,
  getDestination,
  validateLegacyCloudTarget,
  listDestinations,
  testDestination,
} from "../backup/destinations.js";

export const backups = new Hono();

// Reads are open to every signed-in user. Anything that changes backups,
// schedules, destinations or per-app settings — or stops apps — is admin-only.
const adminOnly = requireRole("admin");
backups.use("*", async (c, next) => {
  const method = c.req.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  return adminOnly(c, next);
});

/**
 * Self-backup endpoints — for Talome's own SQLite database.
 * `/self` GET lists snapshots, POST takes one immediately.
 */
function resolveSelfBackupDir(): string {
  if (process.env.TALOME_BACKUP_DIR) return process.env.TALOME_BACKUP_DIR;
  if (process.env.NODE_ENV === "production" && process.cwd().startsWith("/app")) {
    return "/app/backups";
  }
  return join(homedir(), ".talome", "backups");
}

backups.get("/self", (c) => {
  const dir = resolveSelfBackupDir();
  try {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("talome-db-") && f.endsWith(".db"))
      .map((f) => {
        const full = join(dir, f);
        const s = statSync(full);
        return { file: f, path: full, sizeBytes: s.size, mtime: s.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return c.json({ directory: dir, snapshots: files });
  } catch {
    return c.json({ directory: dir, snapshots: [] });
  }
});

backups.post("/self", (c) => {
  const result = snapshotNow();
  if (!result.ok) return c.json({ error: result.error }, 500);
  return c.json({ ok: true, path: result.path });
});

// Get backup history — enriched with real-time stage for running backups
backups.get("/", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50") || 50, 1), 500);
  const rows = db.all(sql`SELECT * FROM backups ORDER BY started_at DESC LIMIT ${limit}`) as Array<Record<string, unknown>>;

  // Merge in-memory progress stages for running backups
  const progress = getBackupProgress();
  const enriched = rows.map((row) => {
    const appId = row.app_id as string | null;
    const p = appId ? progress.get(appId) : undefined;
    return {
      ...row,
      stage: row.status === "running" && p ? p.stage : null,
    };
  });

  return c.json(enriched);
});

// Get backup status summary (for widgets)
backups.get("/status", (c) => {
  const lastBackup = db.get(sql`SELECT * FROM backups WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1`) as Record<string, unknown> | undefined;
  const nextSchedule = db.get(sql`SELECT * FROM backup_schedules WHERE enabled = 1 ORDER BY last_run_at ASC LIMIT 1`) as Record<string, unknown> | undefined;
  const failedCount = (db.get(sql`SELECT COUNT(*) as count FROM backups WHERE status = 'failed' AND started_at > datetime('now', '-7 days')`) as { count: number })?.count ?? 0;
  const runningCount = getBackupProgress().size;
  const verifyFailedCount =
    (db.get(sql`SELECT COUNT(*) as count FROM backups WHERE status = 'completed' AND verify_status = 'failed'`) as { count: number } | undefined)?.count ?? 0;
  return c.json({ lastBackup, nextSchedule, failedCount, runningCount, verifyFailedCount });
});

// Get volume info for an app (used by UI to show volume selection)
backups.get("/volumes/:appId", (c) => {
  const appId = c.req.param("appId");
  const ctx = resolveAppContext(appId);
  if (!ctx.ok) return c.json({ error: `App '${appId}' not found` }, 404);
  return c.json(
    bindVolumes(ctx.ctx.compose).map((v) => ({ path: v.hostPath, raw: v.raw, target: v.target, type: v.type, exists: v.exists })),
  );
});

// ── Schedules ─────────────────────────────────────────────────────────────

backups.get("/schedules", (c) => {
  const rows = db.all(sql`SELECT * FROM backup_schedules ORDER BY created_at DESC`);
  return c.json(rows);
});

const keepCount = z.number().int().min(0).max(1000).nullable().optional();

const scheduleSchema = z.object({
  appId: z.string().nullable().optional(),
  cron: z.string().min(1),
  cloudTarget: z.string().nullable().optional(),
  retentionDays: z.number().min(1).default(30),
  destinationId: z.string().nullable().optional(),
  keepLast: keepCount,
  keepDaily: keepCount,
  keepWeekly: keepCount,
  keepMonthly: keepCount,
});

function isValidCron(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  return parts.length === 5 && parts.every((p) => /^[\d*,/-]+$/.test(p));
}

backups.post("/schedules", async (c) => {
  const body = scheduleSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  if (!isValidCron(body.data.cron)) return c.json({ error: "Invalid cron expression (5 fields)" }, 400);
  if (body.data.destinationId && !getDestination(body.data.destinationId)) return c.json({ error: "Destination not found" }, 400);
  let cloudTarget: string | null = null;
  if (body.data.cloudTarget) {
    const v = validateLegacyCloudTarget(body.data.cloudTarget);
    if (!v.ok) return c.json({ error: v.error }, 400);
    cloudTarget = v.target;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const { appId, cron, retentionDays, destinationId, keepLast, keepDaily, keepWeekly, keepMonthly } = body.data;

  db.run(sql`INSERT INTO backup_schedules (id, app_id, cron, cloud_target, retention_days, created_at, destination_id, keep_last, keep_daily, keep_weekly, keep_monthly)
    VALUES (${id}, ${appId ?? null}, ${cron}, ${cloudTarget}, ${retentionDays}, ${now}, ${destinationId ?? null}, ${keepLast ?? null}, ${keepDaily ?? null}, ${keepWeekly ?? null}, ${keepMonthly ?? null})`);

  return c.json({ id, cron, retentionDays }, 201);
});

const schedulePatchSchema = z.object({
  cron: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  retentionDays: z.number().min(1).optional(),
  destinationId: z.string().nullable().optional(),
  keepLast: keepCount,
  keepDaily: keepCount,
  keepWeekly: keepCount,
  keepMonthly: keepCount,
});

backups.patch("/schedules/:id", async (c) => {
  const id = c.req.param("id");
  const body = schedulePatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const existing = db.get(sql`SELECT id FROM backup_schedules WHERE id = ${id}`);
  if (!existing) return c.json({ error: "Schedule not found" }, 404);
  const d = body.data;
  if (d.cron !== undefined && !isValidCron(d.cron)) return c.json({ error: "Invalid cron expression (5 fields)" }, 400);
  if (d.destinationId && !getDestination(d.destinationId)) return c.json({ error: "Destination not found" }, 400);
  if (d.cron !== undefined) db.run(sql`UPDATE backup_schedules SET cron = ${d.cron} WHERE id = ${id}`);
  if (d.enabled !== undefined) db.run(sql`UPDATE backup_schedules SET enabled = ${d.enabled ? 1 : 0} WHERE id = ${id}`);
  if (d.retentionDays !== undefined) db.run(sql`UPDATE backup_schedules SET retention_days = ${d.retentionDays} WHERE id = ${id}`);
  if (d.destinationId !== undefined) db.run(sql`UPDATE backup_schedules SET destination_id = ${d.destinationId} WHERE id = ${id}`);
  if (d.keepLast !== undefined) db.run(sql`UPDATE backup_schedules SET keep_last = ${d.keepLast} WHERE id = ${id}`);
  if (d.keepDaily !== undefined) db.run(sql`UPDATE backup_schedules SET keep_daily = ${d.keepDaily} WHERE id = ${id}`);
  if (d.keepWeekly !== undefined) db.run(sql`UPDATE backup_schedules SET keep_weekly = ${d.keepWeekly} WHERE id = ${id}`);
  if (d.keepMonthly !== undefined) db.run(sql`UPDATE backup_schedules SET keep_monthly = ${d.keepMonthly} WHERE id = ${id}`);
  return c.json(db.get(sql`SELECT * FROM backup_schedules WHERE id = ${id}`));
});

backups.delete("/schedules/:id", (c) => {
  const id = c.req.param("id");
  db.run(sql`DELETE FROM backup_schedules WHERE id = ${id}`);
  return c.json({ ok: true });
});

// ── Trigger ───────────────────────────────────────────────────────────────

// Trigger immediate backup — fires in background, returns immediately
const triggerSchema = z.object({
  appId: z.string().min(1),
  volumes: z.array(z.string()).optional(),
  method: z.enum(CONFIGURED_METHODS).optional(),
  destinationId: z.string().nullable().optional(),
});

/** Actor for the operations journal ("user:<id>" when the session names a user). */
function actorFor(c: Context): string {
  const userId = c.get("sessionUser" as never) as unknown;
  return typeof userId === "string" && userId ? `user:${userId}` : "user";
}

backups.post("/trigger", async (c) => {
  const body = triggerSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const { appId, volumes, method, destinationId } = body.data;
  const blocked = backupBlockedReason(appId);
  if (blocked) return c.json({ error: blocked }, 409);

  // Runs in the background as a journaled "backup" operation — the UI polls
  // /api/backups (or streams /api/operations) for progress.
  const start = await startInBackground((onStarted) =>
    runBackupOperation(
      appId,
      { triggeredBy: "manual", purpose: "manual", volumes, method, destinationId: destinationId ?? null },
      { actor: actorFor(c), onStarted },
    ),
  );
  if (!start.started) return c.json({ error: start.error, operationId: start.operationId }, start.conflict ? 409 : 500);
  return c.json({ started: true, appId, operationId: start.operationId });
});

// ── Per-app overview & config ─────────────────────────────────────────────

interface AppOverviewRow {
  app_id: string;
  display_name: string | null;
  status: string;
}

function summarizeBackup(row: Record<string, unknown> | undefined) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    method: row.method ?? null,
    sizeBytes: row.size_bytes ?? null,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    verifyStatus: row.verify_status ?? null,
    verifiedAt: row.verified_at ?? null,
    purpose: row.purpose ?? null,
    hasManifest: !!row.manifest_path,
    error: row.error ?? null,
  };
}

backups.get("/apps", (c) => {
  const apps = db.all(sql`SELECT ia.app_id, ia.display_name, ia.status, ac.name AS catalog_name, ac.icon, ac.icon_url
    FROM installed_apps ia LEFT JOIN app_catalog ac ON ac.app_id = ia.app_id AND ac.store_source_id = ia.store_source_id
    ORDER BY ia.app_id`) as Array<AppOverviewRow & { catalog_name: string | null; icon: string | null; icon_url: string | null }>;
  const schedules = db.all(sql`SELECT id, app_id, cron FROM backup_schedules WHERE enabled = 1`) as Array<{ id: string; app_id: string | null; cron: string }>;
  const progress = getBackupProgress();

  const result = apps.map((a) => {
    const last = db.get(sql`SELECT * FROM backups WHERE app_id = ${a.app_id} ORDER BY started_at DESC LIMIT 1`) as Record<string, unknown> | undefined;
    const lastSuccess = db.get(
      sql`SELECT * FROM backups WHERE app_id = ${a.app_id} AND status = 'completed' AND (purpose IS NULL OR purpose IN ('manual', 'schedule')) ORDER BY completed_at DESC LIMIT 1`,
    ) as Record<string, unknown> | undefined;
    const count = (db.get(sql`SELECT COUNT(*) AS n FROM backups WHERE app_id = ${a.app_id} AND status = 'completed'`) as { n: number } | undefined)?.n ?? 0;
    const config = getAppBackupConfig(a.app_id);
    const ctx = resolveAppContext(a.app_id);
    const op = getAppOperation(a.app_id);
    return {
      appId: a.app_id,
      name: a.display_name ?? a.catalog_name ?? a.app_id,
      icon: a.icon,
      iconUrl: a.icon_url,
      appStatus: a.status,
      config,
      effectiveMethod: ctx.ok ? resolveMethod(ctx.ctx, config.method) : null,
      databases: ctx.ok
        ? ctx.ctx.compose.services.filter((s) => s.dbEngine).map((s) => ({ service: s.name, engine: s.dbEngine }))
        : [],
      scheduled: schedules.some((s) => s.app_id === null || s.app_id === a.app_id),
      backupCount: count,
      lastBackup: summarizeBackup(last),
      lastSuccessfulBackup: summarizeBackup(lastSuccess),
      operation: op ? { kind: op.kind, id: op.id, stage: op.stage, startedAt: new Date(op.startedAt).toISOString() } : null,
      running: progress.has(a.app_id),
    };
  });
  return c.json(result);
});

backups.get("/apps/:appId", (c) => {
  const appId = c.req.param("appId");
  const ctx = resolveAppContext(appId);
  const config = getAppBackupConfig(appId);
  const op = getAppOperation(appId);
  return c.json({
    appId,
    config,
    effectiveMethod: ctx.ok ? resolveMethod(ctx.ctx, config.method) : null,
    volumes: ctx.ok
      ? bindVolumes(ctx.ctx.compose).map((v) => ({ path: v.hostPath, raw: v.raw, target: v.target, service: v.service, type: v.type, exists: v.exists }))
      : [],
    databases: ctx.ok ? ctx.ctx.compose.services.filter((s) => s.dbEngine).map((s) => ({ service: s.name, engine: s.dbEngine, image: s.image })) : [],
    error: ctx.ok ? null : ctx.error,
    backups: listAppBackups(appId, 100).map((r) => ({
      ...summarizeBackup(r as unknown as Record<string, unknown>),
      triggeredBy: r.triggered_by,
      warnings: r.warnings ? (JSON.parse(r.warnings) as string[]) : [],
      cloudTarget: r.cloud_target,
    })),
    restores: listRestores(appId, 10),
    operation: op ? { kind: op.kind, id: op.id, stage: op.stage, startedAt: new Date(op.startedAt).toISOString() } : null,
  });
});

backups.get("/apps/:appId/config", (c) => c.json(getAppBackupConfig(c.req.param("appId"))));

backups.put("/apps/:appId/config", async (c) => {
  const appId = c.req.param("appId");
  const body = appBackupConfigPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  return c.json(setAppBackupConfig(appId, body.data));
});

// ── Destinations ──────────────────────────────────────────────────────────

backups.get("/destinations", (c) => c.json(listDestinations()));

backups.post("/destinations", requireRole("admin"), async (c) => {
  const body = createDestinationSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);
  const r = createDestination(body.data);
  if (!r.ok) return c.json({ error: r.error }, 400);
  return c.json(r.destination, 201);
});

backups.delete("/destinations/:id", requireRole("admin"), (c) => {
  const r = deleteDestination(c.req.param("id"));
  if (!r.ok) return c.json({ error: r.error }, r.notFound ? 404 : 409);
  return c.json({ ok: true });
});

backups.post("/destinations/:id/test", requireRole("admin"), async (c) => {
  const dest = getDestination(c.req.param("id"));
  if (!dest) return c.json({ error: "Destination not found" }, 404);
  return c.json(await testDestination(dest));
});

// ── Restores ──────────────────────────────────────────────────────────────

backups.get("/restores", (c) => c.json(listRestores(c.req.query("appId") || undefined, 50)));

backups.get("/restores/:id", (c) => {
  const row = getRestoreRow(c.req.param("id"));
  if (!row) return c.json({ error: "Restore not found" }, 404);
  return c.json({ ...row, detail: row.detail ? (JSON.parse(row.detail) as unknown) : null });
});

// ── Per-backup actions ────────────────────────────────────────────────────

backups.post("/:id/verify", async (c) => {
  const id = c.req.param("id");
  const row = getBackupRow(id);
  if (!row) return c.json({ error: "Backup not found" }, 404);
  if (row.status !== "completed") return c.json({ error: "Only completed backups can be verified" }, 409);
  if (row.verify_status === "running") return c.json({ error: "Verification already running" }, 409);
  if (c.req.query("wait") === "true") {
    return c.json(await verifyBackup(id));
  }
  void verifyBackup(id);
  return c.json({ started: true, id }, 202);
});

backups.get("/:id/verification", (c) => {
  const row = getBackupRow(c.req.param("id"));
  if (!row) return c.json({ error: "Backup not found" }, 404);
  let detail: unknown = null;
  try {
    detail = row.verify_detail ? JSON.parse(row.verify_detail) : null;
  } catch {
    detail = row.verify_detail;
  }
  return c.json({ id: row.id, verifyStatus: row.verify_status, verifiedAt: row.verified_at, detail });
});

backups.get("/:id/manifest", async (c) => {
  const row = getBackupRow(c.req.param("id"));
  if (!row) return c.json({ error: "Backup not found" }, 404);
  if (!row.manifest_path) return c.json({ error: "This backup has no manifest (created by an older version)" }, 404);
  const m = await loadManifest(row.manifest_path);
  if (!m.ok) return c.json({ error: m.error }, 500);
  // The file list can be large — return it only on request
  const { files, ...rest } = m.manifest;
  return c.json(c.req.query("files") === "true" ? m.manifest : { ...rest, fileCount: files.length });
});

const restoreSchema = z.object({
  confirm: z.literal(true),
  skipSafetyBackup: z.boolean().optional(),
});

backups.post("/:id/restore", requireRole("admin"), async (c) => {
  const id = c.req.param("id");
  const body = restoreSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "Restoring replaces the app's current data — send { \"confirm\": true } to proceed" }, 400);
  const row = getBackupRow(id);
  if (!row || !row.app_id) return c.json({ error: "Backup not found" }, 404);
  if (row.status !== "completed") return c.json({ error: "Only completed backups can be restored" }, 409);
  if (!row.manifest_path) return c.json({ error: "This backup was made by an older Talome version — restore it through the assistant (restore_app)" }, 409);
  const appId = row.app_id;
  // No restore while an update, install, backup or another restore runs on the app.
  const blocked = backupBlockedReason(appId);
  if (blocked) return c.json({ error: blocked }, 409);

  const restoreId = randomUUID();
  const start = await startInBackground((onStarted) =>
    runRestoreOperation(appId, id, { restoreId, skipSafetyBackup: body.data.skipSafetyBackup }, { actor: actorFor(c), onStarted }),
  );
  if (!start.started) return c.json({ error: start.error, operationId: start.operationId }, start.conflict ? 409 : 500);
  return c.json({ started: true, restoreId, appId, operationId: start.operationId }, 202);
});

// Cancel a running backup
backups.post("/:id/cancel", (c) => {
  const id = c.req.param("id");
  const row = db.get(sql`SELECT app_id, status FROM backups WHERE id = ${id}`) as { app_id: string | null; status: string } | undefined;
  if (!row) return c.json({ error: "Backup not found" }, 404);
  if (row.status !== "running") return c.json({ error: "Backup is not running" }, 409);
  if (!row.app_id) return c.json({ error: "No app ID for this backup" }, 400);

  const cancelled = cancelAppBackup(row.app_id);
  if (!cancelled) return c.json({ error: "Could not cancel — backup may have already finished" }, 409);

  return c.json({ ok: true, cancelled: true });
});

// Delete a backup record and its archive file
backups.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const r = await deleteBackup(id);
  if (!r.ok) return c.json({ error: r.error }, r.error === "Backup not found" ? 404 : 409);
  return c.json({ ok: true });
});
