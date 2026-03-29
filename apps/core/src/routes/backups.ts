import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { backupAppTool, getActiveBackupProgress, getAppVolumeInfo, cancelBackup } from "../ai/tools/backup-tools.js";

export const backups = new Hono();

// Get backup history — enriched with real-time stage for running backups
backups.get("/", (c) => {
  const limit = Number(c.req.query("limit") ?? "50");
  const rows = db.all(sql`SELECT * FROM backups ORDER BY started_at DESC LIMIT ${limit}`) as Array<Record<string, unknown>>;

  // Merge in-memory progress stages for running backups
  const progress = getActiveBackupProgress();
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
  const runningCount = getActiveBackupProgress().size;
  return c.json({ lastBackup, nextSchedule, failedCount, runningCount });
});

// Get volume info for an app (used by UI to show volume selection)
backups.get("/volumes/:appId", (c) => {
  const appId = c.req.param("appId");
  const volumes = getAppVolumeInfo(appId);
  if (!volumes) return c.json({ error: `App '${appId}' not found` }, 404);
  return c.json(volumes);
});

// List schedules
backups.get("/schedules", (c) => {
  const rows = db.all(sql`SELECT * FROM backup_schedules ORDER BY created_at DESC`);
  return c.json(rows);
});

// Create schedule
const scheduleSchema = z.object({
  appId: z.string().nullable().optional(),
  cron: z.string().min(1),
  cloudTarget: z.string().nullable().optional(),
  retentionDays: z.number().min(1).default(30),
});

backups.post("/schedules", async (c) => {
  const body = scheduleSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const id = randomUUID();
  const now = new Date().toISOString();
  const { appId, cron, cloudTarget, retentionDays } = body.data;

  db.run(sql`INSERT INTO backup_schedules (id, app_id, cron, cloud_target, retention_days, created_at) VALUES (${id}, ${appId ?? null}, ${cron}, ${cloudTarget ?? null}, ${retentionDays}, ${now})`);

  return c.json({ id, cron, retentionDays }, 201);
});

// Delete schedule
backups.delete("/schedules/:id", (c) => {
  const id = c.req.param("id");
  db.run(sql`DELETE FROM backup_schedules WHERE id = ${id}`);
  return c.json({ ok: true });
});

// Trigger immediate backup — fires in background, returns immediately
const triggerSchema = z.object({
  appId: z.string().min(1),
  volumes: z.array(z.string()).optional(),
});

backups.post("/trigger", async (c) => {
  const body = triggerSchema.safeParse(await c.req.json());
  if (!body.success) return c.json({ error: body.error.flatten() }, 400);

  const execute = backupAppTool.execute;
  if (!execute) return c.json({ ok: false, error: "Backup tool not available" }, 500);

  // Fire and forget — backup runs in background, UI polls /api/backups for updates
  void execute(
    {
      appId: body.data.appId,
      stopFirst: false,
      triggeredBy: "manual" as const,
      volumes: body.data.volumes,
    },
    { toolCallId: randomUUID(), messages: [], abortSignal: undefined as unknown as AbortSignal },
  );

  return c.json({ started: true, appId: body.data.appId });
});

// Cancel a running backup
backups.post("/:id/cancel", (c) => {
  const id = c.req.param("id");
  const row = db.get(sql`SELECT app_id, status FROM backups WHERE id = ${id}`) as { app_id: string | null; status: string } | undefined;
  if (!row) return c.json({ error: "Backup not found" }, 404);
  if (row.status !== "running") return c.json({ error: "Backup is not running" }, 409);
  if (!row.app_id) return c.json({ error: "No app ID for this backup" }, 400);

  const cancelled = cancelBackup(row.app_id);
  if (!cancelled) return c.json({ error: "Could not cancel — backup may have already finished" }, 409);

  return c.json({ ok: true, cancelled: true });
});

// Delete a backup record and its archive file
backups.delete("/:id", (c) => {
  const id = c.req.param("id");
  const row = db.get(sql`SELECT file_path, status FROM backups WHERE id = ${id}`) as { file_path: string | null; status: string } | undefined;
  if (!row) return c.json({ error: "Backup not found" }, 404);
  if (row.status === "running") return c.json({ error: "Cannot delete a running backup" }, 409);

  // Remove the archive file from disk
  if (row.file_path) {
    try {
      if (existsSync(row.file_path)) unlinkSync(row.file_path);
    } catch (err) {
      console.error("[backups] failed to delete archive file:", err);
    }
  }

  db.run(sql`DELETE FROM backups WHERE id = ${id}`);
  return c.json({ ok: true });
});
