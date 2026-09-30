import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
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
import { writeAuditEntry } from "../db/audit.js";
import { getExecutionContext } from "../ai/actor-context.js";
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
  listProjectContainers,
  probeDockerCompose,
  isComposeMissingError,
  COMPOSE_MISSING_MESSAGE,
} from "./compose-exec.js";
import {
  describeKeptConfig,
  isConfigSyncSource,
  mergeCatalogConfig,
  readCatalogBase,
  recordCatalogBase,
  restorePreviousCatalogBase,
  type ConfigChange,
  type ConfigConflict,
} from "./catalog-sync.js";
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
import { isPreUpdateBackupEnabled, takePreUpdateBackup, findPreUpdateBackupId, backupTriggerForActor, type PreUpdateBackupResult } from "../ops/pre-update-backup.js";
import { getSemanticBaseline, hasSemanticProbe, runSemanticVerification, type SemanticVerification } from "../ops/semantic-verify.js";
import { holdAppMaintenance } from "../backup/state.js";
import { reconcileUmbrelDependencies, applyUmbrelV2Install, getSavedDependencySelections } from "./umbrel-v2-install.js";
import {
  clearImagePins,
  composeServiceImages,
  decideImageRef,
  describeKeptImages,
  readImageRefState,
  recordManagedImages,
  resetImageRefState,
  type ImageRefDecision,
  type KeptImageRef,
} from "../ops/image-refs.js";

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
  /**
   * Also move image refs the user pinned or customised (upgrade_app_image, a
   * hand-edited tag or a fork image) to the catalog's. Without it those refs
   * are kept and reported in `imagesKept`.
   */
  useCatalogImages?: boolean;
}

export interface OperationResultMeta {
  /** Journal id of the operation (GET /api/operations/:id) */
  operationId?: string;
  /** True when rejected because another operation on the app is running */
  conflict?: boolean;
}

/**
 * Refuses a lifecycle call that cannot apply (app not installed / already
 * installed…) BEFORE a journal row is written, so a no-op call does not leave
 * a failed operation in the app's history. Skipped while an operation is live
 * on the app: that call must still get the conflict (409 + running op id).
 */
type OperationPrecheck = () => string | null;

const requireInstalled: (appId: string) => OperationPrecheck = (appId) => () =>
  getInstalledApp(appId) ? null : "App is not installed";

async function runAppOperation<T extends { success: boolean; error?: string }>(
  appId: string,
  kind: OperationKind,
  opts: LifecycleOptions | undefined,
  fn: (ctx: OperationContext) => Promise<T>,
  precheck?: OperationPrecheck,
): Promise<T & OperationResultMeta> {
  if (precheck && !hasLiveOperation(appId)) {
    const refusal = precheck();
    if (refusal) return { success: false, error: refusal } as T & OperationResultMeta;
  }
  const actor = opts?.actor ?? currentActor();
  let operationId: string | undefined;
  try {
    const result = await withAppOperation(appId, kind, actor, (ctx) => {
      operationId = ctx.id;
      // The compose lock still serializes against non-journaled writers (e.g. env edits).
      return withAppLock(appId, () => fn(ctx));
    });
    auditLifecycleOperation(appId, kind, actor, operationId, result);
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
    if (operationId) {
      auditLifecycleOperation(appId, kind, actor, operationId, { success: false, error: err instanceof Error ? err.message : String(err) });
    }
    throw err;
  }
}

// ── Audit of lifecycle operations ─────────────────────────────────────────
// A tool call (chat, MCP, automation, agent loop) is audited by executeTool()
// with its actor. A lifecycle operation started anywhere else — the REST API
// (dashboard buttons), schedulers, dependency auto-starts — writes its own
// attributed row when it finishes.

const LIFECYCLE_AUDIT: Partial<Record<OperationKind, { done: string; failed: string; tier: "modify" | "destructive" }>> = {
  install: { done: "Installed app", failed: "Install failed", tier: "modify" },
  uninstall: { done: "Uninstalled app", failed: "Uninstall failed", tier: "destructive" },
  start: { done: "Started app", failed: "Start failed", tier: "modify" },
  stop: { done: "Stopped app", failed: "Stop failed", tier: "modify" },
  restart: { done: "Restarted app", failed: "Restart failed", tier: "modify" },
  update: { done: "Updated app", failed: "Update failed", tier: "modify" },
  rollback: { done: "Rolled back app update", failed: "Rollback failed", tier: "destructive" },
};

/** Split a journal actor string (`<kind>:<id> (<label>)`, `user:<id>`, `system`) into audit columns. */
export function auditActorFromOperationActor(actor: string): { actorKind: string; actorId?: string; actorLabel?: string; source: string } {
  const m = /^([A-Za-z_]+)(?::(\S+?))?(?:\s+\((.*)\))?$/.exec(actor.trim());
  const actorKind = m?.[1] ?? "system";
  const actorId = m?.[2];
  let actorLabel = m?.[3];
  if (actorKind === "user" && actorId && !actorLabel) {
    try {
      actorLabel = db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.id, actorId)).get()?.username;
    } catch {
      // Label is advisory
    }
  }
  return {
    actorKind,
    ...(actorId ? { actorId } : {}),
    ...(actorLabel ? { actorLabel } : {}),
    source: actorKind === "user" ? "api" : "system",
  };
}

function auditLifecycleOperation(
  appId: string,
  kind: OperationKind,
  actor: string,
  operationId: string | undefined,
  result: { success: boolean; error?: string; outcome?: unknown },
): void {
  const labels = LIFECYCLE_AUDIT[kind];
  if (!labels) return;
  // executeTool() audits tool calls itself (with the tool name and arguments).
  if (getExecutionContext()) return;
  try {
    const outcomeNote = typeof result.outcome === "string" ? ` [${result.outcome}]` : "";
    const details = result.success
      ? `${appId}${outcomeNote}${operationId ? ` (operation ${operationId})` : ""}`
      : `${appId}${outcomeNote}: ${(result.error ?? "failed").slice(0, 300)}${operationId ? ` (operation ${operationId})` : ""}`;
    writeAuditEntry(result.success ? labels.done : labels.failed, labels.tier, details, true, {
      ...auditActorFromOperationActor(actor),
      outcome: result.success ? "success" : "error",
    });
  } catch (err) {
    log.warn(`Could not audit ${kind} of ${appId}`, err);
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
  }, () => {
    if (!getCatalogApp(appId, storeSourceId)) return "App not found in catalog";
    if (getInstalledApp(appId)) return "App is already installed";
    return null;
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
      // A missing compose plugin is not a problem with the app's compose file.
      const compose = await probeDockerCompose();
      if (!compose.available || isComposeMissingError(validation.error ?? "")) {
        return { success: false, error: `${COMPOSE_MISSING_MESSAGE}${compose.error ? ` (${compose.error.slice(0, 200)})` : ""}` };
      }
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

    const containers = await discoverContainers(appId, composePath);

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
    // Every image ref in this compose is Talome's: updates may move them (ops/image-refs.ts).
    resetImageRefState(appId, composeServiceImages(composePath));
    // The catalog compose this override was derived from: updates merge catalog changes against it.
    if (effectiveCompose && effectiveCompose !== app.composePath) {
      try {
        recordCatalogBase(effectiveCompose, readFileSync(app.composePath, "utf-8"));
      } catch (err: unknown) {
        log.warn(`Could not record the catalog base of ${appId}`, err);
      }
    }

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

export function uninstallApp(appId: string, opts?: LifecycleOptions): Promise<{ success: boolean; error?: string; warning?: string } & OperationResultMeta> {
  return runAppOperation(appId, "uninstall", opts, (ctx) => uninstallAppInner(appId, ctx), requireInstalled(appId));
}

// Docker object names interpolated into shell commands: ids and names only.
const DOCKER_OBJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/**
 * Anonymous volumes mounted by the given containers — the ones Docker created
 * for an image's VOLUME or a bare `- /path` mount. Named volumes (declared in
 * the compose file, external, or created by hand) are never included: they
 * are user data. Best effort: [] when Docker cannot tell.
 */
async function collectAnonymousVolumes(containerIds: string[]): Promise<string[]> {
  const ids = containerIds.filter((id) => DOCKER_OBJECT_NAME.test(id));
  if (ids.length === 0) return [];
  try {
    const { stdout } = await run(`docker inspect --format '{{json .Mounts}}' ${ids.join(" ")}`, { timeout: 30_000 });
    const candidates = new Set<string>();
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const mounts = JSON.parse(line) as Array<{ Type?: string; Name?: string }> | null;
      for (const m of mounts ?? []) {
        if (m.Type === "volume" && typeof m.Name === "string" && DOCKER_OBJECT_NAME.test(m.Name)) candidates.add(m.Name);
      }
    }
    if (candidates.size === 0) return [];
    const { stdout: volumes } = await run(
      `docker volume inspect --format '{{.Name}} {{json .Labels}}' ${[...candidates].join(" ")}`,
      { timeout: 30_000 },
    );
    const anonymous: string[] = [];
    for (const line of volumes.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp <= 0) continue;
      const name = line.slice(0, sp).trim();
      const labels = (JSON.parse(line.slice(sp + 1)) ?? {}) as Record<string, string>;
      if (!candidates.has(name)) continue;
      // Compose-declared volumes carry com.docker.compose.volume: user data, never anonymous.
      if ("com.docker.compose.volume" in labels) continue;
      const markedAnonymous = "com.docker.volume.anonymous" in labels;
      // Older engines do not mark them: a 64-hex name with no labels at all.
      const legacyAnonymous = /^[0-9a-f]{64}$/.test(name) && Object.keys(labels).length === 0;
      if (markedAnonymous || legacyAnonymous) anonymous.push(name);
    }
    return anonymous;
  } catch (err: unknown) {
    log.warn(`Could not read the volumes of containers ${ids.join(", ")}`, err);
    return [];
  }
}

async function uninstallAppInner(appId: string, ctx: OperationContext): Promise<{ success: boolean; error?: string; warning?: string }> {
  const installed = getInstalledApp(appId);
  if (!installed) return { success: false, error: "App is not installed" };

  const app = getCatalogApp(appId, installed.storeSourceId);
  const effectiveCompose = installed.overrideComposePath ?? app?.composePath ?? null;
  const composeUsable = effectiveCompose !== null && existsSync(effectiveCompose);

  // Execute preUninstall hook (best-effort)
  if (app) {
    ctx.step("pre_uninstall_hook", 10, "Running pre-uninstall hook");
    const envOverridesUninst = JSON.parse(installed.envConfig) as Record<string, string>;
    const envUninst = buildEnv(appId, envOverridesUninst);
    await executeHook("preUninstall", appId, app.hooks, { composePath: app.composePath, env: envUninst }).catch((err) => log.warn(`preUninstall hook failed for ${appId}`, err));
  }

  ctx.step("remove_containers", 30, "Stopping and removing containers");
  // The project's containers and their anonymous volumes, recorded BEFORE they
  // are removed (afterwards nothing links the volumes to the app any more).
  let before: Awaited<ReturnType<typeof listProjectContainers>> = [];
  try {
    before = await listProjectContainers(appId, effectiveCompose);
  } catch (err: unknown) {
    // Without a container listing, removal cannot be verified: refuse, keep tracking the app.
    const reason = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Could not list ${appId}'s containers from Docker (${reason}). Nothing was removed; the app is still installed.` };
  }
  const anonymousVolumes = await collectAnonymousVolumes(before.map((c) => c.id));

  let downError: string | null = null;
  if (composeUsable) {
    try {
      // Never `down -v`: that also deletes the compose file's named volumes (user data).
      await run(`docker compose -f "${effectiveCompose}" down`, {
        cwd: dirname(effectiveCompose!),
        timeout: 60_000,
      });
    } catch (err: any) {
      downError = String(err?.stderr || err?.message || err).trim();
    }
  } else {
    downError = effectiveCompose ? `compose file ${effectiveCompose} not found` : "no compose file recorded";
  }

  // Whatever `down` left behind (compose missing, a broken compose file, a
  // timeout): remove the project's containers directly, by compose label.
  let remaining: Awaited<ReturnType<typeof listProjectContainers>>;
  try {
    remaining = await listProjectContainers(appId, effectiveCompose);
    if (remaining.length > 0) {
      if (downError) log.warn(`compose down for ${appId} failed (${downError}); removing its containers by label`);
      const ids = remaining.map((c) => c.id).filter((id) => DOCKER_OBJECT_NAME.test(id));
      if (ids.length > 0) {
        // `rm -f` without -v: volumes are handled below (anonymous ones only).
        await run(`docker rm -f ${ids.join(" ")}`, { timeout: 60_000 }).catch((err: unknown) =>
          log.warn(`Failed to remove the containers of ${appId}`, err),
        );
      }
      remaining = await listProjectContainers(appId, effectiveCompose);
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    const error = `Could not confirm that ${appId}'s containers were removed (${reason}). The app is still tracked; try again.`;
    ctx.setDetail({ downError });
    return { success: false, error };
  }

  if (remaining.length > 0) {
    // Keep the installed_apps row: forgetting an app whose containers still
    // run would leave them untracked (and invisible to the store).
    const names = remaining.map((c) => c.name).join(", ");
    const error = `Could not remove ${appId}: container(s) ${names} still exist` +
      `${downError ? ` (docker compose down failed: ${downError.slice(0, 300)})` : ""}. The app is still installed.`;
    ctx.setDetail({ downError, remainingContainers: remaining.map((c) => ({ id: c.id, name: c.name })) });
    db.update(schema.installedApps)
      .set({ containerIds: JSON.stringify(remaining.map((c) => c.id)), updatedAt: new Date().toISOString() })
      .where(eq(schema.installedApps.appId, appId))
      .run();
    return { success: false, error };
  }

  // Anonymous volumes belonged to the removed containers only. Named volumes
  // and bind-mounted data (app-data) are kept.
  if (anonymousVolumes.length > 0) {
    ctx.step("remove_anonymous_volumes", 60, `Removing ${anonymousVolumes.length} anonymous volume(s)`);
    const removed: string[] = [];
    const kept: string[] = [];
    for (const volume of anonymousVolumes) {
      try {
        await run(`docker volume rm ${volume}`, { timeout: 30_000 });
        removed.push(volume);
      } catch {
        kept.push(volume); // e.g. still used by another container
      }
    }
    ctx.setDetail({ anonymousVolumesRemoved: removed, ...(kept.length > 0 ? { anonymousVolumesKept: kept } : {}) });
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

  return { success: true, ...(downError ? { warning: `docker compose down failed (${downError.slice(0, 200)}); the containers were removed directly.` } : {}) };
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
  return runAppOperation(appId, action, opts, (ctx) => composeActionInner(appId, action, ctx), requireInstalled(appId));
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
      // Check that dependencies are installed and running before starting —
      // resolved the way the install resolved them: an Umbrel dependency may
      // be met by an app that `implements` it or by the provider the user
      // chose at install, and that provider is the app to start.
      if (installed.storeSourceId) {
        const depCheck = reconcileUmbrelDependencies(
          app,
          resolveDependencies(appId, installed.storeSourceId),
          getSavedDependencySelections(appId, installed.storeSourceId),
        );
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

      // `up -d` alone: it starts the project's stopped containers as they are
      // (and recreates only those whose configuration changed, carrying their
      // anonymous volumes over). Never `down` first — removing the containers
      // detaches their anonymous volumes, and `up` would then start the app on
      // new, empty ones (an image VOLUME such as a database's data dir).
      ctx.step("start_containers", 40, "Starting containers");
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
    const containerIds = action === "stop"
      ? JSON.parse(installed.containerIds) as string[]
      : await discoverContainers(appId, effectiveCompose);

    if (action !== "stop" && containerIds.length === 0) {
      throw new Error(`${app.name} started but its recreated container could not be discovered`);
    }

    db.update(schema.installedApps)
      .set({
        status: newStatus,
        containerIds: JSON.stringify(containerIds),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    // Execute postStart hook after successful start/restart
    if (action === "start" || action === "restart") {
      void executeHook("postStart", appId, app.hooks, { composePath: effectiveCompose, env });
    }

    return { success: true };
  } catch (err: any) {
    let errorDetail = err?.stderr || err.message;
    if (isComposeMissingError(String(errorDetail))) errorDetail = COMPOSE_MISSING_MESSAGE;
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
  /** Image refs the user pinned or customised that the update left alone (see useCatalogImages) */
  imagesKept?: KeptImageRef[];
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

/**
 * Carry a configuration edit (env, ports, mounts, limits) made to an installed
 * app's compose into the compose files its rollback snapshots would restore,
 * so rolling an update back restores the previous images without silently
 * undoing configuration changed after the update. `edit` mutates a parsed
 * compose and returns false when it does not apply to that version (e.g. the
 * service does not exist there) — such snapshots are left as they are and
 * counted in `skipped` (rolling back to them would revert the edit). Call it
 * while holding the app's operation. Never throws.
 */
export function applyComposeEditToUpdateSnapshots(
  appId: string,
  edit: (compose: Record<string, unknown>) => boolean,
): { refreshed: number; skipped: number } {
  const counts = { refreshed: 0, skipped: 0 };
  try {
    const snapshots = db
      .select({ id: schema.updateSnapshots.id, previousCompose: schema.updateSnapshots.previousCompose })
      .from(schema.updateSnapshots)
      .where(and(eq(schema.updateSnapshots.appId, appId), eq(schema.updateSnapshots.rolledBack, false)))
      .all();
    for (const snap of snapshots) {
      if (!snap.previousCompose) continue;
      try {
        const doc = yaml.load(snap.previousCompose);
        if (!doc || typeof doc !== "object" || Array.isArray(doc) || !edit(doc as Record<string, unknown>)) {
          counts.skipped++;
          continue;
        }
        db.update(schema.updateSnapshots)
          .set({ previousCompose: yaml.dump(doc, { lineWidth: -1 }) })
          .where(eq(schema.updateSnapshots.id, snap.id))
          .run();
        counts.refreshed++;
      } catch (err) {
        log.warn(`Could not carry a compose edit into update snapshot #${snap.id} of ${appId}`, err);
        counts.skipped++;
      }
    }
  } catch (err) {
    log.warn(`Could not read the update snapshots of ${appId}`, err);
  }
  return counts;
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
 *
 * `decide` may keep a service's ref (a user pin or custom image, see
 * ops/image-refs.ts); kept services are appended to `kept`.
 */
export function syncOverrideImageRefs(
  overridePath: string,
  catalogPath: string,
  opts: { decide?: (service: string, from: string, to: string) => ImageRefDecision; kept?: KeptImageRef[] } = {},
): { service: string; from: string; to: string }[] {
  if (overridePath === catalogPath || !existsSync(overridePath) || !existsSync(catalogPath)) return [];
  const override = yaml.load(readFileSync(overridePath, "utf-8")) as OverrideDoc | null;
  const catalog = yaml.load(readFileSync(catalogPath, "utf-8")) as OverrideDoc | null;
  if (!override) return [];
  const changes = planOverrideImageRefs(override, catalog, opts);
  if (changes.length > 0) {
    atomicWriteFileSync(overridePath, yaml.dump(override, { lineWidth: -1 }), "utf-8");
  }
  return changes;
}

type OverrideDoc = { services?: Record<string, Record<string, unknown> | null> } & Record<string, unknown>;

/** The in-memory part of syncOverrideImageRefs: moves `override`'s refs (mutated) and returns the changes. */
function planOverrideImageRefs(
  override: OverrideDoc,
  catalog: OverrideDoc | null,
  opts: { decide?: (service: string, from: string, to: string) => ImageRefDecision; kept?: KeptImageRef[] } = {},
): { service: string; from: string; to: string }[] {
  const overrideServices = override?.services;
  const catalogServices = catalog?.services;
  if (!overrideServices || !catalogServices) return [];

  const changes: { service: string; from: string; to: string }[] = [];
  for (const [name, svc] of Object.entries(overrideServices)) {
    const from = svc?.image;
    const to = catalogServices[name]?.image;
    if (svc && typeof from === "string" && typeof to === "string" && to.trim() && from !== to) {
      const decision = opts.decide?.(name, from, to) ?? { move: true };
      if (!decision.move) {
        opts.kept?.push({ service: name, image: from, catalogImage: to, reason: decision.reason });
        continue;
      }
      svc.image = to;
      changes.push({ service: name, from, to });
    }
  }
  return changes;
}

// Image refs interpolated into `docker image inspect` (quoted): no shell or compose syntax.
const PLAIN_IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9_.\/:@-]{0,510}$/;

/**
 * What each image ref of the running version points at locally, recorded
 * before an update pulls: `docker compose pull` moves floating tags (`:latest`,
 * `:16`, …) to the new images, and a plain `up -d` (start) or restart would
 * then run the new version. Services with a container use the image that
 * container runs; refs of the compose without one use the tag's current
 * target. Never throws — refs Docker cannot resolve are skipped (nothing to put back).
 */
async function recordTagTargets(composePath: string, baseline: ServiceImageState[]): Promise<ServiceImageState[]> {
  const targets: ServiceImageState[] = baseline.filter((s) => s.imageId);
  const covered = new Set(targets.map((s) => s.imageRef));
  for (const [service, ref] of Object.entries(composeServiceImages(composePath))) {
    if (covered.has(ref) || ref.includes("@") || !PLAIN_IMAGE_REF.test(ref)) continue;
    covered.add(ref);
    try {
      const { stdout } = await run(`docker image inspect --format "{{.Id}}" "${ref}"`, { timeout: 30_000 });
      const imageId = stdout.trim();
      if (/^sha256:[a-f0-9]{64}$/.test(imageId)) {
        targets.push({ service, containerId: "", containerName: "", imageRef: ref, imageId, repoDigest: null, status: "none" });
      }
    } catch {
      // Not present locally: a pull adds the tag, it does not move one the app used
    }
  }
  return targets;
}

/**
 * An update that stops after pulling: point the running version's tags back
 * at the images recorded before the pull, so the app's next start does not
 * silently switch versions without the update's backup, snapshot and checks.
 * Returns a sentence for the result ("" when every tag was put back).
 */
async function putBackPulledTags(appId: string, targets: ServiceImageState[]): Promise<string> {
  if (targets.length === 0) return "";
  try {
    const results = await restoreServiceImages(targets);
    const failed = results.filter((r) => !r.restored);
    if (failed.length === 0) return "";
    const which = failed.map((r) => `${r.service} (${r.error ?? "not restored"})`).join(", ");
    log.warn(`Update of ${appId} stopped after the pull; could not put back the image tags of ${which}`);
    return ` The image tags of ${which} could not be pointed back at the running version's images, ` +
      `so the next start or restart may run the newer images without a pre-update backup.`;
  } catch (err: unknown) {
    log.warn(`Update of ${appId} stopped after the pull; could not put back its image tags`, err);
    return " The running version's image tags could not be put back, so the next start or restart may run the newer images without a pre-update backup.";
  }
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

/** Container names/ids recorded by the newest rollback snapshot (for the maintenance hold). */
function latestSnapshotContainerKeys(appId: string): string[] {
  try {
    const snap = db
      .select({ previousImages: schema.updateSnapshots.previousImages })
      .from(schema.updateSnapshots)
      .where(and(eq(schema.updateSnapshots.appId, appId), eq(schema.updateSnapshots.rolledBack, false)))
      .orderBy(desc(schema.updateSnapshots.id))
      .limit(1)
      .get();
    return parseSnapshotImages(snap?.previousImages).flatMap((i) => [i.containerId, i.containerName]).filter((k): k is string => Boolean(k));
  } catch {
    return [];
  }
}

export function rollbackUpdate(appId: string, opts?: LifecycleOptions): Promise<RollbackResult & OperationResultMeta> {
  return runAppOperation(appId, "rollback", opts, async (ctx) => {
    // Containers are recreated: keep monitors and the agent loop quiet until
    // done — including containers whose container_name is not app-prefixed.
    const releaseMaintenance = holdAppMaintenance(appId, "rollback", latestSnapshotContainerKeys(appId));
    try {
      return await rollbackUpdateInner(appId, ctx);
    } finally {
      releaseMaintenance();
    }
  }, requireInstalled(appId));
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

    const containers = await discoverContainers(appId, effectiveCompose);
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
    // The compose went back to what the previous catalog compose produced.
    if (effectiveCompose !== app.composePath) restorePreviousCatalogBase(effectiveCompose);

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
      return await updateAppInner(appId, ctx, {
        force: opts?.force === true,
        useCatalogImages: opts?.useCatalogImages === true,
        beginMaintenance,
      });
    } finally {
      maintenance.release?.();
    }
  }, requireInstalled(appId));
}

interface UpdateRunOptions {
  force: boolean;
  useCatalogImages: boolean;
  beginMaintenance: (keys: Array<string | null | undefined>) => void;
}

/** Journal progress for the pre-update backup's engine stages (inside the 33–38% band, after the pull). */
const PRE_UPDATE_BACKUP_PROGRESS: Record<string, number> = {
  preparing: 33,
  dumping: 34,
  pausing: 34,
  archiving: 35,
  resuming: 36,
  validating: 37,
  uploading: 38,
};

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

  db.update(schema.installedApps)
    .set({ status: "updating", updatedAt: new Date().toISOString() })
    .where(eq(schema.installedApps.appId, appId))
    .run();

  // ── 2. Plan the new override compose (in memory) ────────────────────────
  // The override compose written at install froze the catalog's image refs
  // and service configuration. The update moves the refs to the catalog's
  // current ones (refs the user pinned or customised stay unless they asked
  // for the catalog's) and merges the catalog's other service changes
  // (environment, healthcheck, command, …) without undoing Talome's or the
  // user's edits (stores/catalog-sync.ts). Nothing is written to the live
  // compose until the images are downloaded and the backup is taken.
  let imageRefChanges: { service: string; from: string; to: string }[] = [];
  const imagesKept: KeptImageRef[] = [];
  let configChanges: ConfigChange[] = [];
  let configKept: ConfigConflict[] = [];
  let pendingCompose: string | null = null;
  let catalogContent: string | null = null;
  const hasOverride = effectiveCompose !== app.composePath;
  if (hasOverride) {
    try {
      catalogContent = readFileSync(app.composePath, "utf-8");
      const override = yaml.load(readFileSync(effectiveCompose, "utf-8")) as OverrideDoc | null;
      if (override && typeof override === "object") {
        const refState = readImageRefState(appId);
        imageRefChanges = planOverrideImageRefs(override, yaml.load(catalogContent) as OverrideDoc | null, {
          decide: (service, from, to) => decideImageRef(refState, service, from, to, { adoptCatalog: runOpts.useCatalogImages }),
          kept: imagesKept,
        });
        if (isConfigSyncSource(app.source)) {
          const sync = mergeCatalogConfig(override, catalogContent, readCatalogBase(effectiveCompose));
          configChanges = sync.changes;
          configKept = sync.kept;
        } else {
          ctx.setDetail({ configSync: { applied: false, reason: `not applied to ${app.source} apps` } });
        }
        if (imageRefChanges.length > 0 || configChanges.length > 0) {
          pendingCompose = yaml.dump(override, { lineWidth: -1 });
        }
      }
    } catch (err: unknown) {
      log.warn(`Could not sync the override compose of ${appId} with the catalog compose`, err);
    }
    if (imageRefChanges.length > 0) ctx.setDetail({ imageRefChanges });
    if (imagesKept.length > 0) ctx.setDetail({ imagesKept });
    if (configChanges.length > 0 || configKept.length > 0) {
      ctx.setDetail({ configChanges, ...(configKept.length > 0 ? { configKept } : {}) });
    }
  }

  // ── 3. Pull new images while the app keeps running ─────────────────────
  // Before the backup: a backup may stop the app, and a pull that fails (a
  // bad tag, no network) must leave the app completely untouched.
  ctx.step("pull", 10, "Downloading new images (app keeps running)");
  // The pull moves floating tags the running version uses; an update that
  // stops before recreating points them back (putBackPulledTags).
  const tagTargets = await recordTagTargets(effectiveCompose, baselineImages);
  const pullCompose = pendingCompose ? join(dirname(effectiveCompose), ".talome-update-pull.yml") : effectiveCompose;
  try {
    if (pendingCompose) atomicWriteFileSync(pullCompose, pendingCompose, "utf-8");
    await run(`docker compose -f "${pullCompose}" pull`, {
      cwd: dirname(effectiveCompose),
      env,
      timeout: 600_000,
    });
  } catch (err: any) {
    const errorDetail = String(err?.stderr || err?.message || err);
    // A multi-service pull can fail after some tags already moved.
    const tagsNote = await putBackPulledTags(appId, tagTargets);
    db.update(schema.installedApps)
      .set({ status: previousStatus, updatedAt: new Date().toISOString() })
      .where(eq(schema.installedApps.appId, appId))
      .run();
    // The update never touched the app — drop the snapshot so a later
    // "rollback" does not target a state that was never left.
    db.delete(schema.updateSnapshots).where(eq(schema.updateSnapshots.id, snapshotId)).run();
    ctx.setDetail({ snapshotId: null, appTouched: false, ...(tagsNote ? { tagsNotRestored: true } : {}) });
    const unchanged = tagsNote ? "the app kept running." : "nothing was changed and the app kept running.";
    writeNotification(
      "warning",
      `Update of ${app.name} failed`,
      `Could not download the new images, so ${unchanged}${tagsNote} ${errorDetail.slice(0, 500)}`,
      appId,
    );
    return {
      success: false,
      error: `Image pull failed; ${tagsNote ? `app kept running.${tagsNote}` : "app left unchanged"}: ${errorDetail}`,
      outcome: "failed",
    };
  } finally {
    if (pendingCompose) rmSync(pullCompose, { force: true });
  }
  ctx.step("pull", 30, "New images downloaded");

  // ── 4. Pre-update backup ────────────────────────────────────────────────
  // Taken after the pull (a failed pull never stops the app for a backup) but
  // before anything changes — the live compose still has the running
  // version's refs, so the archive (and its compose snapshot and manifest
  // version) captures the version that is actually running, and an abort
  // leaves nothing half-applied. It runs while holding this operation: the
  // engine uses its own per-app lock and Docker directly (never a lifecycle
  // entry point), so it cannot conflict with or deadlock on this update.
  let backup: PreUpdateBackupResult;
  if (isPreUpdateBackupEnabled(appId)) {
    ctx.step("backup", 32, "Backing up app data before switching versions");
    backup = await takePreUpdateBackup(appId, {
      triggeredBy: backupTriggerForActor(ctx.actor),
      onStage: (stage) => ctx.step(`backup:${stage}`, PRE_UPDATE_BACKUP_PROGRESS[stage] ?? 34),
    });
  } else {
    backup = { attempted: false, success: false, reason: "Not enabled in the app's update policy (preBackup)" };
  }
  ctx.setDetail({ backup });
  if (backup.attempted && !backup.success && !backup.skipped) {
    const backupError = backup.error ?? "unknown error";
    if (!runOpts.force) {
      // Nothing was changed yet: the new images were only downloaded, and the
      // tags the pull moved go back to the running version's images — or the
      // next start would upgrade without the backup that just failed.
      const tagsNote = await putBackPulledTags(appId, tagTargets);
      db.update(schema.installedApps)
        .set({ status: previousStatus, updatedAt: new Date().toISOString() })
        .where(eq(schema.installedApps.appId, appId))
        .run();
      db.delete(schema.updateSnapshots).where(eq(schema.updateSnapshots.id, snapshotId)).run();
      ctx.setDetail({ snapshotId: null, appTouched: false, outcome: "failed", backupFailed: true, ...(tagsNote ? { tagsNotRestored: true } : {}) });
      const error =
        `Pre-update backup failed: ${backupError}. The update was aborted before ${tagsNote ? "the app was recreated" : "anything changed"} — ` +
        `${app.name} keeps running version ${installed.version}.${tagsNote} Fix the backup, or update with force to proceed without one.`;
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

  // Apply the planned compose (restored from the snapshot on any failure).
  if (pendingCompose) {
    atomicWriteFileSync(effectiveCompose, pendingCompose, "utf-8");
    if (imageRefChanges.length > 0) {
      // Both are Talome's now: `from` was judged movable (a first record for an
      // app installed before records existed must keep treating it so, e.g.
      // after this update fails and the compose is restored), `to` is written here.
      recordManagedImages(appId, Object.fromEntries(imageRefChanges.map((c) => [c.service, c.from])));
      recordManagedImages(appId, Object.fromEntries(imageRefChanges.map((c) => [c.service, c.to])));
      if (runOpts.useCatalogImages) clearImagePins(appId, imageRefChanges.map((c) => c.service));
    }
  }

  // ── 5. Recreate on the new images ───────────────────────────────────────
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
  /** Containers recreated by `up -d` — it recreates only on a new image or a changed configuration. */
  let recreated = true;
  if (!failureReason) {
    let afterImages: ServiceImageState[] = [];
    try {
      afterImages = await captureServiceImages(appId, effectiveCompose);
    } catch {
      // Unknown — treated as changed below
    }
    const before = new Map(baselineImages.map((i) => [i.service, i.imageId]));
    const beforeContainers = new Set(baselineImages.map((i) => i.containerId));
    imagesChanged = baselineImages.length === 0 || afterImages.length === 0 ||
      afterImages.some((i) => before.get(i.service) !== i.imageId);
    recreated = baselineImages.length === 0 || afterImages.length === 0 ||
      afterImages.some((i) => !beforeContainers.has(i.containerId));
  }
  /** New images, or new service configuration that reached the containers. */
  const appChanged = imagesChanged || recreated || configChanges.length > 0;

  // ── 5b. Semantic verification (apps with outcome probes) ────────────────
  // Only once the new version passed container/HTTP verification. A regression
  // from "verified" to "failed" is reported loudly but NEVER rolled back
  // automatically. By now the new version has run, so its startup migrations
  // may already have been applied to the app's data:
  //   - putting the old images back alone runs the old binary on a schema it
  //     does not know (*arr apps refuse to start; others may corrupt data);
  //   - restoring the pre-update backup as well would discard everything the
  //     app wrote since that backup (it kept serving during the pull), unattended,
  //     on the strength of outcome probes that can fail for reasons outside the
  //     app (e.g. a download client restarting in the same bulk update).
  // The containers are healthy, so the safest state is the one we are in: keep
  // the new version, notify, and let the owner roll back the update and then
  // restore the pre-update backup (both offered) if the app really is broken.
  let semantic: SemanticVerification | null = null;
  /** Why a semantic regression was not rolled back automatically (null when there is none). */
  let semanticNotRolledBack: string | null = null;
  if (!failureReason && appChanged && verification?.healthy && semanticProbe) {
    ctx.step("semantic_verify", 75, "Checking the app still does its job (outcome probes)");
    semantic = await runSemanticVerification(appId, { baseline: semanticBaseline });
    ctx.setDetail({ semanticVerification: semantic });
    if (semantic.regression) {
      const preUpdateBackupId = backup.success ? backup.backupId : undefined;
      semanticNotRolledBack =
        "the new version has already run and may have migrated the app's data, which the older version might not run on, " +
        "and restoring the pre-update backup automatically would discard what the app wrote since then. " +
        (!imageRollbackAvailable
          ? "No previous images were recorded, so it cannot be rolled back."
          : preUpdateBackupId
            ? `To go back, roll back the update and then restore the pre-update backup ${preUpdateBackupId} ` +
              "(restore_app with backupId, or Backups → Restore) so the older version gets its own data back."
            : "No pre-update backup was taken, so rolling back would run the older version on data the new version may have migrated " +
              "(enable preBackup in the app's update policy to make a clean rollback possible).");
      ctx.setDetail({ semanticRollback: { automatic: false, reason: "the new version already ran on the app's data" } });
    }
  }

  const backupLine = backup.success && backup.backupFile
    ? ` A pre-update backup is available at ${backup.backupFile}${backup.backupId ? ` (backup ${backup.backupId})` : ""}.`
    : " No pre-update backup was taken.";
  const keptNote = [describeKeptImages(imagesKept), describeKeptConfig(configKept)].filter(Boolean).join(" ");
  const keptLine = keptNote ? ` ${keptNote}` : "";
  const keptResult = imagesKept.length > 0 ? { imagesKept } : {};

  if (!failureReason) {
    ctx.step("finalize", 95, "Recording new version");
    const containers = await discoverContainers(appId, effectiveCompose);
    ctx.setDetail({ imagesChanged, recreated });

    if (!appChanged) {
      // Same images and same configuration: nothing was recreated, so do not
      // claim an update. The catalog's version does describe what runs now,
      // though — record it (unless the user held images back), or the update
      // would be offered forever.
      const recordVersion = app.version !== installed.version && imagesKept.length === 0;
      db.delete(schema.updateSnapshots).where(eq(schema.updateSnapshots.id, snapshotId)).run();
      db.update(schema.installedApps)
        .set({
          status: "running",
          containerIds: JSON.stringify(containers),
          ...(recordVersion ? { version: app.version } : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.installedApps.appId, appId))
        .run();
      if (hasOverride && catalogContent !== null && isConfigSyncSource(app.source)) {
        recordCatalogBase(effectiveCompose, catalogContent, { previous: "keep" });
      }
      ctx.setDetail({ outcome: "no_change", snapshotId: null, ...(recordVersion ? { versionRecorded: app.version } : {}) });
      const note = (imagesKept.length > 0 && imageRefChanges.length === 0
        ? `${app.name} still runs version ${installed.version}.`
        : recordVersion
          ? `${app.name} ${app.version} uses the same images and configuration as ${installed.version}, so nothing was recreated; version ${app.version} is recorded.`
          : `${app.name} is already on the latest image.`) + keptLine;
      writeNotification("info", `${app.name} unchanged`, note, appId);
      return { success: true, verified: verification?.healthy ?? false, outcome: "no_change", warning: note, ...keptResult };
    }

    if (hasOverride && catalogContent !== null && isConfigSyncSource(app.source)) {
      // The override now derives from this catalog compose (the previous base is kept for a rollback).
      recordCatalogBase(effectiveCompose, catalogContent, { previous: "rotate" });
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
        `If it does not recover, roll back the update.${backupLine}${keptLine}`;
      ctx.setDetail({ outcome: "unverified" });
      writeNotification("warning", `${app.name} updated, not yet verified`, warning, appId);
      return { success: true, verified: false, outcome: "unverified", warning, ...backupResult, ...keptResult };
    }

    if (semantic?.regression && semanticNotRolledBack) {
      // A known regression is never reported as a clean, verified success.
      const warning =
        `Updated to version ${app.version} and its containers are healthy, but it passed its outcome checks before the update ` +
        `and fails them now (${semantic.summary ?? "checks failed"}). It was not rolled back automatically: ${semanticNotRolledBack}` +
        `${backupLine}${keptLine}`;
      ctx.setDetail({ outcome: "regressed" });
      writeNotification("critical", `${app.name} updated, outcome checks now failing`, warning, appId);
      return { success: true, verified: true, outcome: "unverified", warning, ...semanticResult, ...backupResult, ...keptResult };
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
      writeNotification(status === "unknown" ? "info" : "warning", `${app.name} updated, outcome checks ${status}`, `${warning}${keptLine}`, appId);
      return { success: true, verified: true, outcome: "updated", warning: `${warning}${keptLine}`, ...semanticResult, ...backupResult, ...keptResult };
    }
    const outcomeNote = semantic?.ran && semantic.status === "verified" ? "; outcome checks pass" : "";
    writeNotification("info", `${app.name} updated`, `Updated to version ${app.version} and verified healthy${outcomeNote}${keptLine ? `.${keptLine}` : ""}`, appId);
    return { success: true, verified: true, outcome: "updated", ...(keptNote ? { warning: keptNote } : {}), ...semanticResult, ...backupResult, ...keptResult };
  }

  // ── 6. Automatic rollback ───────────────────────────────────────────────
  if (!imageRollbackAvailable) {
    // Without the previous images, "rolling back" would recreate the new
    // images under the old compose and misreport it as restored.
    const error = `${failureReason}. Automatic rollback is unavailable: the previous images were not recorded (the app had no containers before the update).`;
    ctx.setDetail({ outcome: "failed", rollback: { attempted: false, reason: "no image baseline" } });
    db.update(schema.installedApps)
      .set({ status: "error", containerIds: JSON.stringify(await discoverContainers(appId, effectiveCompose)), updatedAt: new Date().toISOString() })
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
  const containers = await discoverContainers(appId, effectiveCompose);
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

  if (rolledBack && snapshot) {
    db.update(schema.updateSnapshots)
      .set({ rolledBack: true, rollbackReason: failureReason })
      .where(eq(schema.updateSnapshots.id, snapshot.id))
      .run();
    ctx.setDetail({ outcome: "rolled_back", ...(backup.success && backup.backupId ? { dataRestore: { backupId: backup.backupId, available: true } } : {}) });
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
  return { success: false, error, verified: false, rolledBack: false, outcome: "failed", ...dataRestore };
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
