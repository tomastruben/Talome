/**
 * Per-app restore with a safety net.
 *
 *   1. refuse corrupt archives (sha256 must match the manifest)
 *   2. take a pre-restore safety backup (cold, lossless: no excludes)
 *   3. stop the app, extract next to each volume, swap directories in
 *      (excluded paths are carried over from the current data)
 *   4. restore the compose snapshot (Talome-managed composes only)
 *   5. reload database dumps (fresh data dir → start DB → load)
 *   6. start the app and verify health (containers running/healthy + HTTP)
 *   7. on any failure: undo the swaps (or restore the safety backup when
 *      data was changed in place) and start the app again
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rename, rm, cp, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { writeAuditEntry } from "../db/audit.js";
import { writeNotification } from "../db/notifications.js";
import { getSetting } from "../utils/settings.js";
import { createLogger } from "../utils/logger.js";
import { bindVolumes, resolveAppContext, type AppContext } from "./compose.js";
import {
  composeUp,
  execCapture,
  getContainerState,
  listAppContainers,
  putArchive,
  startAppViaLifecycle,
  stopContainerGracefully,
  type AppContainer,
} from "./docker-ops.js";
import { loadCommand, readinessCommand, significantLoadErrors } from "./dumps.js";
import {
  appRelative,
  containerForService,
  deleteBackup,
  dumpableServices,
  restartContainers,
  runBackup,
  slugify,
  sortForStop,
  type InternalBackupResult,
} from "./engine.js";
import { errorMessage, getBackupRoot, isWithin, sha256File } from "./fs-utils.js";
import { compileExcludePatterns, type ExcludeMatcher } from "./glob.js";
import { acquireAppOperation, getAppOperation, markContainersInMaintenance, releaseAppMaintenance } from "./state.js";
import {
  clearRecoveryRecord,
  finishRestore,
  getAppBackupConfig,
  getBackupRow,
  insertRestore,
  saveRecoveryRecord,
  updateRestoreStage,
  type RecoverySwap,
} from "./store.js";
import { TarGzWriter, extractTarGz, type ExtractTarget } from "./tar.js";
import { ARCHIVE_VOLUMES_DIR, type BackupManifest, type HealthReport, type RestoreAppBackupResult } from "./types.js";
import { compareWithManifest, loadManifest } from "./verify.js";

const log = createLogger("backup-restore");

export interface RestoreOptions {
  /** Skip the pre-restore safety backup (not recommended) */
  skipSafetyBackup?: boolean;
  /** Pre-allocated restore id (lets callers return it before the restore finishes) */
  restoreId?: string;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  dbReadyTimeoutMs?: number;
  /** Progress callback: checking, safety-backup, stopping, extracting, restoring-files, loading-<svc>, starting, health-check, rolling-back */
  onStage?: (stage: string) => void;
}

type SwapRecord = RecoverySwap;

class RestoreStepError extends Error {
  constructor(
    message: string,
    readonly health?: HealthReport,
  ) {
    super(message);
    this.name = "RestoreStepError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

// ── Health ──────────────────────────────────────────────────────────────────

async function probeHttp(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(5000) });
    return { ok: res.status < 500, status: res.status };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

export function resolveHealthUrl(appId: string): string | null {
  const configured = getAppBackupConfig(appId).healthUrl ?? getSetting(`${appId}_url`) ?? null;
  if (!configured) return null;
  try {
    const u = new URL(configured);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Key identifying a container across re-creation (compose service, else name). */
export function containerKey(c: Pick<AppContainer, "service" | "name">): string {
  return c.service ?? c.name;
}

/**
 * Wait until the app is healthy for two consecutive polls:
 *  - every container in `required` (the ones running before the restore) is
 *    running, and healthy when the image has a healthcheck;
 *  - other containers may be stopped (one-shot/init containers, services the
 *    user keeps stopped). Without `required`, every container must be running
 *    or have exited cleanly (exit code 0);
 *  - the HTTP probe answers (when a URL is known).
 */
export async function waitForHealthy(
  ctx: Pick<AppContext, "appId" | "composePath" | "compose">,
  url: string | null,
  timeoutMs: number,
  pollMs: number,
  required?: ReadonlySet<string>,
): Promise<HealthReport> {
  const deadline = Date.now() + timeoutMs;
  const mustRunSet = required && required.size > 0 ? required : null;
  let stable = 0;
  let report: HealthReport = { healthy: false, containers: [], detail: "no containers found" };
  for (;;) {
    let containers: AppContainer[] = [];
    try {
      containers = await listAppContainers({ appId: ctx.appId, composePath: ctx.composePath, projectName: ctx.compose.projectName });
    } catch (err) {
      report = { healthy: false, containers: [], detail: `cannot list containers: ${errorMessage(err)}` };
    }
    if (containers.length > 0) {
      const states = await Promise.all(containers.map((c) => getContainerState(c.id).catch(() => null)));
      const list = containers.map((c, i) => ({
        name: c.name,
        status: states[i]?.running ? "running" : (states[i]?.status ?? "unknown"),
        health: states[i]?.health ?? null,
      }));
      const problems: string[] = [];
      let starting = false;
      containers.forEach((c, i) => {
        const st = states[i];
        const running = st?.running === true;
        const mustRun = mustRunSet ? mustRunSet.has(containerKey(c)) : true;
        if (running) {
          if (st?.health === "unhealthy") problems.push(`${c.name} unhealthy`);
          else if (st?.health === "starting" && mustRun) starting = true;
          return;
        }
        const exitedCleanly = st?.status === "exited" && st.exitCode === 0;
        if (mustRunSet ? mustRun : !exitedCleanly) problems.push(`${c.name} ${list[i].status}`);
      });
      if (mustRunSet) {
        const present = new Set(containers.map(containerKey));
        for (const key of mustRunSet) if (!present.has(key)) problems.push(`${key} missing`);
      }
      const containersOk = problems.length === 0 && !starting;
      let http: HealthReport["http"];
      if (containersOk && url) http = { url, ...(await probeHttp(url)) };
      const ok = containersOk && (!http || http.ok);
      report = {
        healthy: ok,
        containers: list,
        http,
        detail: ok
          ? "all required containers running" + (http ? ` · HTTP ${http.status}` : "")
          : problems.length > 0
            ? problems.join(", ")
            : starting
              ? "health check still starting"
              : http && !http.ok
                ? `HTTP probe failed (${http.status ?? http.error})`
                : "not ready",
      };
      stable = ok ? stable + 1 : 0;
      if (stable >= 2) return report;
    }
    if (Date.now() >= deadline) return { ...report, healthy: false };
    await sleep(pollMs);
  }
}

// ── Filesystem helpers ──────────────────────────────────────────────────────

/** Move paths matching the exclude patterns from `fromRoot` into `toRoot`. */
async function carryOverExcluded(
  fromRoot: string,
  toRoot: string,
  hostPath: string,
  matcher: ExcludeMatcher,
  ctx: AppContext,
): Promise<string[]> {
  const moved: string[] = [];
  if (matcher.patterns.length === 0) return moved;
  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let names: string[];
    try {
      names = await readdir(join(fromRoot, rel));
    } catch {
      continue;
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const abs = join(fromRoot, childRel);
      const st = await lstat(abs);
      if (matcher(childRel, st.isDirectory(), appRelative(ctx, join(hostPath, childRel)))) {
        const dest = join(toRoot, childRel);
        if (await pathExists(dest)) continue;
        await mkdir(dirname(dest), { recursive: true });
        await rename(abs, dest);
        moved.push(childRel);
      } else if (st.isDirectory()) {
        stack.push(childRel);
      }
    }
  }
  return moved;
}

/**
 * Put previous data back. With `keepFailed`, the restored data is moved aside
 * instead of deleted (used by crash recovery, where the list of carried-over
 * paths may be incomplete) and the kept paths are reported in `keptAside`.
 */
export async function undoSwaps(swaps: SwapRecord[], short: string, keepFailed = false, keptAside: string[] = []): Promise<string[]> {
  const errors: string[] = [];
  for (const s of [...swaps].reverse()) {
    try {
      // Recorded before the move: when the old copy isn't there the live data never moved
      if (s.existed && !(await pathExists(s.old))) continue;
      for (const rel of s.carried) {
        await mkdir(dirname(join(s.old, rel)), { recursive: true }).catch(() => {});
        await rename(join(s.hostPath, rel), join(s.old, rel)).catch(() => {});
      }
      if (await pathExists(s.hostPath)) {
        const failed = `${s.hostPath}.talome-failed-${short}`;
        await rename(s.hostPath, failed);
        if (keepFailed) keptAside.push(failed);
        // May fail for files owned by a container user — leftovers are harmless
        else await rm(failed, { recursive: true, force: true }).catch(() => {});
      }
      if (s.existed) await rename(s.old, s.hostPath);
    } catch (err) {
      errors.push(`${s.hostPath}: ${errorMessage(err)}`);
    }
  }
  return errors;
}

/**
 * Move paths that were unreadable at backup time (and so are missing from the
 * archive) from the previous data into the restored tree, replacing the empty
 * placeholder directories the archive may contain.
 */
async function carryOverUnreadable(fromRoot: string, toRoot: string, rels: string[]): Promise<string[]> {
  const moved: string[] = [];
  for (const rel of rels) {
    const from = join(fromRoot, rel);
    const to = join(toRoot, rel);
    if (!(await pathExists(from))) continue;
    if (await pathExists(to)) await rm(to, { recursive: true, force: true });
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
    moved.push(rel);
  }
  return moved;
}

async function stopAll(ctx: AppContext): Promise<void> {
  const containers = await listAppContainers({ appId: ctx.appId, composePath: ctx.composePath, projectName: ctx.compose.projectName });
  markContainersInMaintenance(ctx.appId, containers.flatMap((c) => [c.id, c.name]));
  for (const c of sortForStop(containers.filter((x) => x.status === "running"), ctx)) {
    await stopContainerGracefully(c.id);
  }
}

async function waitForDbReady(
  ctx: AppContext,
  service: string,
  engine: "postgres" | "mysql",
  timeoutMs: number,
  pollMs: number,
): Promise<AppContainer> {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  let lastError = "not started";
  for (;;) {
    const containers = await listAppContainers({ appId: ctx.appId, composePath: ctx.composePath, projectName: ctx.compose.projectName });
    const c = containers.find((x) => x.service === service && x.status === "running");
    if (c) {
      const r = await execCapture(c.id, readinessCommand(engine), 15_000).catch((err: unknown) => ({ exitCode: -1, stdout: "", stderr: errorMessage(err) }));
      if (r.exitCode === 0) {
        consecutive++;
        if (consecutive >= 2) return c;
      } else {
        consecutive = 0;
        lastError = r.stderr || r.stdout || `exit ${r.exitCode}`;
      }
    }
    if (Date.now() >= deadline) throw new Error(`Database ${service} did not become ready: ${lastError}`);
    await sleep(pollMs);
  }
}

// ── Restore ─────────────────────────────────────────────────────────────────

function failResult(
  backupId: string,
  appId: string,
  error: string,
  extra: Partial<Extract<RestoreAppBackupResult, { success: false }>> = {},
): RestoreAppBackupResult {
  return { success: false, backupId, appId, error, rolledBack: false, safetyBackupId: null, ...extra };
}

/** True when no backup/restore is currently running for the app. */
export function canStartRestore(appId: string): boolean {
  return getAppOperation(appId) === null;
}

/**
 * Restore an app from a backup. Never throws. Stable signature.
 */
export async function restoreAppBackup(backupId: string, opts: RestoreOptions = {}): Promise<RestoreAppBackupResult> {
  const row = getBackupRow(backupId);
  if (!row || !row.app_id) return failResult(backupId, row?.app_id ?? "", "Backup not found");
  const appId = row.app_id;
  if (row.status !== "completed") return failResult(backupId, appId, `Backup is ${row.status}, not completed`);
  if (!row.manifest_path || !row.file_path) {
    return failResult(backupId, appId, "This backup was made by an older Talome version (no manifest). Restore it with the restore_app assistant tool.");
  }
  const restoreId = opts.restoreId ?? randomUUID();
  const handle = acquireAppOperation(appId, "restore", restoreId);
  if (!handle) return failResult(backupId, appId, `Another backup or restore is already running for '${appId}'.`);

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

  try {
    insertRestore(restoreId, backupId, appId);
    const result = await performRestore({
      backupId,
      appId,
      archivePath: row.file_path,
      manifestPath: row.manifest_path,
      restoreId,
      opts,
      stage,
      allowRollback: true,
    });
    if (result.success) {
      finishRestore(restoreId, "completed", null, { health: result.health, warnings: result.warnings, safetyBackupId: result.safetyBackupId });
      writeNotification("info", `${appId} restored`, `Restored from backup of ${row.completed_at ?? row.started_at}. ${result.health.detail}`, appId);
      try {
        writeAuditEntry(`Restore: ${appId}`, "destructive", JSON.stringify({ backupId, restoreId, safetyBackupId: result.safetyBackupId }));
      } catch {
        // best effort
      }
    } else {
      finishRestore(restoreId, result.rolledBack ? "rolled_back" : "failed", result.error, {
        health: result.health,
        safetyBackupId: result.safetyBackupId,
      });
      writeNotification(
        "critical",
        `Restore failed: ${appId}`,
        result.rolledBack ? `${result.error} — the previous state was restored.` : `${result.error}${result.safetyBackupId ? ` Safety backup: ${result.safetyBackupId}` : ""}`,
        appId,
      );
    }
    return { ...result, restoreId };
  } catch (err) {
    const message = errorMessage(err);
    try {
      finishRestore(restoreId, "failed", message, undefined);
    } catch {
      // ignore
    }
    return failResult(backupId, appId, message, { restoreId });
  } finally {
    clearRecoveryRecord(restoreId);
    releaseAppMaintenance(appId);
    handle.release();
  }
}

interface PerformRestoreParams {
  backupId: string;
  appId: string;
  archivePath: string;
  manifestPath: string;
  restoreId: string;
  opts: RestoreOptions;
  stage: (s: string, safetyId?: string | null) => void;
  allowRollback: boolean;
}

async function performRestore(p: PerformRestoreParams): Promise<RestoreAppBackupResult> {
  const { backupId, appId, opts } = p;
  const short = p.restoreId.slice(0, 8);
  const healthTimeout = opts.healthTimeoutMs ?? 120_000;
  const pollMs = opts.pollIntervalMs ?? 3_000;

  // ── Pre-flight: nothing is changed until these pass ──────────────────────
  p.stage("checking");
  const loaded = await loadManifest(p.manifestPath);
  if (!loaded.ok) return failResult(backupId, appId, `Cannot restore: ${loaded.error}`);
  const manifest: BackupManifest = loaded.manifest;
  if (manifest.appId !== appId) return failResult(backupId, appId, "Manifest belongs to a different app");
  if (!existsSync(p.archivePath)) return failResult(backupId, appId, "Archive file is missing");
  if (manifest.archive) {
    const sha = await sha256File(p.archivePath);
    if (sha !== manifest.archive.sha256) return failResult(backupId, appId, "Archive checksum mismatch — refusing to restore a corrupted backup");
  }
  const ctxResult = resolveAppContext(appId);
  if (!ctxResult.ok) return failResult(backupId, appId, ctxResult.error);
  const ctx = ctxResult.ctx;

  const knownBind = new Set(bindVolumes(ctx.compose).map((v) => v.hostPath!));
  const allowed = (path: string) => knownBind.has(path) || isWithin(ctx.composeDir, path) || isWithin(ctx.appDataDir, path);
  const replaced = manifest.dumps.flatMap((d) => d.replacesVolumes);
  for (const path of [...manifest.volumes.map((v) => v.hostPath), ...replaced]) {
    if (!allowed(path) || isWithin(getBackupRoot(), path)) {
      return failResult(backupId, appId, `Refusing to restore to unexpected path ${path}`);
    }
  }

  let before: AppContainer[] = [];
  try {
    before = await listAppContainers({ appId, composePath: ctx.composePath, projectName: ctx.compose.projectName });
  } catch (err) {
    log.warn(`${appId}: cannot list containers before restore`, err);
  }
  const wasRunning = before.some((c) => c.status === "running");
  const requiredRunning = new Set(before.filter((c) => c.status === "running").map(containerKey));

  const stagingDir = join(getBackupRoot(), ".restore", p.restoreId);
  const swaps: SwapRecord[] = [];
  const temps: string[] = [];
  let inPlace = false;
  /** Database services whose dump was loaded into the existing (named-volume) database */
  const inPlaceDbServices: string[] = [];
  let composeBefore: Buffer | null = null;
  let versionBefore: string | null = null;
  const warnings: string[] = [];
  let safetyBackupId: string | null = null;
  let stoppedBySafety: AppContainer[] = [];
  let committed = false;

  // Pending work is persisted so a server restart mid-restore can undo it
  const persist = () => {
    if (!p.allowRollback) return;
    saveRecoveryRecord(p.restoreId, appId, "restore", {
      swaps,
      restartApp: wasRunning,
      inPlace,
      safetyBackupId,
      containers: stoppedBySafety.map((c) => ({ id: c.id, name: c.name })),
      ...(committed ? { committed: true, stagingDir } : {}),
    });
  };
  persist();

  // ── Safety backup ──────────────────────────────────────────────────────
  if (!opts.skipSafetyBackup) {
    const namedVolumeDb = manifest.dumps.some((d) => d.engine !== "redis" && d.path && d.replacesVolumes.length === 0);
    const volumes = [...new Set([...manifest.volumes.map((v) => v.hostPath), ...replaced])].filter((v) => existsSync(v));
    if (volumes.length === 0 && !namedVolumeDb) {
      // The data is gone (deleted, new disk) — there is nothing to protect
      warnings.push("None of the app's data paths existed — no safety backup was needed");
    } else {
      p.stage("safety-backup");
      const safety = await takeSafetyBackup({
        appId,
        ctx,
        volumes,
        before,
        restoring: manifest,
        dbReadyTimeoutMs: opts.dbReadyTimeoutMs ?? 180_000,
        pollMs,
      });
      if (!safety.ok) {
        return failResult(backupId, appId, `Safety backup failed — nothing was changed: ${safety.error}`);
      }
      safetyBackupId = safety.backupId;
      stoppedBySafety = safety.stopped;
      warnings.push(...safety.warnings);
      persist();
      p.stage("stopping", safetyBackupId);
    }
  }

  try {
    // ── Stop ─────────────────────────────────────────────────────────────
    p.stage("stopping", safetyBackupId);
    await stopAll(ctx);

    // ── Extract next to each volume ───────────────────────────────────────
    p.stage("extracting");
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const volumeTargets = new Map<string, { hostPath: string; temp: string; kind: "dir" | "file"; unreadable: string[] }>();
    const unreadableByKey = new Map<string, string[]>();
    for (const u of manifest.unreadable) {
      const [key, ...rest] = u.slice(ARCHIVE_VOLUMES_DIR.length + 1).split("/");
      if (!u.startsWith(`${ARCHIVE_VOLUMES_DIR}/`) || !key) continue;
      unreadableByKey.set(key, [...(unreadableByKey.get(key) ?? []), rest.join("/")]);
    }
    for (const v of manifest.volumes) {
      const unreadable = unreadableByKey.get(v.key) ?? [];
      if (unreadable.includes("")) {
        warnings.push(`${v.hostPath} was unreadable when the backup was made — kept the current data`);
        continue;
      }
      // A nested volume's temp dir must live outside its parent volume, which is swapped first
      const ancestor = manifest.volumes
        .filter((o) => o.hostPath !== v.hostPath && isWithin(o.hostPath, v.hostPath))
        .sort((x, y) => x.hostPath.length - y.hostPath.length)[0];
      const temp = ancestor ? `${ancestor.hostPath}.talome-restore-${short}-${slugify(v.key)}` : `${v.hostPath}.talome-restore-${short}`;
      await rm(temp, { recursive: true, force: true });
      temps.push(temp);
      volumeTargets.set(v.key, { hostPath: v.hostPath, temp, kind: v.kind, unreadable });
    }
    const dumpFiles = new Map(manifest.dumps.filter((d) => d.path).map((d) => [d.path!, join(stagingDir, "dumps", basename(d.path!))]));
    const resolveTarget = (name: string): ExtractTarget | null => {
      if (name.startsWith(`${ARCHIVE_VOLUMES_DIR}/`)) {
        const [key, ...rest] = name.slice(ARCHIVE_VOLUMES_DIR.length + 1).split("/");
        const t = volumeTargets.get(key);
        if (!t) return null;
        if (t.kind === "dir") return { root: t.temp, rel: rest.join("/") };
        return rest.length === 0 ? { root: dirname(t.temp), rel: basename(t.temp) } : null;
      }
      if (manifest.compose && name === manifest.compose.archivePath) return { root: stagingDir, rel: "compose.yml" };
      const dump = dumpFiles.get(name);
      if (dump) return { root: dirname(dump), rel: basename(dump) };
      return null;
    };
    const extracted: Array<{ path: string; size: number; sha256: string }> = [];
    await extractTarGz(p.archivePath, stagingDir, {
      resolveTarget,
      preserveOwner: true,
      onFile: (f) => extracted.push({ path: f.name, size: f.size, sha256: f.sha256 }),
    });
    const diff = compareWithManifest(manifest, extracted);
    if (diff.length > 0) throw new RestoreStepError(`Extracted data does not match the manifest: ${diff.slice(0, 5).join("; ")}`);
    for (const t of volumeTargets.values()) {
      if (t.kind === "dir" && !(await pathExists(t.temp))) await mkdir(t.temp, { recursive: true });
    }

    // ── Swap into place ───────────────────────────────────────────────────
    p.stage("restoring-files");
    const matcher = compileExcludePatterns(manifest.excludePatterns);
    // Parents before nested volumes, so swapping a parent never moves a child away
    const ordered = [...volumeTargets.values()].sort((a, b) => a.hostPath.length - b.hostPath.length);
    for (const t of ordered) {
      const old = `${t.hostPath}.talome-old-${short}`;
      const existed = await pathExists(t.hostPath);
      // Recorded before any move, so a failure (or crash) below is undone too
      const record: SwapRecord = { hostPath: t.hostPath, old, existed, carried: [] };
      swaps.push(record);
      persist();
      let swapped = false;
      if (existed) {
        try {
          await rename(t.hostPath, old);
          swapped = true;
        } catch (err) {
          swaps.pop();
          persist();
          log.warn(`${appId}: cannot swap ${t.hostPath} (${errorMessage(err)}) — restoring in place`);
        }
      }
      if (!existed || swapped) {
        await mkdir(dirname(t.hostPath), { recursive: true });
        await rename(t.temp, t.hostPath);
        if (existed && t.kind === "dir") {
          record.carried = await carryOverExcluded(old, t.hostPath, t.hostPath, matcher, ctx);
          persist();
          record.carried.push(...(await carryOverUnreadable(old, t.hostPath, t.unreadable)));
          persist();
        }
        continue;
      }
      // In place (e.g. the volume is itself a mount point): clear and copy
      inPlace = true;
      persist();
      if (t.kind === "file") {
        await cp(t.temp, t.hostPath, { force: true, preserveTimestamps: true });
      } else {
        for (const name of await readdir(t.hostPath)) {
          const abs = join(t.hostPath, name);
          const st = await lstat(abs);
          if (matcher(name, st.isDirectory(), appRelative(ctx, abs))) continue;
          // Never delete what the backup could not capture
          if (t.unreadable.some((u) => u === name || u.startsWith(`${name}/`))) continue;
          await rm(abs, { recursive: true, force: true });
        }
        await cp(t.temp, t.hostPath, { recursive: true, force: true, preserveTimestamps: true });
      }
      await rm(t.temp, { recursive: true, force: true });
    }

    // ── Compose snapshot ─────────────────────────────────────────────────
    if (manifest.compose) {
      const snapshotPath = join(stagingDir, "compose.yml");
      if (existsSync(snapshotPath)) {
        const snapshot = await readFile(snapshotPath);
        const current = await readFile(ctx.composePath).catch(() => null);
        if (!current || !current.equals(snapshot)) {
          if (ctx.composeIsOverride) {
            composeBefore = current;
            const tmp = `${ctx.composePath}.talome-restore-${short}`;
            await writeFile(tmp, snapshot);
            await rename(tmp, ctx.composePath);
            if (manifest.appVersion) {
              const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
              versionBefore = installed?.version ?? null;
              db.update(schema.installedApps).set({ version: manifest.appVersion }).where(eq(schema.installedApps.appId, appId)).run();
            }
          } else {
            warnings.push("Compose file differs from the backup but is managed by the app store — kept the current compose file");
          }
        }
      }
    }

    // ── Database dumps ───────────────────────────────────────────────────
    const loadDumps = manifest.dumps.filter((d) => d.engine !== "redis" && d.path);
    for (const d of loadDumps) {
      const engine = d.engine as "postgres" | "mysql";
      p.stage(`loading-${d.service}`);
      for (const dataPath of d.replacesVolumes) {
        const old = `${dataPath}.talome-old-${short}`;
        const existed = await pathExists(dataPath);
        swaps.push({ hostPath: dataPath, old, existed, carried: [] });
        persist();
        if (existed) await rename(dataPath, old);
        // Fresh, empty data directory: the database image initialises it on start
        await mkdir(dataPath, { recursive: true, mode: 0o700 });
      }
      const loadInPlace = d.replacesVolumes.length === 0;
      if (loadInPlace) {
        inPlace = true;
        inPlaceDbServices.push(d.service);
        persist();
      }
      await composeUp({ appId, composePath: ctx.composePath, envOverrides: ctx.envOverrides, services: [d.service] });
      const container = await waitForDbReady(ctx, d.service, engine, opts.dbReadyTimeoutMs ?? 180_000, Math.min(pollMs, 2000));
      const inContainer = `/tmp/talome-restore-${short}-${slugify(d.service)}.sql`;
      const tarPath = join(stagingDir, `load-${slugify(d.service)}.tar.gz`);
      const localDump = dumpFiles.get(d.path!)!;
      const w = new TarGzWriter(tarPath);
      await w.addFile(basename(inContainer), localDump, await lstat(localDump));
      await w.close();
      await putArchive(container.id, tarPath, "/tmp");
      const r = await execCapture(container.id, loadCommand(engine, inContainer), 60 * 60_000);
      await execCapture(container.id, ["rm", "-f", inContainer], 15_000).catch(() => undefined);
      if (r.exitCode !== 0) throw new RestoreStepError(`Loading the ${d.service} dump failed: ${(r.stderr || r.stdout).slice(0, 500)}`);
      const sqlErrors = r.stderr.split("\n").filter((l) => /ERROR/.test(l));
      if (loadInPlace) {
        // Loading over a live database: any real error means old and new data may be mixed
        const significant = significantLoadErrors(r.stderr);
        if (significant.length > 0) {
          throw new RestoreStepError(
            `Loading the ${d.service} dump into the existing database reported ${significant.length} error(s) (e.g. ${significant[0].slice(0, 200)})`,
          );
        }
      }
      if (sqlErrors.length > 0) warnings.push(`${d.service}: ${sqlErrors.length} statement(s) reported errors while loading (e.g. ${sqlErrors[0].slice(0, 200)})`);
    }

    // ── Start + health ───────────────────────────────────────────────────
    let health: HealthReport;
    if (wasRunning) {
      p.stage("starting");
      const started = await startAppViaLifecycle(appId);
      if (!started.success) throw new RestoreStepError(`App failed to start: ${started.error ?? "unknown error"}`);
      p.stage("health-check");
      health = await waitForHealthy(ctx, resolveHealthUrl(appId), healthTimeout, pollMs, requiredRunning);
      if (!health.healthy) throw new RestoreStepError(`App is not healthy after restore: ${health.detail}`, health);
    } else {
      if (loadDumps.length > 0) await stopAll(ctx);
      health = { healthy: true, containers: [], detail: "App was stopped before the restore and was left stopped" };
    }

    // ── Commit, then drop the previous data ──────────────────────────────
    // The restore has succeeded. Record that before deleting anything, so a
    // restart during the (possibly long) cleanup only finishes the cleanup —
    // it must never move half-deleted previous data back into place.
    committed = true;
    persist();
    const leftovers: string[] = [];
    for (const s of swaps) {
      if (!s.existed) continue;
      await rm(s.old, { recursive: true, force: true }).catch(() => {});
      if (await pathExists(s.old)) leftovers.push(s.old);
    }
    if (leftovers.length > 0) {
      warnings.push(
        `Could not delete the previous data at ${leftovers.join(", ")} (files owned by another user, e.g. a database) — delete it by hand to free the space`,
      );
    }
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    return { success: true, restoreId: p.restoreId, backupId, appId, safetyBackupId, health, warnings };
  } catch (err) {
    const message = errorMessage(err);
    const failedHealth = err instanceof RestoreStepError ? err.health : undefined;
    log.error(`${appId}: restore failed — ${message}`);
    if (!p.allowRollback) {
      await cleanupTemps(temps, stagingDir);
      return failResult(backupId, appId, message, { safetyBackupId, health: failedHealth });
    }

    // ── Rollback ─────────────────────────────────────────────────────────
    p.stage("rolling-back");
    let rolledBack = false;
    const problems: string[] = [];
    try {
      await stopAll(ctx).catch(() => {});
      // Directory swaps are always undone first (cheap, exact) — also when
      // other data was changed in place and there is no safety backup.
      const errors = await undoSwaps(swaps, short);
      if (errors.length > 0) {
        log.error(`${appId}: rollback errors`, errors);
        problems.push(`putting the previous data back failed: ${errors.join("; ")}`);
      }
      if (composeBefore) await writeFile(ctx.composePath, composeBefore);
      if (versionBefore !== null) {
        db.update(schema.installedApps).set({ version: versionBefore }).where(eq(schema.installedApps.appId, appId)).run();
      }
      if (inPlace) {
        // Data changed in place (mount points, a database loaded over its
        // existing data) can only be put back from the safety backup.
        const safetyRow = safetyBackupId ? getBackupRow(safetyBackupId) : null;
        if (!safetyBackupId || !safetyRow?.file_path || !safetyRow.manifest_path) {
          problems.push("data changed in place could not be put back (no safety backup)");
        } else {
          const safetyManifest = await loadManifest(safetyRow.manifest_path);
          const uncovered = safetyManifest.ok ? uncoveredInPlaceDatabases(safetyManifest.manifest, inPlaceDbServices, ctx) : inPlaceDbServices;
          const r = await performRestore({
            backupId: safetyBackupId,
            appId,
            archivePath: safetyRow.file_path,
            manifestPath: safetyRow.manifest_path,
            restoreId: randomUUID(),
            opts: { ...opts, skipSafetyBackup: true },
            stage: p.stage,
            allowRollback: false,
          });
          if (!r.success) problems.push(`restoring the safety backup failed: ${r.error}`);
          if (uncovered.length > 0) {
            problems.push(`the database of ${uncovered.join(", ")} could not be put back (the safety backup has no copy of it)`);
          }
        }
      }
      rolledBack = problems.length === 0;
      if (wasRunning) {
        const started = await startAppViaLifecycle(appId);
        if (!started.success && stoppedBySafety.length > 0) await restartContainers(appId, stoppedBySafety);
      }
    } catch (rollbackErr) {
      log.error(`${appId}: rollback failed`, rollbackErr);
      problems.push(`rollback failed: ${errorMessage(rollbackErr)}`);
      rolledBack = false;
    }
    await cleanupTemps(temps, stagingDir);
    const error = problems.length > 0 ? `${message}. The previous state could not be fully restored: ${problems.join("; ")}` : message;
    return failResult(backupId, appId, error, { rolledBack, safetyBackupId, health: failedHealth });
  }
}

/**
 * Database services loaded in place whose data the safety backup cannot put
 * back: it holds neither a dump of the service nor a copy of all of the
 * service's raw (bind-mounted) data directories.
 */
export function uncoveredInPlaceDatabases(safety: BackupManifest, services: string[], ctx: Pick<AppContext, "compose">): string[] {
  return services.filter((name) => {
    if (safety.dumps.some((d) => d.service === name && d.path)) return false;
    const svc = ctx.compose.services.find((s) => s.name === name);
    const raw = svc?.dbDataPaths ?? [];
    return !(raw.length > 0 && raw.every((p) => safety.volumes.some((v) => v.hostPath === p)));
  });
}

// ── Safety backup ───────────────────────────────────────────────────────────

interface SafetyBackupParams {
  appId: string;
  ctx: AppContext;
  /** Host paths the restore is about to replace (existing ones) */
  volumes: string[];
  /** Containers before the restore started */
  before: AppContainer[];
  /** Manifest of the backup being restored */
  restoring: BackupManifest;
  dbReadyTimeoutMs: number;
  pollMs: number;
}

type SafetyBackupOutcome =
  | { ok: true; backupId: string; stopped: AppContainer[]; warnings: string[] }
  | { ok: false; error: string };

/** Host paths of the entries a backup could not read (manifest.unreadable). */
export function unreadableHostPaths(m: Pick<BackupManifest, "volumes" | "unreadable">): string[] {
  const byKey = new Map(m.volumes.map((v) => [v.key, v.hostPath]));
  const out: string[] = [];
  for (const u of m.unreadable) {
    if (!u.startsWith(`${ARCHIVE_VOLUMES_DIR}/`)) continue;
    const [key, ...rest] = u.slice(ARCHIVE_VOLUMES_DIR.length + 1).split("/");
    const host = key ? byKey.get(key) : undefined;
    if (host) out.push(rest.length > 0 && rest.join("/") ? join(host, ...rest) : host);
  }
  return out;
}

async function stopServices(ctx: AppContext, services: string[]): Promise<void> {
  const containers = await listAppContainers({ appId: ctx.appId, composePath: ctx.composePath, projectName: ctx.compose.projectName }).catch(
    () => [] as AppContainer[],
  );
  for (const c of containers) {
    if (c.status === "running" && c.service && services.includes(c.service)) await stopContainerGracefully(c.id).catch(() => {});
  }
}

/**
 * Pre-restore safety backup. It must be able to undo the restore, so:
 *
 *  - databases are captured as logical dumps, which work whether the raw data
 *    directory is a named volume or a bind mount owned by the database's own
 *    user (unreadable to Talome on a non-root install). Databases of a stopped
 *    app are started for the dump and stopped again;
 *  - files are copied cold (the app is stopped while they are archived);
 *  - when a dump is impossible, the raw database directories are copied cold
 *    instead — but only when every database keeps its data in a bind mount;
 *  - a backup that could not read part of the data it protects is refused
 *    (unless the restore keeps that data anyway).
 */
async function takeSafetyBackup(s: SafetyBackupParams): Promise<SafetyBackupOutcome> {
  const { appId, ctx } = s;
  const common = {
    purpose: "pre-restore" as const,
    volumes: s.volumes,
    exactVolumes: true,
    ignoreExcludes: true,
    leaveStopped: true,
  };
  const runningBefore = s.before.filter((c) => c.status === "running");
  const wasRunningBefore = (c: AppContainer) => runningBefore.some((b) => b.id === c.id || containerKey(b) === containerKey(c));
  const dumpable = dumpableServices(ctx);
  const warnings: string[] = [];
  const dumpErrors: string[] = [];
  let result: InternalBackupResult | null = null;

  if (dumpable.length > 0) {
    const toStart = dumpable.filter((svc) => !containerForService(runningBefore, svc));
    try {
      if (toStart.length > 0) {
        await composeUp({ appId, composePath: ctx.composePath, envOverrides: ctx.envOverrides, services: toStart.map((svc) => svc.name) });
        for (const svc of toStart) {
          await waitForDbReady(ctx, svc.name, svc.dbEngine as "postgres" | "mysql", s.dbReadyTimeoutMs, Math.min(s.pollMs, 2000));
        }
      }
      const attempt = await runBackup(appId, randomUUID(), {
        ...common,
        method: "dump",
        includeDbData: false,
        requireDumps: true,
        stopAfterDump: true,
      });
      if (attempt.result.success) result = attempt;
      else dumpErrors.push(attempt.result.error);
    } catch (err) {
      dumpErrors.push(errorMessage(err));
    }
    // Databases started only for the dump go back to being stopped
    if (!result && toStart.length > 0) await stopServices(ctx, toStart.map((svc) => svc.name));
    if (!result) {
      const rawCopyPossible = dumpable.every((svc) => svc.dbDataPaths.length > 0);
      if (!rawCopyPossible) return { ok: false, error: `could not dump the database: ${dumpErrors.join("; ")}` };
    }
  }

  if (!result) {
    const attempt = await runBackup(appId, randomUUID(), { ...common, method: "stop", includeDbData: true });
    if (!attempt.result.success) return { ok: false, error: [...dumpErrors, attempt.result.error].join("; ") };
    if (dumpErrors.length > 0) warnings.push(`The safety backup copied the raw database files (the dump failed: ${dumpErrors[0]})`);
    result = attempt;
  }
  if (!result.result.success) return { ok: false, error: result.result.error };
  const safety = result.result;

  // Everything the restore replaces must be in the safety backup
  const loaded = await loadManifest(safety.manifestPath);
  const kept = unreadableHostPaths(s.restoring);
  const gaps = loaded.ok
    ? unreadableHostPaths(loaded.manifest).filter((p) => !kept.some((k) => isWithin(k, p)))
    : [`safety backup manifest: ${loaded.error}`];
  if (gaps.length > 0) {
    const toRestart = result.stoppedContainers.filter(wasRunningBefore);
    if (toRestart.length > 0) await restartContainers(appId, toRestart);
    releaseAppMaintenance(appId);
    const del = await deleteBackup(safety.backupId);
    if (!del.ok) log.warn(`${appId}: could not delete incomplete safety backup ${safety.backupId}: ${del.error}`);
    const more = gaps.length > 3 ? ` and ${gaps.length - 3} more` : "";
    return {
      ok: false,
      error:
        `Talome cannot read ${gaps.slice(0, 3).join(", ")}${more}, so the current data there could not be protected. ` +
        "Fix the permissions, or restore without a safety backup.",
    };
  }
  return { ok: true, backupId: safety.backupId, stopped: result.stoppedContainers, warnings };
}

async function cleanupTemps(temps: string[], stagingDir: string): Promise<void> {
  for (const t of temps) await rm(t, { recursive: true, force: true }).catch(() => {});
  await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
}
