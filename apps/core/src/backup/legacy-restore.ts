/**
 * Restore of archives made by Talome versions before the backup engine: a
 * plain tar.gz of the app's bind-mount folders (member names relative to
 * "/"), no manifest, no checksums. After an upgrade these are the only
 * backups a user has, so they get the same safety net as a regular restore:
 *
 *   1. the archive must belong to the app (its folder under a backup root),
 *      and every member must lie inside one of the app's current bind
 *      mounts — no absolute paths, "..", special files, or writes through a
 *      symlink (one the archive creates, or one already on disk)
 *   2. a pre-restore safety backup of the folders it touches
 *   3. stop the app, extract over the current data (as before, files added
 *      since the backup are kept — legacy archives are merged)
 *   4. start the app (when it was running) and check its health
 *   5. on failure: put the safety backup back and start the app again
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { writeAuditEntry } from "../db/audit.js";
import { writeNotification } from "../db/notifications.js";
import { createLogger } from "../utils/logger.js";
import { bindVolumes, resolveAppContext } from "./compose.js";
import { listAppContainers, startAppViaLifecycle, type AppContainer } from "./docker-ops.js";
import { restartContainers } from "./engine.js";
import { errorMessage, getBackupRoot, isWithin } from "./fs-utils.js";
import { containerKey, resolveHealthUrl, restoreSafetyBackup, stopAll, takeSafetyBackup, waitForHealthy } from "./restore.js";
import { acquireAppOperation, releaseAppMaintenance } from "./state.js";
import { clearRecoveryRecord, finishRestore, insertRestore, saveRecoveryRecord, updateRestoreStage } from "./store.js";
import { readTarGz } from "./tar.js";
import { ARCHIVE_COMPOSE_DIR, ARCHIVE_DUMPS_DIR, ARCHIVE_META_DIR, ARCHIVE_VOLUMES_DIR, type HealthReport } from "./types.js";

const log = createLogger("backup-legacy-restore");

/** Top-level members of archives made by the current backup engine. */
const ENGINE_ARCHIVE_DIRS = [ARCHIVE_META_DIR, ARCHIVE_VOLUMES_DIR, ARCHIVE_COMPOSE_DIR, ARCHIVE_DUMPS_DIR];
const TAR_EXTRACT_TIMEOUT_MS = 60 * 60_000;

export interface LegacyRestoreOptions {
  /** backups row of the archive, when it has one (restore history) */
  backupId?: string | null;
  skipSafetyBackup?: boolean;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  dbReadyTimeoutMs?: number;
  onStage?: (stage: string) => void;
  /** Extraction (tests); default: `tar -xzf <archive> -C /` */
  extract?: (archivePath: string) => Promise<void>;
}

export type LegacyRestoreResult =
  | {
      success: true;
      action: "restore";
      appId: string;
      restoredFrom: string;
      safetyBackupId: string | null;
      health: string;
      warnings: string[];
      message: string;
    }
  | { success: false; appId: string; error: string; rolledBack: boolean; safetyBackupId: string | null; hint?: string };

/** True when `archivePath` lies in `appId`'s own folder under one of the backup roots. */
export function legacyArchiveBelongsToApp(appId: string, archivePath: string, roots: string[]): boolean {
  if (!appId || appId.includes("/") || appId === "." || appId === "..") return false;
  const p = resolve(archivePath);
  return roots.some((r) => {
    const dir = join(resolve(r), appId);
    return isWithin(dir, p) && p !== dir;
  });
}

/**
 * Check every member of a legacy archive against the app's data folders.
 * Returns the folders it touches, or why it must not be extracted.
 */
export async function inspectLegacyArchive(
  archivePath: string,
  volumeRoots: string[],
): Promise<{ ok: true; touched: string[] } | { ok: false; error: string }> {
  const touched = new Set<string>();
  const archiveLinks: string[] = [];
  const checkedDirs = new Set<string>();
  let problem: string | null = null;

  /** An existing symlink between the folder root and `abs` would redirect the write */
  const throughSymlinkOnDisk = async (root: string, abs: string, entryIsFile: boolean): Promise<string | null> => {
    const parts = abs.slice(root.length).split("/").filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      const last = i === parts.length - 1;
      if (!last && checkedDirs.has(current)) continue;
      const st = await lstat(current).catch(() => null);
      if (!st) return null; // nothing on disk from here on
      if (st.isSymbolicLink() && (!last || entryIsFile)) return current;
      if (!last) checkedDirs.add(current);
    }
    return null;
  };

  try {
    await readTarGz(archivePath, async (h) => {
      if (problem || !h.name) return;
      const name = h.name;
      const top = name.split("/")[0];
      if (ENGINE_ARCHIVE_DIRS.includes(top)) {
        problem = "this is a backup made by the current backup engine — restore it by backupId";
        return;
      }
      if (name.startsWith("/") || name.split("/").includes("..")) {
        problem = `it contains an unsafe path "${name}"`;
        return;
      }
      if (h.type === "other") {
        problem = `it contains a special file (${name})`;
        return;
      }
      const abs = `/${name}`;
      const roots = volumeRoots.filter((r) => isWithin(r, abs));
      if (roots.length === 0) {
        problem = `${abs} is not inside one of the app's data folders (the app's volumes may have changed since the backup)`;
        return;
      }
      const viaArchiveLink = archiveLinks.find((l) => abs.startsWith(`${l}/`));
      if (viaArchiveLink) {
        problem = `${abs} would be written through the symlink ${viaArchiveLink}`;
        return;
      }
      if (h.type === "hardlink") {
        const target = `/${h.linkname.replace(/^\.\/+/, "").replace(/^\/+/, "")}`;
        if (h.linkname.split("/").includes("..") || !volumeRoots.some((r) => isWithin(r, target))) {
          problem = `${abs} links to ${h.linkname}, outside the app's data folders`;
          return;
        }
      }
      const root = roots.sort((a, b) => b.length - a.length)[0];
      const onDisk = await throughSymlinkOnDisk(root, abs, h.type === "file" || h.type === "hardlink");
      if (onDisk) {
        problem = `${abs} would be written through the existing symlink ${onDisk}`;
        return;
      }
      if (h.type === "symlink") archiveLinks.push(abs);
      for (const r of roots) touched.add(r);
    });
  } catch (err) {
    return { ok: false, error: `the archive cannot be read (${errorMessage(err)})` };
  }
  if (problem) return { ok: false, error: problem };
  if (touched.size === 0) return { ok: false, error: "the archive is empty" };
  return { ok: true, touched: [...touched] };
}

function extractWithTar(archivePath: string): Promise<void> {
  return new Promise((resolveDone, reject) => {
    execFile("tar", ["-xzf", archivePath, "-C", "/"], { timeout: TAR_EXTRACT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || errorMessage(err)).trim().slice(0, 1000)));
      else resolveDone();
    });
  });
}

/** Restore a legacy (pre-engine) archive with a safety backup and rollback. Never throws. */
export async function restoreLegacyArchive(appId: string, archivePath: string, opts: LegacyRestoreOptions = {}): Promise<LegacyRestoreResult> {
  const fail = (error: string, extra: Partial<Extract<LegacyRestoreResult, { success: false }>> = {}): LegacyRestoreResult => ({
    success: false,
    appId,
    error,
    rolledBack: false,
    safetyBackupId: null,
    ...extra,
  });
  const ctxResult = resolveAppContext(appId);
  if (!ctxResult.ok) return fail(ctxResult.error);
  const ctx = ctxResult.ctx;
  const backupRoot = getBackupRoot();
  const volumeRoots = [...new Set(bindVolumes(ctx.compose).map((v) => v.hostPath!))].filter((p) => p !== "/" && !isWithin(backupRoot, p));

  // ── Pre-flight: nothing is changed until these pass ─────────────────────
  const inspected = await inspectLegacyArchive(archivePath, volumeRoots);
  if (!inspected.ok) {
    return fail(`Refusing to restore ${basename(archivePath)}: ${inspected.error}. Nothing was changed.`, {
      hint: "Legacy archives can only be restored into the folders of the app they were made for.",
    });
  }

  const restoreId = randomUUID();
  const handle = acquireAppOperation(appId, "restore", restoreId);
  if (!handle) return fail(`Another backup or restore is already running for '${appId}'.`);
  const stage = (s: string, safetyId?: string | null) => {
    handle.setStage(s);
    try {
      updateRestoreStage(restoreId, s, safetyId);
    } catch {
      // non-fatal
    }
    try {
      opts.onStage?.(s);
    } catch {
      // progress reporting never breaks a restore
    }
  };
  const pollMs = opts.pollIntervalMs ?? 3_000;
  let safetyBackupId: string | null = null;
  let stoppedBySafety: AppContainer[] = [];
  let changed = false;

  try {
    try {
      insertRestore(restoreId, opts.backupId ?? `legacy:${basename(archivePath)}`, appId);
    } catch {
      // history is best effort
    }
    let before: AppContainer[] = [];
    try {
      before = await listAppContainers({ appId, composePath: ctx.composePath, projectName: ctx.compose.projectName });
    } catch (err) {
      log.warn(`${appId}: cannot list containers before restore`, err);
    }
    const wasRunning = before.some((c) => c.status === "running");
    const requiredRunning = new Set(before.filter((c) => c.status === "running").map(containerKey));
    // A restart mid-way starts the app again and points at the safety backup
    const persist = () =>
      saveRecoveryRecord(restoreId, appId, "restore", {
        swaps: [],
        restartApp: wasRunning,
        inPlace: changed,
        safetyBackupId,
        containers: stoppedBySafety.map((c) => ({ id: c.id, name: c.name })),
      });
    persist();

    const warnings: string[] = [];
    if (!opts.skipSafetyBackup) {
      const volumes = inspected.touched.filter((p) => existsSync(p));
      if (volumes.length === 0) {
        warnings.push("None of the folders in the archive existed — no safety backup was needed");
      } else {
        stage("safety-backup");
        const safety = await takeSafetyBackup({
          appId,
          ctx,
          volumes,
          before,
          restoring: { volumes: [], unreadable: [] },
          dbReadyTimeoutMs: opts.dbReadyTimeoutMs ?? 180_000,
          pollMs,
        });
        if (!safety.ok) {
          const error = `Safety backup failed — nothing was changed: ${safety.error}`;
          finishRestore(restoreId, "failed", error, { legacy: true });
          return fail(error);
        }
        safetyBackupId = safety.backupId;
        stoppedBySafety = safety.stopped;
        warnings.push(...safety.warnings);
        persist();
      }
    }

    try {
      stage("stopping", safetyBackupId);
      await stopAll(ctx);
      stage("extracting");
      changed = true;
      persist();
      await (opts.extract ?? extractWithTar)(archivePath);

      let health: HealthReport;
      if (wasRunning) {
        stage("starting");
        const started = await startAppViaLifecycle(appId);
        if (!started.success) throw new Error(`App failed to start: ${started.error ?? "unknown error"}`);
        stage("health-check");
        health = await waitForHealthy(ctx, resolveHealthUrl(appId), opts.healthTimeoutMs ?? 120_000, pollMs, requiredRunning);
        if (!health.healthy) throw new Error(`App is not healthy after restore: ${health.detail}`);
      } else {
        health = { healthy: true, containers: [], detail: "App was stopped before the restore and was left stopped" };
      }
      finishRestore(restoreId, "completed", null, { health, warnings, safetyBackupId, legacy: true });
      writeNotification("info", `${appId} restored`, `Restored from the legacy backup ${basename(archivePath)}. ${health.detail}`, appId);
      try {
        writeAuditEntry(`Restore: ${appId}`, "destructive", JSON.stringify({ backupFile: archivePath, legacy: true, restoreId, safetyBackupId }));
      } catch {
        // best effort
      }
      return {
        success: true,
        action: "restore",
        appId,
        restoredFrom: archivePath,
        safetyBackupId,
        health: health.detail,
        warnings,
        message: `App '${appId}' restored from a legacy backup${wasRunning ? " and healthy" : ""}. Legacy archives are merged into the current data: files created since the backup were kept.`,
      };
    } catch (err) {
      const message = errorMessage(err);
      log.error(`${appId}: legacy restore failed — ${message}`);
      stage("rolling-back");
      let rolledBack = false;
      const problems: string[] = [];
      try {
        await stopAll(ctx).catch(() => {});
        if (!changed) {
          rolledBack = true;
        } else if (safetyBackupId) {
          const r = await restoreSafetyBackup(appId, safetyBackupId, opts);
          rolledBack = r.success;
          if (!r.success) problems.push(`restoring the safety backup failed: ${r.error}`);
        } else {
          problems.push("there is no safety backup to put the previous data back");
        }
        if (wasRunning) {
          const started = await startAppViaLifecycle(appId);
          if (!started.success && stoppedBySafety.length > 0) await restartContainers(appId, stoppedBySafety);
        }
      } catch (rollbackErr) {
        problems.push(`rollback failed: ${errorMessage(rollbackErr)}`);
        rolledBack = false;
      }
      const error = problems.length > 0 ? `${message}. The previous state could not be fully restored: ${problems.join("; ")}` : message;
      finishRestore(restoreId, rolledBack ? "rolled_back" : "failed", error, { safetyBackupId, legacy: true });
      writeNotification(
        "critical",
        `Restore failed: ${appId}`,
        rolledBack ? `${error} — the previous state was restored.` : `${error}${safetyBackupId ? ` Safety backup: ${safetyBackupId}` : ""}`,
        appId,
      );
      return fail(error, {
        rolledBack,
        safetyBackupId,
        hint: rolledBack ? "The app was returned to its previous state." : "Check the app — the safety backup can be restored if needed.",
      });
    }
  } catch (err) {
    const message = errorMessage(err);
    try {
      finishRestore(restoreId, "failed", message, { legacy: true });
    } catch {
      // ignore
    }
    return fail(message, { safetyBackupId });
  } finally {
    clearRecoveryRecord(restoreId);
    releaseAppMaintenance(appId);
    handle.release();
  }
}
