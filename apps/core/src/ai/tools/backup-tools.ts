/**
 * App backup and restore tools — volume-level snapshot backup/restore for
 * installed apps. Creates tarball archives of app volumes.
 *
 * Key design decisions:
 * - Async exec (not execSync) to avoid blocking the event loop
 * - Live backup by default (no pause/stop) — CasaOS-style
 * - Only config volumes backed up by default (relative paths like ./config, ./data)
 *   Media mounts (absolute paths outside compose dir) are excluded unless explicitly selected
 * - Per-app concurrency lock to prevent overlapping backups
 * - Cancellable — child processes tracked and killable mid-flight
 */

import { tool } from "ai";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { resolve, join, dirname, basename } from "node:path";
import { exec as execCb, type ChildProcess, type ExecOptions } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { writeAuditEntry } from "../../db/audit.js";
import { writeNotification } from "../../db/notifications.js";

const BACKUP_BASE = join(process.env.HOME || "/tmp", ".talome", "backups", "apps");

/**
 * Validate that a tar archive does not contain path traversal entries.
 * Rejects any entry that starts with `/` (absolute path) or contains `..`.
 */
async function validateTarSafety(archivePath: string): Promise<{ safe: boolean; reason?: string }> {
  try {
    const { promise } = execAbortable(`tar -tzf "${archivePath}"`, { timeout: 60_000 });
    const listing = await promise;
    const entries = listing.split("\n").filter(Boolean);
    for (const entry of entries) {
      if (entry.startsWith("/")) {
        return { safe: false, reason: `Archive contains absolute path entry: "${entry}"` };
      }
      if (entry.includes("..")) {
        return { safe: false, reason: `Archive contains path traversal entry: "${entry}"` };
      }
    }
    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `Failed to list archive contents: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// Timeouts — generous to handle large volumes without ETIMEDOUT
const DOCKER_TIMEOUT = 120_000;      // 2 min for docker compose operations
const TAR_CREATE_TIMEOUT = 600_000;   // 10 min for archive creation
const TAR_EXTRACT_TIMEOUT = 600_000;  // 10 min for archive extraction

// ── Concurrency + progress + cancel ────────────────────────────────────────

const activeBackups = new Set<string>();
const backupProgress = new Map<string, { backupId: string; stage: string; startedAt: number }>();

interface BackupHandle {
  kill: () => void;
  cancelled: boolean;
}
const activeHandles = new Map<string, BackupHandle>();

export function isBackupActive(appId?: string): boolean {
  return appId ? activeBackups.has(appId) : activeBackups.size > 0;
}

export function getActiveBackupProgress(): Map<string, { backupId: string; stage: string; startedAt: number }> {
  return backupProgress;
}

/** Cancel a running backup. Returns true if a backup was found and cancelled. */
export function cancelBackup(appId: string): boolean {
  const handle = activeHandles.get(appId);
  if (!handle) return false;
  handle.cancelled = true;
  handle.kill();
  return true;
}

function log(msg: string) {
  console.log(`[backup] ${msg}`);
}

function setStage(appId: string, backupId: string, stage: string) {
  backupProgress.set(appId, { backupId, stage, startedAt: backupProgress.get(appId)?.startedAt ?? Date.now() });
  log(`${appId}: ${stage}`);
}

// ── Abortable exec ─────────────────────────────────────────────────────────

/** exec wrapper that returns a killable child process handle alongside the promise. */
function execAbortable(cmd: string, options: ExecOptions & { timeout?: number }): { promise: Promise<string>; kill: () => void } {
  let child: ChildProcess | null = null;
  const promise = new Promise<string>((resolve, reject) => {
    child = execCb(cmd, options, (err, stdout) => {
      if (err) reject(err);
      else resolve(typeof stdout === "string" ? stdout : stdout?.toString() ?? "");
    });
  });
  return { promise, kill: () => child?.kill("SIGTERM") };
}

// ── Volume discovery + classification ──────────────────────────────────────

export interface VolumeInfo {
  /** Resolved absolute path on host */
  path: string;
  /** Original path from compose (e.g. "./config", "/mnt/media") */
  raw: string;
  /** Container mount target (e.g. "/config") */
  target: string;
  /** "config" = relative/local app data, "media" = absolute path outside compose dir */
  type: "config" | "media";
  exists: boolean;
}

function classifyVolumes(composePath: string): VolumeInfo[] {
  try {
    const content = readFileSync(composePath, "utf-8");
    const parsed = parseYaml(content) as Record<string, any>;
    const services = parsed.services ?? {};
    const composeDir = dirname(composePath);
    const seen = new Set<string>();
    const volumes: VolumeInfo[] = [];

    for (const svc of Object.values(services) as any[]) {
      for (const vol of svc.volumes ?? []) {
        let raw: string;
        let target = "";

        if (typeof vol === "string") {
          const parts = vol.split(":");
          raw = parts[0];
          target = parts[1] ?? "";
        } else if (vol && typeof vol === "object" && vol.source) {
          raw = vol.source as string;
          target = (vol.target as string) ?? "";
        } else {
          continue;
        }

        // Skip system paths
        if (raw.startsWith("/var/run") || raw.startsWith("/etc")) continue;

        const resolved = raw.startsWith("/") ? raw : resolve(composeDir, raw);
        if (seen.has(resolved)) continue;
        seen.add(resolved);

        // Classify: relative paths or paths under compose dir → config, everything else → media
        const isRelative = !raw.startsWith("/");
        const isUnderComposeDir = resolved.startsWith(composeDir + "/");
        const type = isRelative || isUnderComposeDir ? "config" : "media";

        volumes.push({
          path: resolved,
          raw,
          target,
          type,
          exists: existsSync(resolved),
        });
      }
    }

    return volumes;
  } catch (err) {
    console.error("[backup] classifyVolumes error:", err);
    return [];
  }
}

/** Get classified volume info for an app. Exported for the API route. */
export function getAppVolumeInfo(appId: string): VolumeInfo[] | null {
  const composePath = getInstalledAppComposePath(appId);
  if (!composePath) return null;
  return classifyVolumes(composePath);
}

function getInstalledAppComposePath(appId: string): string | null {
  try {
    const row = db
      .select()
      .from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId))
      .get();
    return row?.overrideComposePath ?? null;
  } catch {
    return null;
  }
}

/**
 * Resume a suspended app after backup. Tries the matching resume method first,
 * then escalates through fallbacks to ensure the app comes back up.
 */
async function resumeApp(
  composePath: string,
  composeDir: string,
  appId: string,
  suspendMethod: "paused" | "stopped" | null,
): Promise<void> {
  if (!suspendMethod) return;

  try {
    if (suspendMethod === "paused") {
      log(`Unpausing ${appId}...`);
      const { promise } = execAbortable(`docker compose -f "${composePath}" unpause`, {
        cwd: composeDir,
        timeout: DOCKER_TIMEOUT,
      });
      await promise;
      log(`${appId} unpaused`);
    } else {
      log(`Starting ${appId}...`);
      const { promise } = execAbortable(`docker compose -f "${composePath}" start`, {
        cwd: composeDir,
        timeout: DOCKER_TIMEOUT,
      });
      await promise;
      log(`${appId} started`);
    }
  } catch (resumeErr) {
    log(`Failed to resume ${appId} via ${suspendMethod === "paused" ? "unpause" : "start"} — trying up -d`);
    console.error(`[backup] Resume failure for ${appId}:`, resumeErr);

    try {
      const { promise } = execAbortable(`docker compose -f "${composePath}" up -d`, {
        cwd: composeDir,
        timeout: DOCKER_TIMEOUT,
      });
      await promise;
      log(`${appId} recovered via up -d`);
    } catch (forceErr) {
      console.error(`[backup] CRITICAL: all resume attempts failed for ${appId}:`, forceErr);
      writeNotification(
        "critical",
        `${appId} not restarted after backup`,
        `App could not be resumed after backup. Manual intervention required.`,
        appId,
      );
    }
  }
}

// ── backup_app ───────────────────────────────────────────────────────────────

export const backupAppTool = tool({
  description: `Create a tarball backup of an installed app's config/data volumes. By default performs a live (hot) backup of config volumes only — media mounts are excluded unless explicitly listed.

The backup is saved to ~/.talome/backups/apps/<appId>/<timestamp>.tar.gz.

After calling: Report the backup file path, size, and which volumes were included.`,
  inputSchema: z.object({
    appId: z.string().describe("The app ID to back up"),
    stopFirst: z.boolean().default(false).describe("Pause the app before backup for strict data consistency (default: false — live backup)"),
    label: z.string().optional().describe("Optional label for the backup (included in filename)"),
    triggeredBy: z.enum(["manual", "schedule"]).default("manual").describe("How the backup was triggered"),
    volumes: z.array(z.string()).optional().describe("Specific volume paths to include. If omitted, only config volumes are backed up (media mounts excluded)."),
  }),
  execute: async ({ appId, stopFirst, label, triggeredBy, volumes: selectedVolumes }) => {
    // Concurrency check
    if (activeBackups.has(appId)) {
      return { success: false, error: `Backup already in progress for '${appId}'.` };
    }

    const composePath = getInstalledAppComposePath(appId);
    if (!composePath) {
      return { success: false, error: `App '${appId}' not found or not installed.` };
    }

    // Classify volumes and filter
    const allVolumes = classifyVolumes(composePath);
    let volumePaths: string[];

    if (selectedVolumes && selectedVolumes.length > 0) {
      // User explicitly selected which volumes to include
      const selectedSet = new Set(selectedVolumes);
      volumePaths = allVolumes
        .filter((v) => v.exists && selectedSet.has(v.path))
        .map((v) => v.path);
    } else {
      // Default: config volumes only (safe default — no multi-TB media backups)
      volumePaths = allVolumes
        .filter((v) => v.exists && v.type === "config")
        .map((v) => v.path);
    }

    if (volumePaths.length === 0) {
      return {
        success: false,
        error: `No volumes to back up for '${appId}'.`,
        hint: "The app may use named Docker volumes instead of bind mounts, or only has media mounts. Check with get_app_config.",
      };
    }

    activeBackups.add(appId);

    const composeDir = dirname(composePath);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const labelSlug = label ? `-${label.replace(/[^a-zA-Z0-9-]/g, "")}` : "";
    const backupDir = join(BACKUP_BASE, appId);
    const backupFile = join(backupDir, `${ts}${labelSlug}.tar.gz`);

    mkdirSync(backupDir, { recursive: true });

    const backupId = randomUUID();
    const startedAt = new Date().toISOString();

    // Record pending backup
    try {
      db.run(sql`INSERT INTO backups (id, app_id, status, started_at, triggered_by) VALUES (${backupId}, ${appId}, 'running', ${startedAt}, ${triggeredBy})`);
    } catch (err) {
      console.error("[backup] failed to insert backup record:", err);
    }

    // Set up cancellation handle
    const handle: BackupHandle = { kill: () => {}, cancelled: false };
    activeHandles.set(appId, handle);
    setStage(appId, backupId, "preparing");

    let suspendMethod: "paused" | "stopped" | null = null;

    try {
      // Only suspend if explicitly requested — default is live backup (no service interruption)
      if (stopFirst) {
        setStage(appId, backupId, "pausing");
        try {
          const op = execAbortable(`docker compose -f "${composePath}" pause`, {
            cwd: composeDir,
            timeout: DOCKER_TIMEOUT,
          });
          handle.kill = op.kill;
          await op.promise;
          suspendMethod = "paused";
        } catch {
          if (handle.cancelled) throw new Error("Backup cancelled");
          try {
            const op = execAbortable(`docker compose -f "${composePath}" stop`, {
              cwd: composeDir,
              timeout: DOCKER_TIMEOUT,
            });
            handle.kill = op.kill;
            await op.promise;
            suspendMethod = "stopped";
          } catch {
            if (handle.cancelled) throw new Error("Backup cancelled");
            log(`${appId} may not be running — proceeding with live backup`);
          }
        }
      }

      if (handle.cancelled) throw new Error("Backup cancelled");

      // Create tarball of selected volume paths
      setStage(appId, backupId, "archiving");
      const pathArgs = volumePaths.map((p) => `"${p}"`).join(" ");
      const tarOp = execAbortable(`tar -czf "${backupFile}" ${pathArgs}`, {
        timeout: TAR_CREATE_TIMEOUT,
      });
      handle.kill = tarOp.kill;
      await tarOp.promise;

      if (handle.cancelled) throw new Error("Backup cancelled");

      // Validate the backup archive
      setStage(appId, backupId, "validating");
      const stat = statSync(backupFile);
      if (stat.size === 0) {
        throw new Error("Backup archive is empty — tar may have failed silently");
      }

      log(`Archive created for ${appId}: ${(stat.size / 1024 / 1024).toFixed(1)} MB (${volumePaths.length} volume(s))`);

      writeAuditEntry(`Backup: ${appId}`, "modify", JSON.stringify({
        backupFile,
        volumes: volumePaths,
        sizeBytes: stat.size,
        suspendMethod: suspendMethod ?? "live",
      }));

      // Record completed backup
      const completedAt = new Date().toISOString();
      try {
        db.run(sql`UPDATE backups SET status = 'completed', file_path = ${backupFile}, size_bytes = ${stat.size}, completed_at = ${completedAt} WHERE id = ${backupId}`);
      } catch (err) {
        console.error("[backup] failed to update backup record to completed:", err);
      }

      return {
        success: true,
        appId,
        backupFile,
        sizeBytes: stat.size,
        sizeMb: Math.round(stat.size / (1024 * 1024) * 10) / 10,
        volumes: volumePaths,
        suspendMethod: suspendMethod ?? "live",
        timestamp: ts,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isCancelled = handle.cancelled || errMsg === "Backup cancelled";
      log(isCancelled ? `Backup cancelled for ${appId}` : `Backup failed for ${appId}: ${errMsg}`);

      // Clean up partial/empty backup file
      try {
        if (existsSync(backupFile)) {
          unlinkSync(backupFile);
          log(`Cleaned up partial backup file for ${appId}`);
        }
      } catch {}

      // Record failed/cancelled backup
      const status = isCancelled ? "cancelled" : "failed";
      const errorMsg = isCancelled ? "Cancelled by user" : errMsg;
      try {
        db.run(sql`UPDATE backups SET status = ${status}, error = ${errorMsg}, completed_at = ${new Date().toISOString()} WHERE id = ${backupId}`);
      } catch (dbErr) {
        console.error("[backup] failed to update backup record:", dbErr);
      }

      return {
        success: false,
        error: errorMsg,
      };
    } finally {
      // Always resume services if we suspended them
      if (suspendMethod) {
        setStage(appId, backupId, "resuming");
        await resumeApp(composePath, composeDir, appId, suspendMethod);
      }
      backupProgress.delete(appId);
      activeBackups.delete(appId);
      activeHandles.delete(appId);
    }
  },
});

// ── restore_app ──────────────────────────────────────────────────────────────

export const restoreAppTool = tool({
  description: `Restore an app's data volumes from a previously created backup. Stops the app, extracts the backup archive, then restarts it.

Lists available backups if no specific backup file is provided.

After calling: Report what was restored, the backup date, and verify the app restarted. Warn about any data that was overwritten.`,
  inputSchema: z.object({
    appId: z.string().describe("The app ID to restore"),
    backupFile: z.string().optional().describe("Full path to the backup .tar.gz file. Omit to list available backups."),
  }),
  execute: async ({ appId, backupFile }) => {
    const composePath = getInstalledAppComposePath(appId);
    if (!composePath) {
      return { success: false, error: `App '${appId}' not found or not installed.` };
    }

    const backupDir = join(BACKUP_BASE, appId);

    // If no backup file specified, list available backups
    if (!backupFile) {
      if (!existsSync(backupDir)) {
        return { success: false, error: `No backups found for '${appId}'.` };
      }
      const files = readdirSync(backupDir)
        .filter((f) => f.endsWith(".tar.gz"))
        .sort()
        .reverse();
      if (files.length === 0) {
        return { success: false, error: `No backup archives found in ${backupDir}.` };
      }
      return {
        success: true,
        action: "list",
        appId,
        backups: files.map((f) => ({
          file: join(backupDir, f),
          name: f,
          sizeBytes: statSync(join(backupDir, f)).size,
          sizeMb: Math.round(statSync(join(backupDir, f)).size / (1024 * 1024) * 10) / 10,
        })),
        hint: "Call restore_app again with the backupFile parameter to restore a specific backup.",
      };
    }

    // Validate backup file exists
    const resolvedBackup = resolve(backupFile);
    if (!existsSync(resolvedBackup)) {
      return { success: false, error: `Backup file not found: ${resolvedBackup}` };
    }

    const composeDir = dirname(composePath);

    try {
      // Stop the app (full stop for restore — need to replace files)
      log(`Stopping ${appId} for restore...`);
      try {
        const { promise } = execAbortable(`docker compose -f "${composePath}" stop`, {
          cwd: composeDir,
          timeout: DOCKER_TIMEOUT,
        });
        await promise;
      } catch {}

      // Validate archive safety before extracting
      log(`Validating archive safety for ${appId}...`);
      const safety = await validateTarSafety(resolvedBackup);
      if (!safety.safe) {
        // Restart the app even though restore didn't proceed
        try {
          const { promise } = execAbortable(`docker compose -f "${composePath}" up -d`, {
            cwd: composeDir,
            timeout: DOCKER_TIMEOUT,
          });
          await promise;
        } catch {}
        return {
          success: false,
          error: `Unsafe archive rejected: ${safety.reason}`,
          hint: "The archive contains entries that could write outside the expected directories. This may indicate a tampered backup.",
        };
      }

      // Extract backup (tar preserves absolute paths)
      log(`Restoring ${appId} from ${basename(resolvedBackup)}...`);
      const { promise: extractPromise } = execAbortable(`tar -xzf "${resolvedBackup}" -C /`, {
        timeout: TAR_EXTRACT_TIMEOUT,
      });
      await extractPromise;

      // Restart the app
      log(`Starting ${appId} after restore...`);
      const { promise: startPromise } = execAbortable(`docker compose -f "${composePath}" up -d`, {
        cwd: composeDir,
        timeout: DOCKER_TIMEOUT,
      });
      await startPromise;
      log(`${appId} restored and restarted`);

      writeAuditEntry(`Restore: ${appId}`, "destructive", JSON.stringify({
        backupFile: resolvedBackup,
      }));

      return {
        success: true,
        action: "restore",
        appId,
        restoredFrom: resolvedBackup,
        message: `App '${appId}' restored from backup and restarted.`,
      };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Restore failed for ${appId}: ${errMsg}`);

      // Try to restart even if restore failed
      try {
        const { promise } = execAbortable(`docker compose -f "${composePath}" up -d`, {
          cwd: composeDir,
          timeout: DOCKER_TIMEOUT,
        });
        await promise;
      } catch {}
      return {
        success: false,
        error: errMsg,
        hint: "The app has been restarted with its previous data. The restore may have partially completed.",
      };
    }
  },
});
