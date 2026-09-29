/**
 * App backup engine — application-consistent, checksummed, self-describing.
 *
 * Consistency methods:
 *   dump — logical dumps of recognised databases (pg_dumpall, mysqldump,
 *          redis BGSAVE) while the app keeps running; the raw database
 *          directories are left out because the dump replaces them.
 *   stop — briefly stop the app's containers, archive, start them again.
 *          Containers that were running are ALWAYS restarted (finally).
 *   live — archive while running (explicit opt-in; crash-consistent at best).
 *
 * "auto" (the default) picks dump when a postgres/mysql service is present,
 * otherwise stop — most apps keep SQLite files that are only safe to copy
 * while the app is stopped.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { writeAuditEntry } from "../db/audit.js";
import { writeNotification } from "../db/notifications.js";
import { bindVolumes, resolveAppContext, type AppContext, type ComposeService, type ComposeVolume } from "./compose.js";
import {
  execCapture,
  execToFile,
  getContainerState,
  getImageDigests,
  listAppContainers,
  startContainerById,
  stopContainerGracefully,
  type AppContainer,
} from "./docker-ops.js";
import { copyToDestination, getDestination, legacyCloudTargetDestination, deleteFromDestination, type BackupDestination } from "./destinations.js";
import { REDIS_BGSAVE, REDIS_PERSISTENCE_INFO, dumpCommand, parseRedisPersistence, validateSqlDump } from "./dumps.js";
import { errorMessage, getBackupRoot, getTalomeVersion, isWithin, sha256File, timestampSlug } from "./fs-utils.js";
import { compileExcludePatterns } from "./glob.js";
import { acquireAppOperation, activeIds, getAppOperation, markContainersInMaintenance, releaseAppMaintenance } from "./state.js";
import {
  clearRecoveryRecord,
  deleteBackupRow,
  getAppBackupConfig,
  getBackupRow,
  getRestoreRow,
  insertRunningBackup,
  markBackupCompleted,
  markBackupFailed,
  appendBackupWarning,
  saveRecoveryRecord,
  setBackupDestination,
} from "./store.js";
import { TarGzWriter } from "./tar.js";
import {
  ARCHIVE_COMPOSE_DIR,
  ARCHIVE_DUMPS_DIR,
  ARCHIVE_FILE_NAME,
  ARCHIVE_META_DIR,
  ARCHIVE_VOLUMES_DIR,
  MANIFEST_FILE_NAME,
  MANIFEST_FORMAT_VERSION,
  type BackupManifest,
  type BackupFailureCode,
  type BackupPurpose,
  type ConfiguredMethod,
  type ConsistencyMethod,
  type CreateAppBackupResult,
  type ManifestDump,
  type ManifestFile,
  type ManifestImage,
  type ManifestVolume,
} from "./types.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("backup");

export interface CreateAppBackupOptions {
  /** Override the app's configured consistency method */
  method?: ConfiguredMethod;
  triggeredBy?: "manual" | "schedule";
  purpose?: BackupPurpose;
  /** Explicit host paths to include (must be bind volumes of the app) */
  volumes?: string[];
  /** Copy the finished backup to this destination */
  destinationId?: string | null;
  /** Legacy schedule cloud_target (existing rclone remote path or local dir) */
  cloudTarget?: string | null;
  scheduleId?: string | null;
  /** Progress callback: preparing, dumping, pausing, archiving, resuming, validating, uploading */
  onStage?: (stage: string) => void;
}

/** Internal knobs used by restore (safety backups). */
export interface InternalBackupOptions extends CreateAppBackupOptions {
  /** Ignore the app's exclude patterns (safety backups must be lossless) */
  ignoreExcludes?: boolean;
  /** Keep raw database directories even for the dump method */
  includeDbData?: boolean;
  /** On success, leave containers stopped by the stop method stopped */
  leaveStopped?: boolean;
  /** Treat `volumes` as the exact selection — an empty list archives no volumes */
  exactVolumes?: boolean;
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
}

export interface InternalBackupResult {
  result: CreateAppBackupResult;
  /** Containers left stopped because of leaveStopped */
  stoppedContainers: AppContainer[];
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const DUMPABLE: ReadonlySet<string> = new Set(["postgres", "mysql"]);

export function slugify(value: string): string {
  const s = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return (s || "root").slice(0, 48);
}

function volumeKey(index: number, v: ComposeVolume, ctx: AppContext): string {
  const hostPath = v.hostPath!;
  let label: string;
  if (isWithin(ctx.appDataDir, hostPath)) label = relative(ctx.appDataDir, hostPath) || "app-data";
  else if (isWithin(ctx.composeDir, hostPath)) label = relative(ctx.composeDir, hostPath) || "app";
  else label = basename(hostPath);
  return `${index}-${slugify(label)}`;
}

export function appRelative(ctx: AppContext, absPath: string): string | null {
  if (isWithin(ctx.appDataDir, absPath)) return relative(ctx.appDataDir, absPath).split("\\").join("/");
  if (isWithin(ctx.composeDir, absPath)) return relative(ctx.composeDir, absPath).split("\\").join("/");
  return null;
}

/** Stop order: application services first, databases last (start is reversed). */
export function sortForStop(containers: AppContainer[], ctx: AppContext): AppContainer[] {
  const isDb = (c: AppContainer) => ctx.compose.services.some((s) => s.name === c.service && s.dbEngine !== null);
  return [...containers].sort((a, b) => Number(isDb(a)) - Number(isDb(b)));
}

export function containerForService(containers: AppContainer[], svc: ComposeService): AppContainer | undefined {
  return containers.find((c) => c.service === svc.name) ?? containers.find((c) => svc.containerName !== null && c.name === svc.containerName);
}

export function resolveMethod(ctx: AppContext, requested: ConfiguredMethod): ConsistencyMethod {
  const hasDumpable = ctx.compose.services.some((s) => s.dbEngine !== null && DUMPABLE.has(s.dbEngine));
  if (requested === "auto") return hasDumpable ? "dump" : "stop";
  if (requested === "dump" && !hasDumpable) return "stop";
  return requested;
}

async function waitForRedisSave(containerId: string, startedAfter: number, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await execCapture(containerId, REDIS_PERSISTENCE_INFO, 15_000);
    if (info.exitCode === 0) {
      const p = parseRedisPersistence(info.stdout);
      if (!p.inProgress && p.lastSave >= startedAfter) {
        if (!p.lastStatusOk) throw new Error("redis BGSAVE reported an error");
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("redis BGSAVE did not finish in time");
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a verified-format backup of an installed app. Never throws.
 * Stable signature — also used before app updates.
 */
export async function createAppBackup(appId: string, opts: CreateAppBackupOptions = {}): Promise<CreateAppBackupResult> {
  const backupId = randomUUID();
  const handle = acquireAppOperation(appId, "backup", backupId);
  if (!handle) {
    return { success: false, appId, error: `Another backup or restore is already running for '${appId}'.`, code: "busy" };
  }
  const onStage = opts.onStage;
  try {
    const { result } = await runBackup(appId, backupId, {
      ...opts,
      signal: handle.op.controller.signal,
      onStage: (stage) => {
        handle.setStage(stage);
        try {
          onStage?.(stage);
        } catch {
          // progress reporting never breaks a backup
        }
      },
    });
    return result;
  } finally {
    handle.release();
  }
}

/** Run a backup without taking the per-app lock (caller must hold it). */
export async function runBackup(appId: string, backupId: string, opts: InternalBackupOptions = {}): Promise<InternalBackupResult> {
  const started = Date.now();
  const setStage = (stage: string) => {
    opts.onStage?.(stage);
    log.info(`${appId}: ${stage}`);
  };
  const fail = (error: string): InternalBackupResult => ({ result: { success: false, appId, error }, stoppedContainers: [] });
  // Failures before any work starts still get a history row so the UI can show them
  const recordEarlyFailure = (error: string, code: BackupFailureCode = "failed"): InternalBackupResult => {
    try {
      insertRunningBackup({
        id: backupId,
        appId,
        startedAt: new Date().toISOString(),
        triggeredBy: opts.triggeredBy === "schedule" ? "schedule" : "manual",
        purpose: opts.purpose ?? (opts.triggeredBy === "schedule" ? "schedule" : "manual"),
        scheduleId: opts.scheduleId ?? null,
        appVersion: null,
      });
      markBackupFailed(backupId, "failed", error, null);
    } catch {
      // history is best-effort
    }
    return { result: { success: false, backupId, appId, error, code }, stoppedContainers: [] };
  };

  const ctxResult = resolveAppContext(appId);
  if (!ctxResult.ok) return fail(ctxResult.error);
  const ctx = ctxResult.ctx;
  const config = getAppBackupConfig(appId);
  const requested: ConfiguredMethod = opts.method ?? config.method;
  let method = resolveMethod(ctx, requested);
  const warnings: string[] = [];
  if (requested === "dump" && method !== "dump") warnings.push("No supported database found — used the stop method instead of dump");

  // ── Volume selection ──────────────────────────────────────────────────
  const allBind = bindVolumes(ctx.compose);
  const explicit = opts.volumes ?? config.includeVolumes;
  let selected: ComposeVolume[];
  if ((explicit && explicit.length > 0) || (opts.exactVolumes && opts.volumes)) {
    const wanted = new Set(explicit ?? []);
    selected = allBind.filter((v) => wanted.has(v.hostPath!));
  } else {
    selected = allBind.filter((v) => v.type === "config");
  }
  selected = selected.filter((v) => v.exists);

  const dumpServices = method === "dump" ? ctx.compose.services.filter((s) => s.dbEngine !== null) : [];
  const dbDataPaths = new Set(
    dumpServices.filter((s) => s.dbEngine !== null && DUMPABLE.has(s.dbEngine)).flatMap((s) => s.dbDataPaths),
  );
  if (method === "dump" && !opts.includeDbData) {
    selected = selected.filter((v) => !dbDataPaths.has(v.hostPath!));
  }
  const computeSkipped = (): BackupManifest["skippedVolumes"] => {
    const skipped: BackupManifest["skippedVolumes"] = [];
    for (const svc of ctx.compose.services) {
      for (const v of svc.volumes) {
        if (v.kind === "named") {
          const dumped = svc.dbEngine !== null && DUMPABLE.has(svc.dbEngine) && method === "dump";
          skipped.push({
            raw: v.raw,
            service: svc.name,
            reason: dumped ? "named volume — captured by the database dump" : "named Docker volume — not accessible as a host path",
          });
        } else if (v.hostPath && !selected.some((s) => s.hostPath === v.hostPath)) {
          if (method === "dump" && dbDataPaths.has(v.hostPath) && !opts.includeDbData) continue; // covered by the dump
          skipped.push({
            raw: v.raw,
            service: svc.name,
            reason: !v.exists ? "path does not exist" : v.type === "media" ? "media mount (not selected)" : "not selected",
          });
        }
      }
    }
    return skipped;
  };

  if (selected.length === 0 && dumpServices.length === 0) {
    return recordEarlyFailure(
      `No volumes to back up for '${appId}'. The app may use named Docker volumes only, or only media mounts (select them explicitly).`,
      "nothing_to_backup",
    );
  }

  // ── Record + prepare ──────────────────────────────────────────────────
  const root = getBackupRoot();
  const dirName = `${timestampSlug()}-${backupId.slice(0, 8)}`;
  const backupDir = join(root, appId, dirName);
  const stagingDir = join(backupDir, ".staging");
  const archivePath = join(backupDir, ARCHIVE_FILE_NAME);
  const partialPath = `${archivePath}.partial`;
  const manifestPath = join(backupDir, MANIFEST_FILE_NAME);
  const purpose: BackupPurpose = opts.purpose ?? (opts.triggeredBy === "schedule" ? "schedule" : "manual");
  const createdAt = new Date().toISOString();

  try {
    insertRunningBackup({
      id: backupId,
      appId,
      startedAt: createdAt,
      triggeredBy: opts.triggeredBy === "schedule" ? "schedule" : "manual",
      purpose,
      scheduleId: opts.scheduleId ?? null,
      appVersion: ctx.version,
    });
  } catch (err) {
    return fail(`Could not record backup: ${errorMessage(err)}`);
  }

  const signal = opts.signal;
  const checkCancelled = () => {
    if (signal?.aborted) throw new Error("Backup cancelled");
  };
  let stoppedByUs: AppContainer[] = [];
  let leftStopped: AppContainer[] = [];
  let writer: TarGzWriter | null = null;

  try {
    setStage("preparing");
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });

    let containers: AppContainer[] = [];
    try {
      containers = await listAppContainers({ appId, composePath: ctx.composePath, projectName: ctx.compose.projectName });
    } catch (err) {
      warnings.push(`Could not list containers: ${errorMessage(err)}`);
    }
    const running = containers.filter((c) => c.status === "running");

    // A dump needs every database container running; otherwise fall back to stop.
    if (method === "dump") {
      const missing = dumpServices.filter(
        (s) => s.dbEngine !== null && DUMPABLE.has(s.dbEngine) && !containerForService(running, s),
      );
      if (missing.length > 0) {
        warnings.push(`Database container not running (${missing.map((s) => s.name).join(", ")}) — used the stop method`);
        method = "stop";
        if (!opts.includeDbData) {
          // Raw DB directories are consistent once everything is stopped — include them again
          const wanted = new Set(selected.map((v) => v.hostPath));
          for (const v of allBind) {
            if (dbDataPaths.has(v.hostPath!) && v.exists && !wanted.has(v.hostPath)) selected.push(v);
          }
        }
      }
    }

    // ── Image digests (best effort) ──────────────────────────────────────
    const images: ManifestImage[] = [];
    for (const c of containers) {
      try {
        const st = await getContainerState(c.id);
        images.push({
          service: c.service ?? c.name,
          container: c.name,
          image: st.image || c.image,
          imageId: st.imageId,
          repoDigests: st.imageId ? await getImageDigests(st.imageId) : [],
        });
      } catch {
        images.push({ service: c.service ?? c.name, container: c.name, image: c.image, imageId: null, repoDigests: [] });
      }
    }

    // ── Database dumps ────────────────────────────────────────────────────
    const dumps: Array<ManifestDump & { localPath: string | null }> = [];
    if (method === "dump") {
      setStage("dumping");
      for (const svc of dumpServices) {
        checkCancelled();
        const container = containerForService(running, svc);
        if (!svc.dbEngine) continue;
        if (svc.dbEngine === "redis") {
          if (!container) {
            warnings.push(`Redis service ${svc.name} is not running — its data was archived as-is`);
            continue;
          }
          try {
            const startedAt = Math.floor(Date.now() / 1000);
            const r = await execCapture(container.id, REDIS_BGSAVE, 30_000);
            if (r.exitCode !== 0) throw new Error(r.stderr || r.stdout || "BGSAVE failed");
            await waitForRedisSave(container.id, startedAt);
            dumps.push({ service: svc.name, engine: "redis", path: null, sizeBytes: 0, sha256: null, replacesVolumes: [], localPath: null });
          } catch (err) {
            warnings.push(`Redis snapshot for ${svc.name} failed: ${errorMessage(err)}`);
          }
          continue;
        }
        if (!container) throw new Error(`Database container for ${svc.name} is not running`);
        const localPath = join(stagingDir, `${slugify(svc.name)}.sql`);
        const r = await execToFile(container.id, dumpCommand(svc.dbEngine), localPath);
        if (r.exitCode !== 0) {
          throw new Error(`Database dump of ${svc.name} failed (exit ${r.exitCode}): ${r.stderr.slice(0, 500) || "no output"}`);
        }
        const check = await validateSqlDump(localPath, svc.dbEngine);
        if (!check.ok) throw new Error(`Database dump of ${svc.name} is invalid: ${check.detail}`);
        const size = (await stat(localPath)).size;
        dumps.push({
          service: svc.name,
          engine: svc.dbEngine,
          path: `${ARCHIVE_DUMPS_DIR}/${slugify(svc.name)}.sql`,
          sizeBytes: size,
          sha256: null,
          replacesVolumes: opts.includeDbData ? [] : svc.dbDataPaths.filter((p) => allBind.some((v) => v.hostPath === p)),
          localPath,
        });
      }
    }

    checkCancelled();

    // ── Stop + archive ────────────────────────────────────────────────────
    // Everything from the first stop to the end of archiving runs inside one
    // try/finally, so containers stopped here are ALWAYS started again —
    // whether a stop fails, the user cancels while pausing, or archiving fails.
    const files: ManifestFile[] = [];
    const symlinks: BackupManifest["symlinks"] = [];
    const volumes: ManifestVolume[] = [];
    const unreadable: string[] = [];
    const matcher = compileExcludePatterns(opts.ignoreExcludes ? [] : config.excludePatterns);
    let completedAt = "";
    let manifest: BackupManifest | null = null;
    let archived = false;
    let maintenanceMarked = false;

    try {
      if (method === "stop" && running.length > 0) {
        setStage("pausing");
        for (const c of sortForStop(running, ctx)) {
          checkCancelled();
          markContainersInMaintenance(appId, [c.id, c.name]);
          maintenanceMarked = true;
          // Tracked before the stop call: a stop that fails half-way is restarted too
          stoppedByUs.push(c);
          saveRecoveryRecord(backupId, appId, "backup", { containers: stoppedByUs.map((x) => ({ id: x.id, name: x.name })) });
          await stopContainerGracefully(c.id);
        }
      }

      setStage("archiving");
      const composeContent = await readFile(ctx.composePath);
      // Paths archived on their own (nested volumes) or replaced by a dump are
      // skipped when walking a parent volume.
      const separatelyHandled = new Set<string>(selected.map((v) => v.hostPath!));
      if (method === "dump" && !opts.includeDbData) for (const p of dbDataPaths) separatelyHandled.add(p);

      writer = new TarGzWriter(partialPath);
      const w = writer;
      for (const [index, v] of selected.entries()) {
        checkCancelled();
        const key = volumeKey(index, v, ctx);
        const prefix = `${ARCHIVE_VOLUMES_DIR}/${key}`;
        const hostPath = v.hostPath!;
        const walk = await w.addTree(hostPath, prefix, {
          signal,
          exclude: (rel, isDir) => {
            const abs = join(hostPath, rel);
            // Never archive the backup root itself (e.g. an app mounting $HOME)
            if (isWithin(root, abs)) return true;
            if (separatelyHandled.has(abs)) return true;
            return matcher(rel, isDir, appRelative(ctx, abs));
          },
          onFile: (f) => files.push({ path: f.name, size: f.size, sha256: f.sha256, mode: f.mode }),
          onSymlink: (name, target) => symlinks.push({ path: name, target }),
          onWarning: (m) => warnings.push(`${v.raw}: ${m}`),
          onSkipped: (rel) => unreadable.push(rel ? `${prefix}/${rel}` : prefix),
        });
        volumes.push({
          key,
          hostPath,
          raw: v.raw,
          target: v.target,
          service: v.service,
          kind: walk.kind,
          fileCount: walk.fileCount,
          bytes: walk.bytes,
        });
      }

      for (const d of dumps) {
        if (!d.localPath || !d.path) continue;
        checkCancelled();
        const added = await w.addFile(d.path, d.localPath, await lstat(d.localPath), signal);
        d.sha256 = added.sha256;
        files.push({ path: added.name, size: added.size, sha256: added.sha256, mode: added.mode });
      }

      const composeArchivePath = `${ARCHIVE_COMPOSE_DIR}/${basename(ctx.composePath)}`;
      const composeAdded = await w.addBuffer(composeArchivePath, composeContent, 0o644);
      files.push({ path: composeAdded.name, size: composeAdded.size, sha256: composeAdded.sha256, mode: 0o644 });

      if (unreadable.length > 0) {
        warnings.push(
          `Backup is incomplete: ${unreadable.length} unreadable path(s) were not captured (e.g. ${unreadable[0]}). ` +
            "A restore keeps these paths from the current data.",
        );
      }

      completedAt = new Date().toISOString();
      manifest = {
        formatVersion: MANIFEST_FORMAT_VERSION,
        backupId,
        appId,
        appVersion: ctx.version,
        storeSourceId: ctx.storeSourceId,
        talomeVersion: getTalomeVersion(),
        createdAt,
        completedAt,
        method,
        requestedMethod: requested,
        purpose,
        compose: { hostPath: ctx.composePath, archivePath: composeArchivePath, sha256: composeAdded.sha256 },
        volumes,
        skippedVolumes: computeSkipped(),
        dumps: dumps.map(({ localPath: _localPath, ...d }) => d),
        images,
        excludePatterns: matcher.patterns,
        files,
        symlinks,
        unreadable,
        totals: { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) },
        warnings: [...warnings],
      };
      await w.addBuffer(`${ARCHIVE_META_DIR}/${MANIFEST_FILE_NAME}`, Buffer.from(JSON.stringify(manifest, null, 2)), 0o600);
      await w.close();
      writer = null;
      archived = true;
    } finally {
      // Always bring back what we stopped — even when stopping or archiving failed
      if (stoppedByUs.length > 0) {
        if (archived && !signal?.aborted && opts.leaveStopped) {
          // The caller (restore) takes over and records these containers itself
          leftStopped = stoppedByUs;
        } else {
          setStage("resuming");
          await restartContainers(appId, stoppedByUs);
          releaseAppMaintenance(appId);
        }
        stoppedByUs = [];
        clearRecoveryRecord(backupId);
      } else if (maintenanceMarked) {
        releaseAppMaintenance(appId);
      }
    }

    // ── Finalise ──────────────────────────────────────────────────────────
    setStage("validating");
    await rename(partialPath, archivePath);
    const archiveStat = await stat(archivePath);
    if (archiveStat.size === 0) throw new Error("Backup archive is empty");
    const archiveSha = await sha256File(archivePath);
    const external: BackupManifest = {
      ...(manifest as BackupManifest),
      archive: { file: ARCHIVE_FILE_NAME, sizeBytes: archiveStat.size, sha256: archiveSha },
    };
    await writeFile(manifestPath, JSON.stringify(external, null, 2), { mode: 0o600 });
    await rm(stagingDir, { recursive: true, force: true });

    markBackupCompleted({
      id: backupId,
      filePath: archivePath,
      manifestPath,
      sizeBytes: archiveStat.size,
      archiveSha256: archiveSha,
      method,
      warnings,
      completedAt,
    });
    try {
      writeAuditEntry(
        `Backup: ${appId}`,
        "modify",
        JSON.stringify({ backupId, method, archive: archivePath, sizeBytes: archiveStat.size, files: files.length, purpose }),
      );
    } catch {
      // audit is best-effort
    }

    // ── Destination copy ──────────────────────────────────────────────────
    let destinationLocation: string | null = null;
    const destination: BackupDestination | null = opts.destinationId
      ? getDestination(opts.destinationId)
      : opts.cloudTarget
        ? legacyCloudTargetDestination(opts.cloudTarget)
        : null;
    if (opts.destinationId && !destination) warnings.push("Destination no longer exists — backup kept locally only");
    if (!opts.destinationId && opts.cloudTarget && !destination) {
      const msg = "Schedule cloud target is not allowed (use a configured rclone remote or an absolute path) — backup kept locally only";
      warnings.push(msg);
      appendBackupWarning(backupId, msg);
    }
    if (destination && destination.enabled) {
      setStage("uploading");
      const copy = await copyToDestination(destination, backupDir, appId, dirName);
      if (copy.ok) {
        destinationLocation = copy.location;
        setBackupDestination(backupId, destination.id === "legacy" ? null : destination.id, copy.location);
      } else {
        const msg = `Copy to ${destination.name} failed: ${copy.error}`;
        warnings.push(msg);
        appendBackupWarning(backupId, msg);
        writeNotification("warning", `Backup upload failed: ${appId}`, msg, appId);
      }
    }

    return {
      result: {
        success: true,
        backupId,
        appId,
        archivePath,
        manifestPath,
        sizeBytes: archiveStat.size,
        method,
        volumes: volumes.map((v) => v.hostPath),
        fileCount: files.length,
        warnings,
        destination: destinationLocation,
        durationMs: Date.now() - started,
      },
      stoppedContainers: leftStopped,
    };
  } catch (err) {
    const cancelled = signal?.aborted === true;
    const message = cancelled ? "Cancelled by user" : errorMessage(err);
    log.warn(`${appId}: backup ${cancelled ? "cancelled" : "failed"} — ${message}`);
    if (writer) await (writer as TarGzWriter).abort();
    if (leftStopped.length > 0) {
      await restartContainers(appId, leftStopped);
      releaseAppMaintenance(appId);
      leftStopped = [];
    }
    await rm(backupDir, { recursive: true, force: true }).catch(() => {});
    try {
      markBackupFailed(backupId, cancelled ? "cancelled" : "failed", message, method);
    } catch {
      // ignore
    }
    return { result: { success: false, backupId, appId, error: message }, stoppedContainers: [] };
  }
}

/** Start containers (databases first). Notifies when one can't be started. */
export async function restartContainers(appId: string, stopped: AppContainer[]): Promise<string[]> {
  const errors: string[] = [];
  for (const c of [...stopped].reverse()) {
    try {
      await startContainerById(c.id);
    } catch (err) {
      errors.push(`${c.name}: ${errorMessage(err)}`);
    }
  }
  if (errors.length > 0) {
    log.error(`${appId}: failed to restart containers after backup`, errors);
    writeNotification(
      "critical",
      `${appId} not restarted after backup`,
      `Some containers could not be started again: ${errors.join("; ")}. Manual intervention may be required.`,
      appId,
    );
  }
  return errors;
}

// ── Deletion ────────────────────────────────────────────────────────────────

/** True while a backup is the source of a running restore or verification. */
export function isBackupInUse(row: { id: string; app_id: string | null; verify_status: string | null }): boolean {
  const active = activeIds();
  if (active.verifies.has(row.id) || row.verify_status === "running") return true;
  if (!row.app_id) return false;
  const op = getAppOperation(row.app_id);
  if (!op || op.kind !== "restore") return false;
  // The restore's source backup is looked up through its recorded row
  try {
    const restore = getRestoreRow(op.id);
    return !restore || restore.backup_id === row.id;
  } catch {
    return true;
  }
}

/** Delete a backup (local files, destination copy, DB row). Never throws. */
export async function deleteBackup(id: string): Promise<{ ok: boolean; error?: string }> {
  const row = getBackupRow(id);
  if (!row) return { ok: false, error: "Backup not found" };
  if (row.status === "running") return { ok: false, error: "Cannot delete a running backup" };
  if (isBackupInUse(row)) return { ok: false, error: "Backup is being verified or restored — try again when that finishes" };
  const root = getBackupRoot();
  try {
    if (row.manifest_path) {
      const dir = dirname(row.manifest_path);
      if (isWithin(root, dir) && dir !== root) await rm(dir, { recursive: true, force: true });
    } else if (row.file_path && existsSync(row.file_path)) {
      await rm(row.file_path, { force: true });
    }
  } catch (err) {
    log.warn(`failed to delete backup files for ${id}`, err);
  }
  if (row.cloud_target) {
    const dest = row.destination_id ? getDestination(row.destination_id) : null;
    if (dest) {
      const r = await deleteFromDestination(dest, row.cloud_target);
      if (!r.ok) log.warn(`failed to delete remote copy for ${id}: ${r.error}`);
    }
  }
  deleteBackupRow(id);
  return { ok: true };
}
