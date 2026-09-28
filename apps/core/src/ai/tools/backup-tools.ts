/**
 * App backup and restore tools for the assistant.
 *
 * Backups go through the backup engine (apps/core/src/backup): application-
 * consistent (database dumps or a brief stop), checksummed, with a manifest,
 * verifiable and restorable per app with automatic rollback.
 *
 * Archives made by older Talome versions (plain tar.gz of absolute paths, no
 * manifest) can still be restored through restore_app's legacy path.
 */

import { tool } from "ai";
import { z } from "zod";
import { db, schema } from "../../db/index.js";
import { eq, sql } from "drizzle-orm";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { exec as execCb, type ExecOptions } from "node:child_process";
import { writeAuditEntry } from "../../db/audit.js";
import {
  createAppBackup,
  restoreAppBackup,
  verifyBackup,
  getBackupProgress,
  cancelAppBackup,
  isAppBackupRunning,
  CONFIGURED_METHODS,
} from "../../backup/index.js";
import { bindVolumes, resolveAppContext } from "../../backup/compose.js";
import { getBackupRoot } from "../../backup/fs-utils.js";
import { ARCHIVE_FILE_NAME, ARCHIVE_META_DIR, MANIFEST_FILE_NAME } from "../../backup/types.js";

/** Top-level members of archives made by the current backup engine (relative paths). */
const ENGINE_ARCHIVE_PREFIXES = [`${ARCHIVE_META_DIR}/`, "volumes/", "compose/", "dumps/"];

/**
 * True when a file looks like an archive made by the current backup engine
 * (which must be restored by backup id, never extracted to "/").
 */
export function isEngineArchivePath(archivePath: string): boolean {
  return basename(archivePath) === ARCHIVE_FILE_NAME || existsSync(join(dirname(archivePath), MANIFEST_FILE_NAME));
}

const LEGACY_BACKUP_BASE = join(process.env.HOME || "/tmp", ".talome", "backups", "apps");

// Timeouts for the legacy restore path
const DOCKER_TIMEOUT = 120_000;
const TAR_EXTRACT_TIMEOUT = 600_000;

// ── Progress / cancel (delegated to the engine) ─────────────────────────────

export function isBackupActive(appId?: string): boolean {
  return isAppBackupRunning(appId);
}

export function getActiveBackupProgress(): Map<string, { backupId: string; stage: string; startedAt: number }> {
  return getBackupProgress();
}

/** Cancel a running backup. Returns true if a backup was found and cancelled. */
export function cancelBackup(appId: string): boolean {
  return cancelAppBackup(appId);
}

function log(msg: string) {
  console.log(`[backup] ${msg}`);
}

function execPromise(cmd: string, options: ExecOptions & { timeout?: number }): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    execCb(cmd, options, (err, stdout) => {
      if (err) reject(err);
      else resolvePromise(typeof stdout === "string" ? stdout : stdout?.toString() ?? "");
    });
  });
}

/**
 * Validate that a legacy tar archive does not contain path traversal entries.
 * Rejects any entry that starts with `/` (absolute path) or contains `..`.
 */
async function validateTarSafety(archivePath: string): Promise<{ safe: boolean; reason?: string }> {
  try {
    const listing = await execPromise(`tar -tzf "${archivePath}"`, { timeout: 60_000 });
    const entries = listing.split("\n").filter(Boolean);
    for (const entry of entries) {
      if (ENGINE_ARCHIVE_PREFIXES.some((p) => entry === p.slice(0, -1) || entry.startsWith(p))) {
        return { safe: false, reason: "This is a backup made by the current backup engine — restore it by backupId" };
      }
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

// ── Volume discovery ────────────────────────────────────────────────────────

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

/** Get classified volume info for an app. */
export function getAppVolumeInfo(appId: string): VolumeInfo[] | null {
  const ctx = resolveAppContext(appId);
  if (!ctx.ok) return null;
  return bindVolumes(ctx.ctx.compose).map((v) => ({
    path: v.hostPath!,
    raw: v.raw,
    target: v.target,
    type: v.type,
    exists: v.exists,
  }));
}

function getInstalledAppComposePath(appId: string): string | null {
  try {
    const row = db
      .select()
      .from(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId))
      .get();
    if (!row) return null;
    const ctx = resolveAppContext(appId);
    return ctx.ok ? ctx.ctx.composePath : row.overrideComposePath ?? null;
  } catch {
    return null;
  }
}

// ── backup_app ───────────────────────────────────────────────────────────────

export const backupAppTool = tool({
  description: `Create an application-consistent backup of an installed app's config/data volumes.

The consistency method comes from the app's backup settings (default "auto": database dump for apps with Postgres/MySQL, otherwise a brief stop of the app while archiving). Every backup gets a manifest with per-file sha256 checksums and can be verified and restored per app. Media mounts are excluded unless explicitly listed.

After calling: Report the backup size, the method used, which volumes were included, and any warnings.`,
  inputSchema: z.object({
    appId: z.string().describe("The app ID to back up"),
    stopFirst: z.boolean().default(false).describe("Force the stop method (briefly stop the app) for strict file consistency"),
    method: z.enum(CONFIGURED_METHODS).optional().describe("Override the consistency method: auto, dump, stop or live"),
    label: z.string().optional().describe("Optional label (kept for compatibility; not used in file names)"),
    triggeredBy: z.enum(["manual", "schedule"]).default("manual").describe("How the backup was triggered"),
    volumes: z.array(z.string()).optional().describe("Specific volume paths to include. If omitted, only config volumes are backed up (media mounts excluded)."),
  }),
  execute: async ({ appId, stopFirst, method, triggeredBy, volumes }) => {
    const result = await createAppBackup(appId, {
      method: method ?? (stopFirst ? "stop" : undefined),
      triggeredBy,
      purpose: triggeredBy === "schedule" ? "schedule" : "manual",
      volumes,
    });
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        hint: result.error.includes("No volumes")
          ? "The app may use named Docker volumes instead of bind mounts, or only has media mounts. Check with get_app_config."
          : undefined,
      };
    }
    return {
      success: true,
      appId,
      backupId: result.backupId,
      backupFile: result.archivePath,
      manifest: result.manifestPath,
      sizeBytes: result.sizeBytes,
      sizeMb: Math.round((result.sizeBytes / (1024 * 1024)) * 10) / 10,
      volumes: result.volumes,
      method: result.method,
      suspendMethod: result.method === "stop" ? "stopped" : result.method,
      files: result.fileCount,
      warnings: result.warnings,
      timestamp: new Date().toISOString(),
    };
  },
});

// ── restore_app ──────────────────────────────────────────────────────────────

interface BackupListRow {
  id: string;
  file_path: string | null;
  manifest_path: string | null;
  size_bytes: number | null;
  completed_at: string | null;
  method: string | null;
  verify_status: string | null;
  purpose: string | null;
}

export const restoreAppTool = tool({
  description: `Restore an app's data from a previously created backup. A safety backup of the current state is taken first; the app is stopped, its data and compose file are restored, it is started again and its health is checked. If the app doesn't come back healthy the previous state is restored automatically.

Lists available backups (with verification status) if no backup is specified.

After calling: Report what was restored, the backup date, the health check result, and the safety backup id. Warn that data changed since the backup was replaced.`,
  inputSchema: z.object({
    appId: z.string().describe("The app ID to restore"),
    backupId: z.string().optional().describe("Backup id to restore (preferred)"),
    backupFile: z.string().optional().describe("Full path to the backup archive. Omit both to list available backups."),
    verifyFirst: z.boolean().default(false).describe("Run a full verification (test restore) before restoring"),
  }),
  execute: async ({ appId, backupId, backupFile, verifyFirst }) => {
    // List mode
    if (!backupId && !backupFile) {
      const rows = db.all(
        sql`SELECT id, file_path, manifest_path, size_bytes, completed_at, method, verify_status, purpose FROM backups WHERE app_id = ${appId} AND status = 'completed' ORDER BY completed_at DESC LIMIT 30`,
      ) as BackupListRow[];
      const legacyDir = join(LEGACY_BACKUP_BASE, appId);
      const known = new Set(rows.map((r) => r.file_path));
      const legacyFiles = existsSync(legacyDir)
        ? readdirSync(legacyDir)
            .filter((f) => f.endsWith(".tar.gz") && !known.has(join(legacyDir, f)))
            .sort()
            .reverse()
        : [];
      if (rows.length === 0 && legacyFiles.length === 0) {
        return { success: false, error: `No backups found for '${appId}'.` };
      }
      return {
        success: true,
        action: "list",
        appId,
        backups: rows.map((r) => ({
          backupId: r.id,
          file: r.file_path,
          completedAt: r.completed_at,
          sizeMb: r.size_bytes ? Math.round((r.size_bytes / (1024 * 1024)) * 10) / 10 : null,
          method: r.method,
          verification: r.verify_status ?? "not verified",
          kind: r.purpose ?? "manual",
          legacy: !r.manifest_path,
        })),
        legacyArchives: legacyFiles.map((f) => ({
          file: join(legacyDir, f),
          sizeMb: Math.round((statSync(join(legacyDir, f)).size / (1024 * 1024)) * 10) / 10,
        })),
        hint: "Call restore_app again with backupId (or backupFile for legacy archives) to restore.",
      };
    }

    // Resolve to a backup record when possible
    let row: BackupListRow | undefined;
    if (backupId) {
      row = db.get(sql`SELECT id, file_path, manifest_path, size_bytes, completed_at, method, verify_status, purpose FROM backups WHERE id = ${backupId} AND app_id = ${appId}`) as BackupListRow | undefined;
      if (!row) return { success: false, error: `Backup ${backupId} not found for '${appId}'.` };
    } else if (backupFile) {
      const resolved = resolve(backupFile);
      row = db.get(sql`SELECT id, file_path, manifest_path, size_bytes, completed_at, method, verify_status, purpose FROM backups WHERE file_path = ${resolved} AND app_id = ${appId}`) as BackupListRow | undefined;
    }

    if (row?.manifest_path) {
      if (verifyFirst) {
        const v = await verifyBackup(row.id);
        if (!v.success) return { success: false, error: `Verification failed — not restoring: ${v.errors.join("; ")}` };
      }
      const r = await restoreAppBackup(row.id);
      if (!r.success) {
        return {
          success: false,
          error: r.error,
          rolledBack: r.rolledBack,
          safetyBackupId: r.safetyBackupId,
          hint: r.rolledBack ? "The app was returned to its previous state." : "Check the app — the safety backup can be restored if needed.",
        };
      }
      return {
        success: true,
        action: "restore",
        appId,
        restoredFrom: row.id,
        backupDate: row.completed_at,
        safetyBackupId: r.safetyBackupId,
        health: r.health.detail,
        warnings: r.warnings,
        message: `App '${appId}' restored from backup and healthy.`,
      };
    }

    // ── Legacy archive (no manifest) ──────────────────────────────────────
    const legacyPath = resolve(row?.file_path ?? backupFile ?? "");
    const legacyRoots = [LEGACY_BACKUP_BASE, getBackupRoot()];
    if (!legacyRoots.some((r) => legacyPath.startsWith(r + "/"))) {
      return { success: false, error: "Legacy restores are limited to archives inside the Talome backup directory." };
    }
    if (!existsSync(legacyPath)) {
      return { success: false, error: `Backup file not found: ${legacyPath}` };
    }
    if (isEngineArchivePath(legacyPath)) {
      return {
        success: false,
        error: "This archive was made by the current backup engine and has no matching backup record for this app. Restore it with backupId (list backups by calling restore_app with only appId).",
      };
    }
    const composePath = getInstalledAppComposePath(appId);
    if (!composePath) {
      return { success: false, error: `App '${appId}' not found or not installed.` };
    }
    return legacyRestore(appId, composePath, legacyPath);
  },
});

async function legacyRestore(appId: string, composePath: string, archive: string) {
  const composeDir = dirname(composePath);
  try {
    log(`Stopping ${appId} for legacy restore...`);
    await execPromise(`docker compose -f "${composePath}" stop`, { cwd: composeDir, timeout: DOCKER_TIMEOUT }).catch(() => "");

    const safety = await validateTarSafety(archive);
    if (!safety.safe) {
      await execPromise(`docker compose -f "${composePath}" up -d`, { cwd: composeDir, timeout: DOCKER_TIMEOUT }).catch(() => "");
      return {
        success: false,
        error: `Unsafe archive rejected: ${safety.reason}`,
        hint: "The archive contains entries that could write outside the expected directories. This may indicate a tampered backup.",
      };
    }

    log(`Restoring ${appId} from ${basename(archive)} (legacy format)...`);
    await execPromise(`tar -xzf "${archive}" -C /`, { timeout: TAR_EXTRACT_TIMEOUT });
    await execPromise(`docker compose -f "${composePath}" up -d`, { cwd: composeDir, timeout: DOCKER_TIMEOUT });

    writeAuditEntry(`Restore: ${appId}`, "destructive", JSON.stringify({ backupFile: archive, legacy: true }));
    return {
      success: true,
      action: "restore",
      appId,
      restoredFrom: archive,
      message: `App '${appId}' restored from a legacy backup and restarted. Legacy backups have no checksums or automatic rollback.`,
    };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Legacy restore failed for ${appId}: ${errMsg}`);
    await execPromise(`docker compose -f "${composePath}" up -d`, { cwd: composeDir, timeout: DOCKER_TIMEOUT }).catch(() => "");
    return {
      success: false,
      error: errMsg,
      hint: "The app has been restarted. The restore may have partially completed.",
    };
  }
}
