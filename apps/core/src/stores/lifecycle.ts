import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join, dirname } from "node:path";
import yaml from "js-yaml";
import { db, schema } from "../db/index.js";
import { eq, and, desc, notInArray } from "drizzle-orm";
import { listContainers, listNetworks, removeNetwork, connectContainerToNetwork } from "../docker/client.js";
import { ensureTalomeNetwork, injectTalomeNetwork } from "../docker/talome-network.js";
import { autoConfigureApp, type AutoConfigResult } from "../app-registry/auto-configure.js";
import { getAppCapabilities } from "../app-registry/index.js";
import type { InstalledAppStatus, AppVolume } from "@talome/types";
import { fireTrigger } from "../automation/engine.js";
import { writeNotification } from "../db/notifications.js";
import { createLogger } from "../utils/logger.js";
import { encryptSetting } from "../utils/crypto.js";

const log = createLogger("lifecycle");
import { autoRegisterProxyRoute, removeProxyRoutesForApp } from "../proxy/caddy.js";

// ── Extracted modules ─────────────────────────────────────────────────────
import {
  APP_DATA_DIR,
  buildEnv,
  writeAppDotEnv,
  run,
  validateCompose,
  discoverContainers,
  pinImageDigest,
  getCatalogApp,
  getInstalledApp,
  withAppLock,
} from "./compose-exec.js";
import { recordInstallError } from "./compose-errors.js";
import {
  checkPortConflicts,
  resolvePortMappings,
  buildOverrideCompose,
} from "./port-resolution.js";
import {
  checkVolumeMountFilesystems,
  injectNetworkIntoCompose,
  findComposeVars,
  generateUmbrelPlatformEnv,
  sanitizeUmbrelCompose,
  sanitizeCasaosCompose,
  applyVolumeMounts,
} from "./compose-pipeline.js";
import { executeHook } from "./lifecycle-hooks.js";
import {
  withAppOperation,
  OperationConflictError,
  currentActor,
  hasLiveOperation,
  waitForAppOperation,
  getHeldOperation,
  nestedOperationContext,
  type OperationContext,
  type OperationKind,
} from "../ops/operations.js";
import {
  captureServiceImages,
  verifyAppHealth,
  restoreServiceImages,
  probeHttp,
  type ServiceImageState,
  type VerifyResult,
  type VerifyOptions,
} from "../ops/docker-probe.js";
import { isPreUpdateBackupEnabled, takePreUpdateBackup, findPreUpdateBackupId, type PreUpdateBackupResult } from "../ops/pre-update-backup.js";
import { getSemanticBaseline, hasSemanticProbe, runSemanticVerification, type SemanticVerification } from "../ops/semantic-verify.js";
import { holdAppMaintenance } from "../backup/state.js";
import { reconcileUmbrelDependencies, applyUmbrelV2Install } from "./umbrel-v2-install.js";

// ── Re-exports (preserve public API) ─────────────────────────────────────
export { checkPortConflicts } from "./port-resolution.js";

// ── Durable per-app operations ────────────────────────────────────────────
// Every public lifecycle entry point runs as a journaled operation (see
// ops/operations.ts): a conflicting operation on the same app fails fast with
// a message naming the one in progress, and progress survives restarts.

export interface LifecycleOptions {
  /** Who requested the operation — "user:<id>", "assistant", "automation:<id>"… */
  actor?: string;
}

export interface UpdateOptions extends LifecycleOptions {
  /**
   * Proceed even when the pre-update backup (enabled by the app's update
   * policy) fails. Without it a failed backup aborts the update before any
   * container is recreated.
   */
  force?: boolean;
}

export interface OperationResultMeta {
  /** Journal id of the operation (GET /api/operations/:id) */
  operationId?: string;
  /** True when rejected because another operation on the app is running */
  conflict?: boolean;
}

async function runAppOperation<T extends { success: boolean; error?: string }>(
  appId: string,
  kind: OperationKind,
  opts: LifecycleOptions | undefined,
  fn: (ctx: OperationContext) => Promise<T>,
): Promise<T & OperationResultMeta> {
  let operationId: string | undefined;
  try {
    const result = await withAppOperation(appId, kind, opts?.actor ?? currentActor(), (ctx) => {
      operationId = ctx.id;
      // The compose lock still serializes against non-journaled writers (e.g. env edits).
      return withAppLock(appId, () => fn(ctx));
    });
    return { ...result, operationId };
  } catch (err) {
    if (err instanceof OperationConflictError) {
      const conflict: { success: false; error: string } & OperationResultMeta = {
        success: false,
        error: err.message,
        conflict: true,
        operationId: err.running.id,
      };
      return conflict as unknown as T & OperationResultMeta;
    }
    throw err;
  }
}

/**
 * Run a non-lifecycle change to an app (compose/port edits, backup with
 * stopFirst, restore) as a journaled operation under the same per-app lock,
 * so it cannot interleave with an install/update/rollback — whose automatic
 * rollback would otherwise silently overwrite the edit.
 */
export function withAppMaintenance<T extends { success: boolean; error?: string }>(
  appId: string,
  kind: Extract<OperationKind, "backup" | "restore" | "configure">,
  fn: (ctx: OperationContext) => Promise<T>,
  opts?: LifecycleOptions,
): Promise<T & OperationResultMeta> {
  return runAppOperation(appId, kind, opts, fn);
}

// ── Dependency resolution ──────────────────────────────────────────────────

export interface DependencyCheck {
  satisfied: boolean;
  missing: { appId: string; name: string; storeSourceId?: string }[];
  installed: { appId: string; name: string; status: string }[];
}

export function resolveDependencies(appId: string, storeSourceId: string): DependencyCheck {
  const app = getCatalogApp(appId, storeSourceId);
  if (!app) return { satisfied: true, missing: [], installed: [] };

  const deps: string[] = app.dependencies ? JSON.parse(app.dependencies) : [];
  if (deps.length === 0) return { satisfied: true, missing: [], installed: [] };

  const missing: DependencyCheck["missing"] = [];
  const installed: DependencyCheck["installed"] = [];

  for (const depId of deps) {
    const inst = getInstalledApp(depId);
    if (inst) {
      const depApp = getCatalogApp(depId, inst.storeSourceId);
      installed.push({ appId: depId, name: depApp?.name ?? depId, status: inst.status });
    } else {
      const catalogMatch = db
        .select()
        .from(schema.appCatalog)
        .where(eq(schema.appCatalog.appId, depId))
        .limit(1)
        .get();
      missing.push({
        appId: depId,
        name: catalogMatch?.name ?? depId,
        storeSourceId: catalogMatch?.storeSourceId,
      });
    }
  }

  return { satisfied: missing.length === 0, missing, installed };
}

// ── Bulk operations ───────────────────────────────────────────────────────

export type BulkAction = "start" | "stop" | "restart";

export interface BulkActionResult {
  appId: string;
  success: boolean;
  error?: string;
}

export async function bulkAction(
  appIds: string[],
  action: BulkAction,
): Promise<BulkActionResult[]> {
  const results = await Promise.allSettled(
    appIds.map(async (appId) => {
      let result: { success: boolean; error?: string };
      switch (action) {
        case "start":
          result = await startApp(appId);
          break;
        case "stop":
          result = await stopApp(appId);
          break;
        case "restart":
          result = await restartApp(appId);
          break;
      }
      return { appId, ...result };
    }),
  );

  return results.map((r) =>
    r.status === "fulfilled"
      ? r.value
      : { appId: "unknown", success: false, error: String((r as PromiseRejectedResult).reason) },
  );
}

export async function bulkUpdate(
  appIds: string[],
): Promise<BulkActionResult[]> {
  // Update sequentially to avoid resource contention
  const results: BulkActionResult[] = [];
  for (const appId of appIds) {
    const result = await updateApp(appId);
    results.push({ appId, ...result });
  }
  return results;
}

// ── Install ───────────────────────────────────────────────────────────────

const INSTALL_STAGE_PROGRESS: Record<string, number> = {
  pulling: 30,
  creating: 60,
  starting: 75,
  running: 90,
};

export function installApp(
  appId: string,
  storeSourceId: string,
  envOverrides: Record<string, string> = {},
  volumeMounts: Record<string, string> = {},
  onProgress?: (stage: string, message: string) => void,
  opts?: LifecycleOptions,
): Promise<{ success: boolean; error?: string; remappedPorts?: Record<number, number>; dependencies?: DependencyCheck; autoConfig?: AutoConfigResult } & OperationResultMeta> {
  return runAppOperation(appId, "install", opts, (ctx) => {
    let preparing = 0;
    const progress = (stage: string, message: string) => {
      if (stage !== "error") {
        // "queued" is reported several times while preparing — advance gently.
        const pct = stage === "queued" ? Math.min(20, (preparing += 4)) : (INSTALL_STAGE_PROGRESS[stage] ?? 0);
        ctx.step(stage === "queued" ? "preparing" : stage, pct, message);
      }
      onProgress?.(stage, message);
    };
    return installAppInner(appId, storeSourceId, envOverrides, volumeMounts, progress);
  });
}

async function installAppInner(
  appId: string,
  storeSourceId: string,
  envOverrides: Record<string, string>,
  volumeMounts: Record<string, string>,
  onProgress?: (stage: string, message: string) => void,
): Promise<{ success: boolean; error?: string; remappedPorts?: Record<number, number>; dependencies?: DependencyCheck; autoConfig?: AutoConfigResult }> {
  const app = getCatalogApp(appId, storeSourceId);
  if (!app) return { success: false, error: "App not found in catalog" };

  if (!existsSync(app.composePath)) {
    return { success: false, error: "Docker compose file not found" };
  }

  const existing = getInstalledApp(appId);
  if (existing) {
    return { success: false, error: "App is already installed" };
  }

  // Check dependencies
  onProgress?.("queued", "Checking dependencies…");
  const depCheck = reconcileUmbrelDependencies(app, resolveDependencies(appId, storeSourceId));
  if (!depCheck.satisfied) {
    return {
      success: false,
      error: `Missing dependencies: ${depCheck.missing.map((d) => d.name).join(", ")}. Install them first or ask the user.`,
      dependencies: depCheck,
    };
  }

  // ── Permission validation ──────────────────────────────────────────
  const permissions = app.permissions
    ? (typeof app.permissions === "string" ? JSON.parse(app.permissions as string) : app.permissions) as Record<string, unknown>
    : null;
  if (permissions) {
    const warnings: string[] = [];
    if (permissions.gpu) {
      const hasGpu = existsSync("/dev/dri") || (() => {
        try { execSync("nvidia-smi", { stdio: "pipe", timeout: 5000 }); return true; } catch { return false; }
      })();
      if (!hasGpu) {
        warnings.push("This app requests GPU access but no GPU was detected. It may not work correctly.");
      }
    }
    if (Array.isArray(permissions.storageAccess)) {
      for (const p of permissions.storageAccess) {
        if (typeof p === "string" && p.startsWith("/") && !existsSync(p)) {
          warnings.push(`Requested storage path ${p} does not exist.`);
        }
      }
    }
    if (warnings.length > 0) {
      writeNotification("warning", `Permission warnings for ${app.name}`, warnings.join(" "), appId);
    }
  }

  // ── CasaOS compose sanitization ─────────────────────────────────────
  onProgress?.("queued", "Preparing compose…");
  const isCasaos = app.source === "casaos";
  let casaosOverride: string | null = null;

  if (isCasaos) {
    casaosOverride = sanitizeCasaosCompose(app.composePath, appId);
  }

  // ── Umbrel compose sanitization ──────────────────────────────────────
  const isUmbrel = app.source === "umbrel";
  let umbrelOverride: string | null = null;
  let mergedEnvOverrides = { ...envOverrides };

  if (isUmbrel) {
    // Auto-generate Umbrel platform vars, let user overrides win
    const platformEnv = generateUmbrelPlatformEnv(app.composePath, appId);
    mergedEnvOverrides = { ...platformEnv, ...envOverrides };

    // Sanitize compose: strip app_proxy, add port mappings, remove version
    umbrelOverride = sanitizeUmbrelCompose(app.composePath, appId, app.webPort ?? undefined);
  }

  onProgress?.("queued", "Resolving ports…");
  const ports = JSON.parse(app.ports) as { host: number; container: number }[];
  const { resolved, remapped } = await resolvePortMappings(ports);

  // Use sanitized compose as the base for port remapping
  const baseCompose = casaosOverride || umbrelOverride || app.composePath;
  const portOverride = buildOverrideCompose(baseCompose, appId, remapped);
  const afterPortCompose = portOverride || casaosOverride || umbrelOverride;

  // Apply user-provided media volume mounts
  const catalogVolumes = JSON.parse(app.volumes) as AppVolume[];
  const volumeOverride = applyVolumeMounts(
    afterPortCompose || app.composePath,
    appId,
    volumeMounts,
    catalogVolumes,
  );
  let effectiveCompose = volumeOverride || afterPortCompose;
  let composePath = effectiveCompose || app.composePath;

  // ── Inject unified talome network ────────────────────────────────────
  onProgress?.("queued", "Configuring network…");
  try {
    composePath = await injectNetworkIntoCompose(composePath, appId);
    effectiveCompose = composePath;
  } catch (err: unknown) {
    log.warn(`talome network injection for ${appId}`, err);
  }

  // ── Umbrel 2.0 manifest (folderAccess, environment, GPU, dataRoot, torOnly) ──
  const umbrelV2 = applyUmbrelV2Install(app, appId, composePath, mergedEnvOverrides);
  if (!umbrelV2.ok) return { success: false, error: umbrelV2.error };
  if (umbrelV2.composePath) composePath = effectiveCompose = umbrelV2.composePath;
  mergedEnvOverrides = umbrelV2.env;

  // ── Write per-app .env file ─────────────────────────────────────────
  writeAppDotEnv(appId, mergedEnvOverrides);

  // ── Check volume mount filesystems ──────────────────────────────────
  const fsWarnings = checkVolumeMountFilesystems(volumeMounts);

  db.insert(schema.installedApps)
    .values({
      appId,
      storeSourceId,
      status: "installing",
      envConfig: JSON.stringify(mergedEnvOverrides),
      version: app.version,
      overrideComposePath: effectiveCompose ?? null,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();

  const env = buildEnv(appId, mergedEnvOverrides);

  // ── Pre-install validation ──────────────────────────────────────────
  onProgress?.("queued", "Validating configuration…");
  const composeVars = findComposeVars(composePath);
  const missingVars = composeVars.filter((v) => !env[v]);
  if (missingVars.length > 0) {
    db.delete(schema.installedApps).where(eq(schema.installedApps.appId, appId)).run();
    const varList = missingVars.join(", ");
    return {
      success: false,
      error: `This app requires environment variables that could not be auto-generated: ${varList}. ` +
        `Please provide values for these variables using the env parameter, or ask the user for the required configuration.`,
    };
  }

  try {
    const projectDir = effectiveCompose ? dirname(effectiveCompose) : dirname(app.composePath);

    // Pre-flight validation — catches YAML errors, invalid services, etc.
    const validation = await validateCompose(composePath, { cwd: projectDir, env });
    if (!validation.valid) {
      db.delete(schema.installedApps).where(eq(schema.installedApps.appId, appId)).run();
      return {
        success: false,
        error: `Compose file validation failed: ${validation.error?.slice(0, 500)}`,
      };
    }

    onProgress?.("pulling", "Pulling image...");
    await run(`docker compose -f "${composePath}" pull`, {
      cwd: projectDir,
      env,
      timeout: 300_000,
    }).catch(() => {
      // Pull may fail for local images — continue with up
    });

    onProgress?.("creating", "Starting containers...");
    try {
      await run(`docker compose -f "${composePath}" up -d`, {
        cwd: projectDir,
        env,
        timeout: 180_000,
      });
    } catch (upErr: any) {
      // If a container name conflict exists, remove the conflicting container and retry
      if (upErr.message?.includes("is already in use")) {
        const nameMatch = upErr.message.match(/container name "\/([^"]+)"/);
        if (nameMatch) {
          await run(`docker rm -f ${nameMatch[1]}`, { cwd: projectDir, timeout: 15_000 }).catch((err) => log.warn(`Failed to remove conflicting container ${nameMatch[1]}`, err));
          await run(`docker compose -f "${composePath}" up -d`, {
            cwd: projectDir,
            env,
            timeout: 180_000,
          });
        } else {
          throw upErr;
        }
      } else {
        throw upErr;
      }
    }

    const containers = await discoverContainers(appId);

    db.update(schema.installedApps)
      .set({
        status: "running",
        containerIds: JSON.stringify(containers),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    onProgress?.("running", "Ready");

    // Pin image digest for reproducible deploys
    pinImageDigest(appId, composePath);

    // Execute postInstall hook (best-effort)
    void executeHook("postInstall", appId, app.hooks, { composePath, env });

    void fireTrigger("app_installed", { appId });
    void import("../setup/triggers.js").then((m) => m.onAppInstalled(appId)).catch(() => {});
    writeNotification("info", `${app.name} installed`, "App is up and running", appId);

    // Auto-register proxy route
    if (app.webPort) {
      void autoRegisterProxyRoute(appId, app.name, app.webPort);
    }

    const hasRemaps = Object.keys(remapped).length > 0;

    // Persist remapped ports to catalog so the UI shows correct ports
    if (hasRemaps) {
      db.update(schema.appCatalog)
        .set({ ports: JSON.stringify(resolved) })
        .where(
          and(
            eq(schema.appCatalog.appId, appId),
            eq(schema.appCatalog.storeSourceId, storeSourceId),
          ),
        )
        .run();
    }

    // ── Post-install auto-configuration (best-effort, non-blocking) ───
    let autoConfigResult: AutoConfigResult | undefined;
    const caps = getAppCapabilities(appId);
    if (caps) {
      try {
        autoConfigResult = await autoConfigureApp(appId, caps);
        if (fsWarnings.length > 0) {
          autoConfigResult.warnings.push(...fsWarnings);
        }
      } catch (err: unknown) {
        log.warn(`auto-configure ${appId}`, err);
        if (fsWarnings.length > 0) {
          autoConfigResult = {
            apiKeyExtracted: false,
            settingsSaved: [],
            wiring: [],
            warnings: fsWarnings,
          };
        }
      }
    } else if (fsWarnings.length > 0) {
      autoConfigResult = {
        apiKeyExtracted: false,
        settingsSaved: [],
        wiring: [],
        warnings: fsWarnings,
      };
    }

    return {
      success: true,
      ...(hasRemaps ? { remappedPorts: remapped } : {}),
      ...(autoConfigResult ? { autoConfig: autoConfigResult } : {}),
    };
  } catch (err: any) {
    const errorDetail = err?.stderr || err.message;
    recordInstallError(appId, `docker compose -f "${composePath}" up -d`, err, composePath, env);

    db.update(schema.installedApps)
      .set({
        status: "error",
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    writeNotification("critical", `Failed to install ${app.name}`, errorDetail, appId);
    onProgress?.("error", errorDetail);
    return { success: false, error: errorDetail };
  }
}

// ── Uninstall ─────────────────────────────────────────────────────────────

export function uninstallApp(appId: string, opts?: LifecycleOptions): Promise<{ success: boolean; error?: string } & OperationResultMeta> {
  return runAppOperation(appId, "uninstall", opts, (ctx) => uninstallAppInner(appId, ctx));
}

async function uninstallAppInner(appId: string, ctx: OperationContext): Promise<{ success: boolean; error?: string }> {
  const installed = getInstalledApp(appId);
  if (!installed) return { success: false, error: "App is not installed" };

  const app = getCatalogApp(appId, installed.storeSourceId);
  if (!app) {
    db.delete(schema.installedApps)
      .where(eq(schema.installedApps.appId, appId))
      .run();
    return { success: true };
  }

  // Execute preUninstall hook (best-effort)
  ctx.step("pre_uninstall_hook", 10, "Running pre-uninstall hook");
  const envOverridesUninst = JSON.parse(installed.envConfig) as Record<string, string>;
  const envUninst = buildEnv(appId, envOverridesUninst);
  await executeHook("preUninstall", appId, app.hooks, { composePath: app.composePath, env: envUninst }).catch((err) => log.warn(`preUninstall hook failed for ${appId}`, err));

  ctx.step("remove_containers", 30, "Stopping and removing containers");
  try {
    const effectiveCompose = installed.overrideComposePath ?? app.composePath;
    const projectDir = dirname(effectiveCompose);
    await run(`docker compose -f "${effectiveCompose}" down`, {
      cwd: projectDir,
      timeout: 60_000,
    });
  } catch {
    // Continue even if compose down fails
  }

  // Clean up app-specific networks (not the shared talome network)
  ctx.step("cleanup", 70, "Removing app networks and proxy routes");
  try {
    const networks = await listNetworks();
    const appNetworks = networks.filter(n =>
      n.name.includes(appId) && n.name !== "talome" && n.driver === "bridge"
    );
    for (const net of appNetworks) {
      if (net.containers.length === 0) {
        await removeNetwork(net.name);
      }
    }
  } catch { /* non-fatal */ }

  void removeProxyRoutesForApp(appId);

  db.delete(schema.installedApps)
    .where(eq(schema.installedApps.appId, appId))
    .run();

  return { success: true };
}

// ── Start / Stop / Restart ────────────────────────────────────────────────

export async function startApp(appId: string, opts?: LifecycleOptions): Promise<{ success: boolean; error?: string } & OperationResultMeta> {
  return composeAction(appId, "start", opts);
}

export async function stopApp(appId: string, opts?: LifecycleOptions): Promise<{ success: boolean; error?: string } & OperationResultMeta> {
  return composeAction(appId, "stop", opts);
}

export async function restartApp(appId: string, opts?: LifecycleOptions): Promise<{ success: boolean; error?: string } & OperationResultMeta> {
  return composeAction(appId, "restart", opts);
}

/**
 * Start an app from code that may already run inside an operation on the same
 * app (a restore run as a journaled operation, see backup/operation.ts). Inside such an
 * operation the start is recorded as nested steps of it — the operation and
 * the compose lock are already held, so taking them again would conflict or
 * deadlock. Anywhere else it is a plain startApp().
 */
export async function startAppWithinHeldOperation(appId: string, opts?: LifecycleOptions): Promise<{ success: boolean; error?: string } & OperationResultMeta> {
  const held = getHeldOperation(appId);
  if (!held) return startApp(appId, opts);
  const result = await composeActionInner(appId, "start", nestedOperationContext(held, "start"));
  return { ...result, operationId: held.id };
}

// Internal dependency starts wait for an operation already running on the
// dependency (e.g. a parallel bulk start of the same group) instead of failing
// fast like user-facing entry points do. `waitingOn` guards against circular
// dependencies waiting on each other forever.
const DEPENDENCY_WAIT_MS = Number(process.env.TALOME_DEPENDENCY_WAIT_MS) || 10 * 60_000;
const waitingOn = new Map<string, string>();

function wouldDeadlock(appId: string, depId: string): boolean {
  let cursor: string | undefined = depId;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    if (cursor === appId) return true;
    seen.add(cursor);
    cursor = waitingOn.get(cursor);
  }
  return false;
}

async function ensureDependencyRunning(appId: string, depId: string): Promise<{ success: boolean; error?: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (hasLiveOperation(depId)) {
      if (wouldDeadlock(appId, depId)) {
        return { success: false, error: `Circular dependency between ${appId} and ${depId}` };
      }
      waitingOn.set(appId, depId);
      let free: boolean;
      try {
        free = await waitForAppOperation(depId, { timeoutMs: DEPENDENCY_WAIT_MS });
      } finally {
        waitingOn.delete(appId);
      }
      if (!free) return { success: false, error: `Timed out waiting for the operation running on ${depId}` };
    }
    // Whatever just ran on the dependency may already have started it.
    if (getInstalledApp(depId)?.status === "running") return { success: true };
    const result = await startApp(depId);
    if (result.success || !result.conflict) return result;
    // An operation on the dependency began between our check and our start — wait for it, then re-check.
  }
  return { success: false, error: `${depId} is busy with other operations` };
}

function composeAction(
  appId: string,
  action: "start" | "stop" | "restart",
  opts?: LifecycleOptions,
): Promise<{ success: boolean; error?: string } & OperationResultMeta> {
  return runAppOperation(appId, action, opts, (ctx) => composeActionInner(appId, action, ctx));
}

async function composeActionInner(
  appId: string,
  action: "start" | "stop" | "restart",
  ctx: OperationContext,
): Promise<{ success: boolean; error?: string }> {
  const installed = getInstalledApp(appId);
  if (!installed) return { success: false, error: "App is not installed" };

  const app = getCatalogApp(appId, installed.storeSourceId);
  if (!app) return { success: false, error: "App not found in catalog" };

  const effectiveCompose = installed.overrideComposePath ?? app.composePath;

  const envOverrides = JSON.parse(installed.envConfig) as Record<string, string>;

  // Refresh the .env file before start/restart so any settings changes are picked up
  if (action === "start" || action === "restart") {
    writeAppDotEnv(appId, envOverrides);
  }

  const env = buildEnv(appId, envOverrides);
  ctx.step("prepare", 10, `Preparing to ${action}`);

  try {
    const projectDir = dirname(effectiveCompose);

    // Ensure talome network exists before any compose up (survives Docker/OrbStack restarts)
    if (action !== "stop") {
      await ensureTalomeNetwork().catch((err: unknown) =>
        log.warn(`ensureTalomeNetwork before ${action} ${appId}`, err),
      );
    }

    // Execute preStart hook before starting or restarting
    if (action === "start" || action === "restart") {
      await executeHook("preStart", appId, app.hooks, { composePath: effectiveCompose, env }).catch((err) => log.warn(`preStart hook failed for ${appId}`, err));
    }

    if (action === "start") {
      // Check that dependencies are installed and running before starting
      if (installed.storeSourceId) {
        const depCheck = resolveDependencies(appId, installed.storeSourceId);
        const stoppedDeps = depCheck.installed.filter((d) => d.status !== "running");
        if (depCheck.missing.length > 0) {
          return {
            success: false,
            error: `Missing dependencies: ${depCheck.missing.map((d) => d.name).join(", ")}. Install them first.`,
          };
        }
        if (stoppedDeps.length > 0) {
          // Auto-start stopped dependencies before starting the app
          ctx.step("dependencies", 20, `Starting ${stoppedDeps.length} dependency app(s)`);
          for (const dep of stoppedDeps) {
            log.info(`Starting dependency ${dep.name} before ${appId}`);
            const depResult = await ensureDependencyRunning(appId, dep.appId);
            if (!depResult.success) {
              return {
                success: false,
                error: `Dependency ${dep.name} failed to start: ${depResult.error}`,
              };
            }
          }
        }
      }

      // Clean up any leftover containers from this compose project
      ctx.step("start_containers", 40, "Starting containers");
      await run(`docker compose -f "${effectiveCompose}" down --remove-orphans`, {
        cwd: projectDir,
        env,
        timeout: 30_000,
      }).catch((err) => log.warn(`Failed to clean up old containers for ${appId}`, err));

      try {
        await run(`docker compose -f "${effectiveCompose}" up -d`, {
          cwd: projectDir,
          env,
          timeout: 180_000,
        });
      } catch (upErr: any) {
        if (upErr.message?.includes("is already in use")) {
          const nameMatch = upErr.message.match(/container name "\/([^"]+)"/);
          if (nameMatch) {
            await run(`docker rm -f ${nameMatch[1]}`, { cwd: projectDir, timeout: 15_000 }).catch((err) => log.warn(`Failed to remove conflicting container ${nameMatch[1]}`, err));
            await run(`docker compose -f "${effectiveCompose}" up -d`, {
              cwd: projectDir,
              env,
              timeout: 180_000,
            });
          } else {
            throw upErr;
          }
        } else {
          throw upErr;
        }
      }
    } else if (action === "restart") {
      ctx.step("recreate_containers", 40, "Recreating containers");
      await run(`docker compose -f "${effectiveCompose}" up -d --force-recreate`, {
        cwd: projectDir,
        env,
        timeout: 180_000,
      });
    } else {
      ctx.step("stop_containers", 40, "Stopping containers");
      await run(`docker compose -f "${effectiveCompose}" ${action}`, {
        cwd: projectDir,
        env,
        timeout: 60_000,
      });
    }

    const newStatus: InstalledAppStatus = action === "stop" ? "stopped" : "running";

    db.update(schema.installedApps)
      .set({ status: newStatus, updatedAt: new Date().toISOString() })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    // Execute postStart hook after successful start/restart
    if (action === "start" || action === "restart") {
      void executeHook("postStart", appId, app.hooks, { composePath: effectiveCompose, env });
    }

    return { success: true };
  } catch (err: any) {
    const errorDetail = err?.stderr || err.message;
    recordInstallError(appId, `docker compose ${action}`, err, effectiveCompose, env);

    if (action !== "stop") {
      db.update(schema.installedApps)
        .set({ status: "error" as InstalledAppStatus, updatedAt: new Date().toISOString() })
        .where(eq(schema.installedApps.appId, appId))
        .run();

      writeNotification("critical", `Failed to ${action} ${app.name}`, errorDetail, appId);
    }

    return { success: false, error: errorDetail };
  }
}

// ── Update ────────────────────────────────────────────────────────────────
//
// Safe update pipeline (each step journaled with honest progress):
//   1. snapshot   — compose, env and the exact image each service runs (before
//                   pulling: afterwards the tag points at the new image)
//   2. pull       — new images are downloaded while the app keeps running; a
//                   failed pull leaves the app untouched
//   3. backup     — best-effort pre-update backup of the app's config volumes
//   4. recreate   — containers recreated on the new images
//   5. verify     — containers running, healthchecks healthy, no restart loop,
//                   web UI answering (when it answered before the update)
//   6. rollback   — on recreate/verify failure: previous compose + images are
//                   restored and verified again; status rolled_back + notice

type UpdateSnapshotRow = typeof schema.updateSnapshots.$inferSelect;

/** Base verification window; a healthcheck's own start_period + interval × retries extends it. */
const UPDATE_VERIFY_TIMEOUT_MS = Number(process.env.TALOME_UPDATE_VERIFY_TIMEOUT_MS) || 120_000;
/** Upper bound for that extension (slow first-start migrations). */
const UPDATE_VERIFY_MAX_MS = Number(process.env.TALOME_UPDATE_VERIFY_MAX_MS) || 15 * 60_000;
/** Update snapshots kept per app (older ones are pruned). */
const SNAPSHOTS_KEPT_PER_APP = 5;

const IRREVERSIBLE_NOTE =
  "Rolling back restores the previous container images and compose file, but cannot undo data or database " +
  "migrations the new version may already have applied to the app's volumes.";

export interface UpdateResult {
  success: boolean;
  error?: string;
  /** True when the new version passed health verification */
  verified?: boolean;
  /** True when verification failed and the previous version was restored */
  rolledBack?: boolean;
  /**
   * updated     — new images running and verified healthy
   * no_change   — nothing new was pulled; version left unchanged
   * unverified  — new version running but still settling at the deadline; not rolled back
   * rolled_back — verification failed hard; previous version restored and healthy
   * failed      — the update (or its rollback) did not complete
   */
  outcome?: "updated" | "no_change" | "unverified" | "rolled_back" | "failed";
  /** Human-readable caveat for success results (e.g. why it is unverified) */
  warning?: string;
  /** True when the update was aborted because the pre-update backup failed (retry with force to skip it) */
  backupFailed?: boolean;
  /** Backup taken right before the update (restorable per app) */
  preUpdateBackupId?: string;
  /** After a rollback: how to also revert the app's data */
  dataRestoreHint?: string;
  /** Outcome-probe result after the update (apps with outcome probes only) */
  semanticVerification?: { status: string; baseline: string | null; regression: boolean; summary: string };
}

function parseSnapshotImages(raw: string | null | undefined): ServiceImageState[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ServiceImageState[]) : [];
  } catch {
    return [];
  }
}

function runningServices(images: ServiceImageState[]): string[] {
  return [...new Set(images.filter((i) => i.status === "running").map((i) => i.service))];
}

function recordUpdateSnapshot(
  appId: string,
  installed: { version: string; envConfig: string },
  composePath: string,
  images: ServiceImageState[],
  operationId: string,
): number | null {
  let composeContent: string | null = null;
  try {
    composeContent = readFileSync(composePath, "utf-8");
  } catch {
    return null; // Without the compose we cannot promise a rollback
  }
  const primary = images[0];
  try {
    const row = db
      .insert(schema.updateSnapshots)
      .values({
        appId,
        previousVersion: installed.version,
        previousImage: primary?.imageId ?? primary?.imageRef ?? null,
        previousDigest: primary?.repoDigest?.match(/sha256:[a-f0-9]{64}/)?.[0] ?? null,
        previousCompose: composeContent,
        // Env overrides often hold app passwords/API keys — encrypted at rest.
        previousEnv: encryptSetting(installed.envConfig),
        previousImages: JSON.stringify(images),
        operationId,
        createdAt: new Date().toISOString(),
      })
      .returning({ id: schema.updateSnapshots.id })
      .get();
    if (row) pruneUpdateSnapshots(appId);
    return row?.id ?? null;
  } catch (err) {
    log.warn(`Failed to record update snapshot for ${appId}`, err);
    return null;
  }
}

function pruneUpdateSnapshots(appId: string): void {
  try {
    const keep = db
      .select({ id: schema.updateSnapshots.id })
      .from(schema.updateSnapshots)
      .where(eq(schema.updateSnapshots.appId, appId))
      .orderBy(desc(schema.updateSnapshots.id))
      .limit(SNAPSHOTS_KEPT_PER_APP)
      .all()
      .map((r) => r.id);
    if (keep.length < SNAPSHOTS_KEPT_PER_APP) return;
    db.delete(schema.updateSnapshots)
      .where(and(eq(schema.updateSnapshots.appId, appId), notInArray(schema.updateSnapshots.id, keep)))
      .run();
  } catch (err) {
    log.warn(`Failed to prune update snapshots for ${appId}`, err);
  }
}

/**
 * The override compose written at install freezes the catalog's image refs.
 * An update must move them to the catalog's current refs, or `pull` + `up -d`
 * would just re-run the old image. Only `image:` of services present in both
 * files changes; every other override edit (ports, volumes, network) is kept.
 * The pre-update compose is in the snapshot, so a rollback restores the old refs.
 */
export function syncOverrideImageRefs(
  overridePath: string,
  catalogPath: string,
): { service: string; from: string; to: string }[] {
  if (overridePath === catalogPath || !existsSync(overridePath) || !existsSync(catalogPath)) return [];
  const override = yaml.load(readFileSync(overridePath, "utf-8")) as { services?: Record<string, Record<string, unknown> | null> } | null;
  const catalog = yaml.load(readFileSync(catalogPath, "utf-8")) as { services?: Record<string, Record<string, unknown> | null> } | null;
  const overrideServices = override?.services;
  const catalogServices = catalog?.services;
  if (!overrideServices || !catalogServices) return [];

  const changes: { service: string; from: string; to: string }[] = [];
  for (const [name, svc] of Object.entries(overrideServices)) {
    const from = svc?.image;
    const to = catalogServices[name]?.image;
    if (svc && typeof from === "string" && typeof to === "string" && to.trim() && from !== to) {
      svc.image = to;
      changes.push({ service: name, from, to });
    }
  }
  if (changes.length > 0) {
    atomicWriteFileSync(overridePath, yaml.dump(override, { lineWidth: -1 }), "utf-8");
  }
  return changes;
}

/** Services whose previous image could not be put back ("" when all were). */
function describeUnrestoredImages(
  baseline: ServiceImageState[],
  imagesRestored: Awaited<ReturnType<typeof restoreServiceImages>>,
): string {
  if (baseline.length === 0) return "no previous images were recorded";
  return imagesRestored
    .filter((r) => !r.restored)
    .map((r) => `${r.service} (${r.error ?? "not restored"})`)
    .join(", ");
}

/**
 * Restore compose + images from a snapshot and recreate the containers.
 * Throws if the recreate command fails.
 */
async function restoreFromSnapshot(
  appId: string,
  snapshot: UpdateSnapshotRow,
  composeTarget: string,
  env: Record<string, string>,
): Promise<{ imagesRestored: Awaited<ReturnType<typeof restoreServiceImages>> }> {
  if (snapshot.previousCompose) {
    atomicWriteFileSync(composeTarget, snapshot.previousCompose, "utf-8");
  }

  const images = parseSnapshotImages(snapshot.previousImages);
  const imagesRestored = images.length > 0 ? await restoreServiceImages(images) : [];

  await ensureTalomeNetwork().catch((err: unknown) =>
    log.warn(`ensureTalomeNetwork before rollback ${appId}`, err),
  );

  await run(`docker compose -f "${composeTarget}" up -d --force-recreate --remove-orphans`, {
    cwd: dirname(composeTarget),
    env,
    timeout: 180_000,
  });

  return { imagesRestored };
}

export interface RollbackResult {
  success: boolean;
  error?: string;
  rolledBackTo?: string;
  verified?: boolean;
  /**
   * Backup taken right before the update that is being rolled back. A rollback
   * restores images and compose, not data — restoring this backup also
   * reverts data migrations the newer version applied.
   */
  preUpdateBackupId?: string;
  dataRestoreHint?: string;
}

export function rollbackUpdate(appId: string, opts?: LifecycleOptions): Promise<RollbackResult & OperationResultMeta> {
  return runAppOperation(appId, "rollback", opts, async (ctx) => {
    // Containers are recreated: keep monitors and the agent loop quiet until done.
    const releaseMaintenance = holdAppMaintenance(appId, "rollback");
    try {
      return await rollbackUpdateInner(appId, ctx);
    } finally {
      releaseMaintenance();
    }
  });
}

function dataRestoreHint(backupId: string): string {
  return `The rollback restored the previous images and compose file but not the app's data. ` +
    `To also revert data changes made by the newer version, restore the pre-update backup ${backupId} ` +
    `(restore_app with backupId, or Backups → Restore). Data written since the update would be lost.`;
}

async function rollbackUpdateInner(appId: string, ctx: OperationContext): Promise<RollbackResult> {
  ctx.step("preflight", 5, "Finding rollback snapshot");
  const installed = getInstalledApp(appId);
  if (!installed) return { success: false, error: "App is not installed" };

  const app = getCatalogApp(appId, installed.storeSourceId);
  if (!app) return { success: false, error: "App not found in catalog" };

  const snapshot = db
    .select()
    .from(schema.updateSnapshots)
    .where(and(eq(schema.updateSnapshots.appId, appId), eq(schema.updateSnapshots.rolledBack, false)))
    .orderBy(desc(schema.updateSnapshots.id))
    .limit(1)
    .get();

  if (!snapshot) {
    return { success: false, error: "No update snapshot available to roll back to" };
  }
  ctx.setDetail({ snapshotId: snapshot.id, targetVersion: snapshot.previousVersion, irreversibleNote: IRREVERSIBLE_NOTE });
  const preUpdateBackupId = findPreUpdateBackupId(snapshot);
  const dataRestore = preUpdateBackupId ? { preUpdateBackupId, dataRestoreHint: dataRestoreHint(preUpdateBackupId) } : {};
  if (preUpdateBackupId) ctx.setDetail({ dataRestore: { backupId: preUpdateBackupId, available: true } });

  const effectiveCompose = installed.overrideComposePath ?? app.composePath;
  const envOverrides = JSON.parse(installed.envConfig) as Record<string, string>;
  const env = buildEnv(appId, envOverrides);

  try {
    ctx.step("restore", 30, `Restoring version ${snapshot.previousVersion}`);
    const snapshotImages = parseSnapshotImages(snapshot.previousImages);
    const { imagesRestored } = await restoreFromSnapshot(appId, snapshot, effectiveCompose, env);
    ctx.setDetail({ imagesRestored });

    ctx.step("verify", 70, "Verifying app health");
    const verification = await verifyAppHealth(appId, {
      composePath: effectiveCompose,
      requiredServices: runningServices(snapshotImages),
      timeoutMs: UPDATE_VERIFY_TIMEOUT_MS,
      maxTimeoutMs: UPDATE_VERIFY_MAX_MS,
    });
    ctx.setDetail({ verification: summarizeVerification(verification) });

    const containers = await discoverContainers(appId);
    const unrestored = describeUnrestoredImages(snapshotImages, imagesRestored);

    if (unrestored) {
      // Compose went back, but the image tags may still point at the new
      // version — do not claim the previous version is running.
      const error = `Restored the previous compose file, but not the previous images: ${unrestored}. ` +
        `The app may still be running the newer images.`;
      db.update(schema.installedApps)
        .set({
          status: verification.healthy ? "running" : "error",
          containerIds: JSON.stringify(containers),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.installedApps.appId, appId))
        .run();
      ctx.markFailed(error);
      writeNotification("warning", `${app.name} rollback incomplete`, error, appId);
      return { success: false, error, verified: verification.healthy };
    }

    db.update(schema.installedApps)
      .set({
        status: verification.healthy ? "running" : "error",
        containerIds: JSON.stringify(containers),
        version: snapshot.previousVersion,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    db.update(schema.updateSnapshots)
      .set({ rolledBack: true, rollbackReason: "Manual rollback" })
      .where(eq(schema.updateSnapshots.id, snapshot.id))
      .run();

    if (!verification.healthy) {
      // The rollback ran, but the journal must not say "succeeded" for an app left unhealthy.
      ctx.markFailed(`Rolled back to version ${snapshot.previousVersion}, but the app did not pass health checks: ${verification.reason}`);
    }

    const restoreNote = preUpdateBackupId ? ` A pre-update data backup (${preUpdateBackupId}) can be restored if the newer version changed the app's data.` : "";
    if (verification.healthy) {
      writeNotification("info", `${app.name} rolled back`, `Reverted to version ${snapshot.previousVersion}.${restoreNote}`, appId);
    } else {
      writeNotification(
        "warning",
        `${app.name} rolled back but not healthy`,
        `Reverted to version ${snapshot.previousVersion}, but the app did not pass health checks: ${verification.reason}.${restoreNote}`,
        appId,
      );
    }
    return { success: true, rolledBackTo: snapshot.previousVersion, verified: verification.healthy, ...dataRestore };
  } catch (err: any) {
    const errorDetail = err?.stderr || err.message;
    db.update(schema.installedApps)
      .set({ status: "error", updatedAt: new Date().toISOString() })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    writeNotification("critical", `Failed to rollback ${app.name}`, errorDetail, appId);
    return { success: false, error: errorDetail };
  }
}

function summarizeVerification(v: VerifyResult): Record<string, unknown> {
  return {
    healthy: v.healthy,
    verdict: v.verdict,
    reason: v.reason,
    checks: v.checks,
    elapsedMs: v.elapsedMs,
    containers: v.containers.map((c) => ({ name: c.name, status: c.status, health: c.health, restartCount: c.restartCount })),
    ...(v.http ? { http: v.http } : {}),
  };
}

export function updateApp(appId: string, opts?: UpdateOptions): Promise<UpdateResult & OperationResultMeta> {
  return runAppOperation(appId, "update", opts, async (ctx) => {
    // The maintenance window opens when containers are about to be recreated
    // (the pull leaves the app running) and always closes here.
    const maintenance: { release: (() => void) | null } = { release: null };
    const beginMaintenance = (keys: Array<string | null | undefined>) => {
      maintenance.release ??= holdAppMaintenance(appId, "update", keys);
    };
    try {
      return await updateAppInner(appId, ctx, { force: opts?.force === true, beginMaintenance });
    } finally {
      maintenance.release?.();
    }
  });
}

interface UpdateRunOptions {
  force: boolean;
  beginMaintenance: (keys: Array<string | null | undefined>) => void;
}

function summarizeSemantic(v: SemanticVerification): UpdateResult["semanticVerification"] {
  return { status: v.status ?? "unknown", baseline: v.baseline, regression: v.regression, summary: v.summary ?? "" };
}

async function updateAppInner(appId: string, ctx: OperationContext, runOpts: UpdateRunOptions): Promise<UpdateResult> {
  ctx.step("preflight", 2, "Checking app");
  const installed = getInstalledApp(appId);
  if (!installed) return { success: false, error: "App is not installed" };

  const app = getCatalogApp(appId, installed.storeSourceId);
  if (!app) return { success: false, error: "App not found in catalog" };

  let effectiveCompose = installed.overrideComposePath ?? app.composePath;
  const envOverrides = JSON.parse(installed.envConfig) as Record<string, string>;
  const env = buildEnv(appId, envOverrides);
  ctx.setDetail({ fromVersion: installed.version, toVersion: app.version, composePath: effectiveCompose });

  // ── 1. Snapshot (before pull — tags move once new images land) ─────────
  ctx.step("snapshot", 5, "Recording current images, compose and settings for rollback");
  let baselineImages: ServiceImageState[];
  try {
    baselineImages = await captureServiceImages(appId, effectiveCompose);
  } catch (err: unknown) {
    // Without the current images a failed update could not be rolled back.
    const reason = err instanceof Error ? err.message : String(err);
    const error = `Could not read the app's current containers from Docker (${reason}). Update aborted; the app was not changed.`;
    ctx.setDetail({ appTouched: false });
    writeNotification("warning", `Update of ${app.name} did not start`, error, appId);
    return { success: false, error, outcome: "failed" };
  }
  // No containers (e.g. the app was never started): the update can proceed,
  // but there is nothing to roll back to except the compose file.
  const imageRollbackAvailable = baselineImages.length > 0;
  const requiredServices = runningServices(baselineImages);
  // Status to restore if the update never touches the app. A transient status
  // left by an earlier crash is replaced by what Docker actually shows.
  const previousStatus: InstalledAppStatus = installed.status === "installing" || installed.status === "updating"
    ? (requiredServices.length > 0 ? "running" : "stopped")
    : (installed.status as InstalledAppStatus);
  const baselineHttp = app.webPort && requiredServices.length > 0 ? await probeHttp(app.webPort) : null;
  // The outcome-probe baseline is the last stored result from BEFORE the update.
  const semanticProbe = await hasSemanticProbe(appId);
  const semanticBaseline = semanticProbe ? await getSemanticBaseline(appId) : null;

  const snapshotId = recordUpdateSnapshot(appId, installed, effectiveCompose, baselineImages, ctx.id);
  if (snapshotId === null) {
    const error = "Could not record a rollback snapshot (compose file unreadable or database error). Update aborted; the app was not changed.";
    writeNotification("warning", `Update of ${app.name} did not start`, error, appId);
    return { success: false, error, outcome: "failed" };
  }
  ctx.setDetail({
    snapshotId,
    baselineServices: requiredServices,
    baselineHttp,
    imageRollbackAvailable,
    irreversibleNote: IRREVERSIBLE_NOTE,
    ...(semanticProbe ? { semanticBaseline } : {}),
    ...(runOpts.force ? { force: true } : {}),
  });

  // The override compose froze the image refs at install — move them to the
  // catalog's current refs (restored from the snapshot on any failure).
  let imageRefChanges: { service: string; from: string; to: string }[] = [];
  try {
    imageRefChanges = syncOverrideImageRefs(effectiveCompose, app.composePath);
    if (imageRefChanges.length > 0) ctx.setDetail({ imageRefChanges });
  } catch (err: unknown) {
    log.warn(`Could not sync image refs from the catalog compose for ${appId}`, err);
  }

  const restoreSnapshotCompose = () => {
    if (imageRefChanges.length === 0) return;
    const snap = db.select().from(schema.updateSnapshots).where(eq(schema.updateSnapshots.id, snapshotId)).get();
    if (snap?.previousCompose) atomicWriteFileSync(effectiveCompose, snap.previousCompose, "utf-8");
  };

  // ── 2. Pull new images while the app keeps running ─────────────────────
  ctx.step("pull", 10, "Downloading new images (app keeps running)");
  db.update(schema.installedApps)
    .set({ status: "updating", updatedAt: new Date().toISOString() })
    .where(eq(schema.installedApps.appId, appId))
    .run();

  try {
    await run(`docker compose -f "${effectiveCompose}" pull`, {
      cwd: dirname(effectiveCompose),
      env,
      timeout: 600_000,
    });
  } catch (err: any) {
    const errorDetail = String(err?.stderr || err?.message || err);
    try {
      restoreSnapshotCompose();
    } catch (restoreErr: unknown) {
      log.warn(`Could not restore the compose file of ${appId} after a failed pull`, restoreErr);
    }
    db.update(schema.installedApps)
      .set({ status: previousStatus, updatedAt: new Date().toISOString() })
      .where(eq(schema.installedApps.appId, appId))
      .run();
    // The update never touched the app — drop the snapshot so a later
    // "rollback" does not target a state that was never left.
    db.delete(schema.updateSnapshots).where(eq(schema.updateSnapshots.id, snapshotId)).run();
    ctx.setDetail({ snapshotId: null, appTouched: false });
    writeNotification(
      "warning",
      `Update of ${app.name} failed`,
      `Could not download the new images, so nothing was changed and the app kept running. ${errorDetail.slice(0, 500)}`,
      appId,
    );
    return { success: false, error: `Image pull failed; app left unchanged: ${errorDetail}`, outcome: "failed" };
  }
  ctx.step("pull", 40, "New images downloaded");

  // ── 3. Pre-update backup ────────────────────────────────────────────────
  // Taken through the backup engine while holding this operation: the engine
  // uses its own per-app lock and Docker directly (never a lifecycle entry
  // point), so it cannot conflict with or deadlock on this update.
  let backup: PreUpdateBackupResult;
  if (isPreUpdateBackupEnabled(appId)) {
    ctx.step("backup", 45, "Backing up app data before switching versions");
    backup = await takePreUpdateBackup(appId);
  } else {
    backup = { attempted: false, success: false, reason: "Not enabled in the app's update policy (preBackup)" };
  }
  ctx.setDetail({ backup });
  if (backup.attempted && !backup.success && !backup.skipped) {
    const backupError = backup.error ?? "unknown error";
    if (!runOpts.force) {
      // Nothing was recreated yet (the new images were only downloaded), so
      // aborting here costs no downtime.
      try {
        restoreSnapshotCompose();
      } catch (restoreErr: unknown) {
        log.warn(`Could not restore the compose file of ${appId} after a failed pre-update backup`, restoreErr);
      }
      db.update(schema.installedApps)
        .set({ status: previousStatus, updatedAt: new Date().toISOString() })
        .where(eq(schema.installedApps.appId, appId))
        .run();
      db.delete(schema.updateSnapshots).where(eq(schema.updateSnapshots.id, snapshotId)).run();
      ctx.setDetail({ snapshotId: null, appTouched: false, outcome: "failed", backupFailed: true });
      const error =
        `Pre-update backup failed: ${backupError}. The update was aborted before any container was recreated — ` +
        `${app.name} keeps running version ${installed.version}. Fix the backup, or update with force to proceed without one.`;
      writeNotification("warning", `Update of ${app.name} aborted`, error, appId);
      return { success: false, error, outcome: "failed", backupFailed: true };
    }
    ctx.setDetail({ backupForced: true });
    log.warn(`Pre-update backup of ${appId} failed (${backupError}); proceeding because the update was forced`);
  }
  if (backup.success && backup.backupFile) {
    try {
      db.update(schema.updateSnapshots)
        .set({ backupPath: backup.backupFile })
        .where(eq(schema.updateSnapshots.id, snapshotId))
        .run();
    } catch {
      // Detail on the operation already records it
    }
  }

  // ── 4. Recreate on the new images ───────────────────────────────────────
  // From here until the operation ends, container stops/recreates are intended.
  runOpts.beginMaintenance(baselineImages.flatMap((i) => [i.containerId, i.containerName]));
  ctx.step("recreate", 55, "Recreating containers on the new version");
  // The snapshot's createdAt marks when the new version went live: the
  // post-update crash-loop detector keys off it, so pull/backup time must not count.
  try {
    db.update(schema.updateSnapshots)
      .set({ createdAt: new Date().toISOString() })
      .where(eq(schema.updateSnapshots.id, snapshotId))
      .run();
  } catch {
    // Advisory
  }
  const overridePath = join(APP_DATA_DIR, appId, "docker-compose.yml");
  if (effectiveCompose === overridePath) {
    // Re-inject the talome network in place (a changed catalog compose may have lost it).
    try {
      await ensureTalomeNetwork();
      effectiveCompose = await injectNetworkIntoCompose(effectiveCompose, appId);
    } catch (err: unknown) {
      log.warn(`talome network re-injection during update for ${appId}`, err);
    }
  }

  let failureReason: string | null = null;
  let verification: VerifyResult | null = null;
  try {
    await run(`docker compose -f "${effectiveCompose}" up -d`, {
      cwd: dirname(effectiveCompose),
      env,
      timeout: 180_000,
    });
  } catch (err: any) {
    const errorDetail = String(err?.stderr || err?.message || err);
    recordInstallError(appId, `docker compose up -d (update)`, err, effectiveCompose, env);
    failureReason = `Recreating containers failed: ${errorDetail.slice(0, 500)}`;
  }

  // ── 5. Verify ───────────────────────────────────────────────────────────
  const verifyOptions: VerifyOptions = {
    composePath: effectiveCompose,
    requiredServices,
    webPort: app.webPort ?? null,
    requireHttp: baselineHttp?.ok === true,
    timeoutMs: UPDATE_VERIFY_TIMEOUT_MS,
    maxTimeoutMs: UPDATE_VERIFY_MAX_MS,
  };
  if (!failureReason) {
    ctx.step("verify", 70, "Verifying the new version is healthy");
    verification = await verifyAppHealth(appId, verifyOptions);
    ctx.setDetail({ verification: summarizeVerification(verification) });
    // Only a hard failure (exited, unhealthy, restart loop) justifies rolling
    // back. A slow start may be a data migration in progress — recreating the
    // old version on top of it could corrupt the app's data.
    if (verification.verdict === "unhealthy") failureReason = `Health verification failed: ${verification.reason}`;
  }

  let imagesChanged = true;
  if (!failureReason) {
    let afterImages: ServiceImageState[] = [];
    try {
      afterImages = await captureServiceImages(appId, effectiveCompose);
    } catch {
      // Unknown — treated as changed below
    }
    const before = new Map(baselineImages.map((i) => [i.service, i.imageId]));
    imagesChanged = baselineImages.length === 0 || afterImages.length === 0 ||
      afterImages.some((i) => before.get(i.service) !== i.imageId);
  }

  // ── 5b. Semantic verification (apps with outcome probes) ────────────────
  // Only once the new version passed container/HTTP verification. A regression
  // from "verified" to "failed" is treated like a failed update.
  let semantic: SemanticVerification | null = null;
  if (!failureReason && imagesChanged && verification?.healthy && semanticProbe) {
    ctx.step("semantic_verify", 75, "Checking the app still does its job (outcome probes)");
    semantic = await runSemanticVerification(appId, { baseline: semanticBaseline });
    ctx.setDetail({ semanticVerification: semantic });
    if (semantic.regression) {
      if (imageRollbackAvailable) {
        failureReason = `Outcome verification regressed after the update (verified before, failed now): ${semantic.summary ?? "checks failed"}`;
      } else {
        writeNotification(
          "critical",
          `${app.name} updated, outcome checks now failing`,
          `${app.name} passed its outcome checks before the update and fails them now (${semantic.summary ?? "checks failed"}). ` +
          `It could not be rolled back automatically because no previous images were recorded.`,
          appId,
        );
      }
    }
  }

  const backupLine = backup.success && backup.backupFile
    ? ` A pre-update backup is available at ${backup.backupFile}${backup.backupId ? ` (backup ${backup.backupId})` : ""}.`
    : " No pre-update backup was taken.";

  if (!failureReason) {
    ctx.step("finalize", 95, "Recording new version");
    const containers = await discoverContainers(appId);
    ctx.setDetail({ imagesChanged });

    if (!imagesChanged) {
      // Same bytes as before: do not claim an update or bump the version.
      db.delete(schema.updateSnapshots).where(eq(schema.updateSnapshots.id, snapshotId)).run();
      db.update(schema.installedApps)
        .set({ status: "running", containerIds: JSON.stringify(containers), updatedAt: new Date().toISOString() })
        .where(eq(schema.installedApps.appId, appId))
        .run();
      ctx.setDetail({ outcome: "no_change", snapshotId: null });
      const note = app.version !== installed.version
        ? `No new image was published for ${app.name} ${app.version}, so it still runs version ${installed.version}.`
        : `${app.name} is already on the latest image.`;
      writeNotification("info", `${app.name} unchanged`, note, appId);
      return { success: true, verified: verification?.healthy ?? false, outcome: "no_change", warning: note };
    }

    db.update(schema.updateSnapshots)
      .set({ newVersion: app.version })
      .where(eq(schema.updateSnapshots.id, snapshotId))
      .run();

    db.update(schema.installedApps)
      .set({
        status: "running",
        containerIds: JSON.stringify(containers),
        version: app.version,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    pinImageDigest(appId, effectiveCompose);

    const semanticResult = semantic?.ran ? { semanticVerification: summarizeSemantic(semantic) } : {};
    const backupResult = backup.success && backup.backupId ? { preUpdateBackupId: backup.backupId } : {};

    if (verification && !verification.healthy) {
      // Inconclusive: still starting / not answering yet. Not rolled back.
      const warning =
        `Updated to version ${app.version}, but it was not verified healthy yet (${verification.reason}). ` +
        `It was not rolled back automatically because it may still be starting or migrating data. ` +
        `If it does not recover, roll back the update.${backupLine}`;
      ctx.setDetail({ outcome: "unverified" });
      writeNotification("warning", `${app.name} updated, not yet verified`, warning, appId);
      return { success: true, verified: false, outcome: "unverified", warning, ...backupResult };
    }

    ctx.setDetail({ outcome: "updated" });
    if (semantic?.ran && semantic.status !== "verified" && !semantic.regression) {
      // Recorded + notified, never rolled back: degraded/unknown results (or a
      // failure without a verified baseline) are not attributable to the update.
      const status = semantic.status ?? "unknown";
      const summary = semantic.summary ?? "no details";
      const warning = status === "unknown"
        ? `Updated to version ${app.version} and healthy, but its outcome checks could not confirm it works: ${summary}`
        : `Updated to version ${app.version} and healthy, but its outcome checks report ${status}: ${summary}` +
          (status === "failed" ? ` (they were not passing before the update either).` : "");
      writeNotification(status === "unknown" ? "info" : "warning", `${app.name} updated, outcome checks ${status}`, warning, appId);
      return { success: true, verified: true, outcome: "updated", warning, ...semanticResult, ...backupResult };
    }
    const outcomeNote = semantic?.ran && semantic.status === "verified" ? "; outcome checks pass" : "";
    writeNotification("info", `${app.name} updated`, `Updated to version ${app.version} and verified healthy${outcomeNote}`, appId);
    return { success: true, verified: true, outcome: "updated", ...semanticResult, ...backupResult };
  }

  // ── 6. Automatic rollback ───────────────────────────────────────────────
  if (!imageRollbackAvailable) {
    // Without the previous images, "rolling back" would recreate the new
    // images under the old compose and misreport it as restored.
    const error = `${failureReason}. Automatic rollback is unavailable: the previous images were not recorded (the app had no containers before the update).`;
    ctx.setDetail({ outcome: "failed", rollback: { attempted: false, reason: "no image baseline" } });
    db.update(schema.installedApps)
      .set({ status: "error", containerIds: JSON.stringify(await discoverContainers(appId)), updatedAt: new Date().toISOString() })
      .where(eq(schema.installedApps.appId, appId))
      .run();
    ctx.markFailed(error);
    writeNotification("critical", `Update of ${app.name} failed`, `${error}${backupLine} Manual attention is needed.`, appId);
    return { success: false, error, verified: false, rolledBack: false, outcome: "failed" };
  }

  ctx.step("rollback", 80, `${failureReason} — restoring version ${installed.version}`);
  log.warn(`Update of ${appId} failed (${failureReason}); rolling back`);

  const snapshot = db
    .select()
    .from(schema.updateSnapshots)
    .where(eq(schema.updateSnapshots.id, snapshotId))
    .get();

  let rollbackError: string | null = null;
  let rollbackVerified = false;
  let imagesFullyRestored = false;
  if (!snapshot) {
    rollbackError = "Rollback snapshot disappeared";
  } else {
    try {
      const { imagesRestored } = await restoreFromSnapshot(appId, snapshot, effectiveCompose, env);
      const unrestored = describeUnrestoredImages(baselineImages, imagesRestored);
      imagesFullyRestored = unrestored === "";
      ctx.setDetail({ rollback: { imagesRestored } });
      ctx.step("rollback_verify", 90, "Verifying the restored version");
      const reverify = await verifyAppHealth(appId, verifyOptions);
      rollbackVerified = reverify.healthy;
      ctx.setDetail({ rollback: { imagesRestored, verification: summarizeVerification(reverify) } });
      if (!imagesFullyRestored) {
        rollbackError = `The previous compose file was restored, but not the previous images: ${unrestored}. The app may still be running the newer images`;
      } else if (!reverify.healthy) {
        rollbackError = `Restored version is not healthy either: ${reverify.reason}`;
      }
    } catch (err: any) {
      rollbackError = `Rollback failed: ${String(err?.stderr || err?.message || err).slice(0, 500)}`;
    }
  }

  const rolledBack = rollbackVerified && imagesFullyRestored && snapshot !== undefined;
  const containers = await discoverContainers(appId);
  db.update(schema.installedApps)
    .set({
      status: rollbackVerified ? "running" : "error",
      containerIds: JSON.stringify(containers),
      // Only a verified, complete rollback may claim the previous version is running.
      ...(rolledBack ? { version: installed.version } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.installedApps.appId, appId))
    .run();

  const dataRestore = backup.success && backup.backupId
    ? { preUpdateBackupId: backup.backupId, dataRestoreHint: dataRestoreHint(backup.backupId) }
    : {};
  const semanticResult = semantic?.ran ? { semanticVerification: summarizeSemantic(semantic) } : {};

  if (rolledBack && snapshot) {
    db.update(schema.updateSnapshots)
      .set({ rolledBack: true, rollbackReason: failureReason })
      .where(eq(schema.updateSnapshots.id, snapshot.id))
      .run();
    ctx.setDetail({ outcome: "rolled_back", ...(backup.success && backup.backupId ? { dataRestore: { backupId: backup.backupId, available: true } } : {}) });
    if (semantic?.regression) {
      // Record whether the restored version passes its outcome checks again.
      ctx.step("semantic_verify_rollback", 95, "Checking the restored version with outcome probes");
      const afterRollback = await runSemanticVerification(appId, { baseline: null });
      ctx.setDetail({ semanticAfterRollback: afterRollback });
    }
    ctx.markRolledBack(failureReason);
    writeNotification(
      "warning",
      `Update of ${app.name} rolled back`,
      `${failureReason}. Version ${installed.version} was restored and is running. ${IRREVERSIBLE_NOTE}${backupLine}`,
      appId,
    );
    return {
      success: false,
      error: `${failureReason}. Rolled back to version ${installed.version}.`,
      verified: false,
      rolledBack: true,
      outcome: "rolled_back",
      ...dataRestore,
      ...semanticResult,
    };
  }

  const error = `${failureReason}. ${rollbackError ?? "Rollback did not complete"}`;
  ctx.setDetail({ outcome: "failed" });
  ctx.markFailed(error);
  writeNotification(
    "critical",
    `Update of ${app.name} failed and could not be rolled back`,
    `${error}.${backupLine} Manual attention is needed.`,
    appId,
  );
  return { success: false, error, verified: false, rolledBack: false, outcome: "failed", ...dataRestore, ...semanticResult };
}

// ── Status refresh ────────────────────────────────────────────────────────

export async function refreshAppStatuses(): Promise<void> {
  const installed = db.select().from(schema.installedApps).all();
  if (installed.length === 0) return;

  let containers: Awaited<ReturnType<typeof listContainers>>;
  try {
    containers = await listContainers();
  } catch {
    return;
  }

  const containerMap = new Map(containers.map((c) => [c.id, c]));

  for (const app of installed) {
    if (app.status === "installing" || app.status === "updating") continue;

    const ids = JSON.parse(app.containerIds) as string[];
    if (ids.length === 0) continue;

    const allRunning = ids.every((id) => containerMap.get(id)?.status === "running");
    const anyRunning = ids.some((id) => containerMap.get(id)?.status === "running");

    let newStatus: InstalledAppStatus;
    if (allRunning) {
      newStatus = "running";
    } else if (anyRunning) {
      newStatus = "running";
    } else {
      newStatus = "stopped";
    }

    if (newStatus !== app.status) {
      db.update(schema.installedApps)
        .set({ status: newStatus, updatedAt: new Date().toISOString() })
        .where(eq(schema.installedApps.appId, app.appId))
        .run();
    }
  }
}

export function getLastInstallError(appId: string) {
  return db
    .select()
    .from(schema.installErrors)
    .where(eq(schema.installErrors.appId, appId))
    .orderBy(desc(schema.installErrors.id))
    .limit(1)
    .get() ?? null;
}

// ── Legacy network migration ──────────────────────────────────────────────

export async function migrateLegacyNetworks(): Promise<void> {
  try {
    await ensureTalomeNetwork();
  } catch (err: unknown) {
    log.error("Failed to ensure talome network", err);
    return;
  }

  const installed = db.select().from(schema.installedApps).all();
  if (installed.length === 0) return;

  let migrated = 0;

  for (const app of installed) {
    const catalog = getCatalogApp(app.appId, app.storeSourceId);
    if (!catalog) continue;

    const composePath = app.overrideComposePath ?? catalog.composePath;
    if (!existsSync(composePath)) continue;

    try {
      const raw = readFileSync(composePath, "utf-8");
      const doc = yaml.load(raw) as Record<string, unknown>;
      if (!doc?.services) continue;

      const networks = doc.networks as Record<string, unknown> | undefined;
      if (networks?.talome) continue;

      injectTalomeNetwork(doc);
      atomicWriteFileSync(composePath, yaml.dump(doc, { lineWidth: -1 }), "utf-8");

      if (!app.overrideComposePath) {
        const overrideDir = join(APP_DATA_DIR, app.appId);
        mkdirSync(overrideDir, { recursive: true });
        const overridePath = join(overrideDir, "docker-compose.yml");
        atomicWriteFileSync(overridePath, yaml.dump(doc, { lineWidth: -1 }), "utf-8");
        db.update(schema.installedApps)
          .set({ overrideComposePath: overridePath, updatedAt: new Date().toISOString() })
          .where(eq(schema.installedApps.appId, app.appId))
          .run();
      }

      migrated++;
    } catch (err: unknown) {
      log.warn(`migrate-networks ${app.appId}`, err);
    }
  }

  // Connect running containers that aren't on the talome network yet
  try {
    const containers = await listContainers();
    for (const container of containers) {
      if (container.status !== "running") continue;
      try {
        await connectContainerToNetwork("talome", container.name);
      } catch {
        // Already connected or other non-fatal error
      }
    }
  } catch (err: unknown) {
    log.warn("Failed to connect running containers", err);
  }

  if (migrated > 0) {
    log.info(`Injected talome network into ${migrated} app(s)`);
  }
}
