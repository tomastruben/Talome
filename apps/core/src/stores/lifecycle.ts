import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import { db, schema } from "../db/index.js";
import { eq, and, desc } from "drizzle-orm";
import { listContainers, listNetworks, removeNetwork, connectContainerToNetwork } from "../docker/client.js";
import { ensureTalomeNetwork, injectTalomeNetwork } from "../docker/talome-network.js";
import { autoConfigureApp, type AutoConfigResult } from "../app-registry/auto-configure.js";
import { getAppCapabilities } from "../app-registry/index.js";
import type { InstalledAppStatus, AppVolume } from "@talome/types";
import { fireTrigger } from "../automation/engine.js";
import { writeNotification } from "../db/notifications.js";
import { createLogger } from "../utils/logger.js";

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
  captureImageDigest,
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

// ── Re-exports (preserve public API) ─────────────────────────────────────
export { checkPortConflicts } from "./port-resolution.js";

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

export function installApp(
  appId: string,
  storeSourceId: string,
  envOverrides: Record<string, string> = {},
  volumeMounts: Record<string, string> = {},
  onProgress?: (stage: string, message: string) => void,
): Promise<{ success: boolean; error?: string; remappedPorts?: Record<number, number>; dependencies?: DependencyCheck; autoConfig?: AutoConfigResult }> {
  return withAppLock(appId, () => installAppInner(appId, storeSourceId, envOverrides, volumeMounts, onProgress));
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
  const depCheck = resolveDependencies(appId, storeSourceId);
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

export function uninstallApp(appId: string): Promise<{ success: boolean; error?: string }> {
  return withAppLock(appId, () => uninstallAppInner(appId));
}

async function uninstallAppInner(appId: string): Promise<{ success: boolean; error?: string }> {
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
  const envOverridesUninst = JSON.parse(installed.envConfig) as Record<string, string>;
  const envUninst = buildEnv(appId, envOverridesUninst);
  await executeHook("preUninstall", appId, app.hooks, { composePath: app.composePath, env: envUninst }).catch((err) => log.warn(`preUninstall hook failed for ${appId}`, err));

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

export async function startApp(appId: string): Promise<{ success: boolean; error?: string }> {
  return composeAction(appId, "start");
}

export async function stopApp(appId: string): Promise<{ success: boolean; error?: string }> {
  return composeAction(appId, "stop");
}

export async function restartApp(appId: string): Promise<{ success: boolean; error?: string }> {
  return composeAction(appId, "restart");
}

function composeAction(
  appId: string,
  action: "start" | "stop" | "restart",
): Promise<{ success: boolean; error?: string }> {
  return withAppLock(appId, () => composeActionInner(appId, action));
}

async function composeActionInner(
  appId: string,
  action: "start" | "stop" | "restart",
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
          for (const dep of stoppedDeps) {
            log.info(`Starting dependency ${dep.name} before ${appId}`);
            const depResult = await startApp(dep.appId);
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
      await run(`docker compose -f "${effectiveCompose}" up -d --force-recreate`, {
        cwd: projectDir,
        env,
        timeout: 180_000,
      });
    } else {
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

function snapshotBeforeUpdate(appId: string, installed: { version: string; overrideComposePath: string | null }, composePath: string): void {
  try {
    const { image, digest } = captureImageDigest(installed.overrideComposePath ?? composePath);

    let composeContent: string | null = null;
    try {
      composeContent = readFileSync(installed.overrideComposePath ?? composePath, "utf-8");
    } catch {
      // Best-effort
    }

    db.insert(schema.updateSnapshots)
      .values({
        appId,
        previousVersion: installed.version,
        previousImage: image,
        previousDigest: digest,
        previousCompose: composeContent,
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch {
    // Snapshot is best-effort
  }
}

export function rollbackUpdate(appId: string): Promise<{ success: boolean; error?: string; rolledBackTo?: string }> {
  return withAppLock(appId, () => rollbackUpdateInner(appId));
}

async function rollbackUpdateInner(appId: string): Promise<{ success: boolean; error?: string; rolledBackTo?: string }> {
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

  const effectiveCompose = installed.overrideComposePath ?? app.composePath;
  const envOverrides = JSON.parse(installed.envConfig) as Record<string, string>;
  const env = buildEnv(appId, envOverrides);
  const projectDir = dirname(effectiveCompose);

  try {
    // Ensure talome network exists before rollback compose up
    await ensureTalomeNetwork().catch((err: unknown) =>
      log.warn(`ensureTalomeNetwork before rollback ${appId}`, err),
    );

    if (snapshot.previousCompose) {
      const rollbackPath = installed.overrideComposePath ?? app.composePath;
      atomicWriteFileSync(rollbackPath, snapshot.previousCompose, "utf-8");
    }

    await run(`docker compose -f "${effectiveCompose}" down --remove-orphans`, {
      cwd: projectDir,
      env,
      timeout: 60_000,
    }).catch((err) => log.warn(`Failed to bring down containers during rollback for ${appId}`, err));

    await run(`docker compose -f "${effectiveCompose}" up -d`, {
      cwd: projectDir,
      env,
      timeout: 180_000,
    });

    const containers = await discoverContainers(appId);

    db.update(schema.installedApps)
      .set({
        status: "running",
        containerIds: JSON.stringify(containers),
        version: snapshot.previousVersion,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    db.update(schema.updateSnapshots)
      .set({ rolledBack: true })
      .where(eq(schema.updateSnapshots.id, snapshot.id))
      .run();

    writeNotification("info", `${app.name} rolled back`, `Reverted to version ${snapshot.previousVersion}`, appId);
    return { success: true, rolledBackTo: snapshot.previousVersion };
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

export function updateApp(appId: string): Promise<{ success: boolean; error?: string; verified?: boolean }> {
  return withAppLock(appId, () => updateAppInner(appId));
}

async function updateAppInner(appId: string): Promise<{ success: boolean; error?: string; verified?: boolean }> {
  const installed = getInstalledApp(appId);
  if (!installed) return { success: false, error: "App is not installed" };

  const app = getCatalogApp(appId, installed.storeSourceId);
  if (!app) return { success: false, error: "App not found in catalog" };

  // Enforce pre-update backup if the app's update policy requires it
  try {
    const policy = db
      .select()
      .from(schema.appUpdatePolicies)
      .where(eq(schema.appUpdatePolicies.appId, appId))
      .get();
    if (policy?.preBackup) {
      const effectiveCompose = installed.overrideComposePath ?? app.composePath;
      const composeDir = dirname(effectiveCompose);
      const backupDir = join(homedir(), ".talome", "backups", "apps", appId);
      mkdirSync(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupFile = join(backupDir, `${ts}-pre-update.tar.gz`);
      try {
        const raw = readFileSync(effectiveCompose, "utf-8");
        const parsed = yaml.load(raw) as Record<string, unknown>;
        const paths: string[] = [];
        const services = (parsed?.services ?? {}) as Record<string, Record<string, unknown>>;
        for (const svc of Object.values(services)) {
          const volumes = Array.isArray(svc?.volumes) ? svc.volumes as unknown[] : [];
          for (const vol of volumes) {
            const volObj = vol as Record<string, string> | undefined;
            const hostPath = typeof vol === "string" ? vol.split(":")[0] : volObj?.source;
            if (hostPath && !hostPath.startsWith("/var/run") && !hostPath.startsWith("/etc")) {
              const resolved = hostPath.startsWith("/") ? hostPath : join(composeDir, hostPath);
              if (existsSync(resolved)) paths.push(resolved);
            }
          }
        }
        if (paths.length > 0) {
          const pathArgs = paths.map((p) => `"${p}"`).join(" ");
          execSync(`tar -czf "${backupFile}" ${pathArgs}`, { timeout: 120_000, stdio: "pipe" });
          writeNotification("info", `Pre-update backup created`, `${appId} backed up before update`, appId);
        }
      } catch {
        // Backup is best-effort
      }
    }
  } catch {
    // Policy check is best-effort
  }

  // Snapshot current state before updating (for rollback)
  snapshotBeforeUpdate(appId, installed, app.composePath);

  db.update(schema.installedApps)
    .set({ status: "updating", updatedAt: new Date().toISOString() })
    .where(eq(schema.installedApps.appId, appId))
    .run();

  let effectiveCompose = installed.overrideComposePath ?? app.composePath;

  const envOverrides = JSON.parse(installed.envConfig) as Record<string, string>;
  const env = buildEnv(appId, envOverrides);

  try {
    await run(`docker compose -f "${app.composePath}" pull`, {
      cwd: dirname(app.composePath),
      env,
      timeout: 300_000,
    });

    // Re-inject talome network into compose (may have been lost if catalog compose changed)
    try {
      await ensureTalomeNetwork();
      effectiveCompose = await injectNetworkIntoCompose(effectiveCompose, appId);
    } catch (err: unknown) {
      log.warn(`talome network re-injection during update for ${appId}`, err);
    }

    const projectDir = dirname(effectiveCompose);

    await run(`docker compose -f "${effectiveCompose}" up -d`, {
      cwd: projectDir,
      env,
      timeout: 180_000,
    });

    const containers = await discoverContainers(appId);

    // Post-update health verification: wait up to 60s for containers to be running
    const verifyDeadline = Date.now() + 60_000;
    let allHealthy = false;
    while (Date.now() < verifyDeadline) {
      try {
        const live = await listContainers();
        const appContainers = live.filter((c) => containers.includes(c.id));
        allHealthy = appContainers.length > 0 && appContainers.every((c) => c.status === "running");
        if (allHealthy) break;
      } catch {
        // Transient Docker error — keep trying
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }

    if (!allHealthy) {
      log.warn(`Post-update health check failed for ${appId} — containers not all running after 60s`);
      writeNotification("warning", `${app.name} update: containers slow to start`, "The update completed but not all containers are running yet. Check the app status.", appId);
    }

    try {
      const latestSnapshot = db
        .select()
        .from(schema.updateSnapshots)
        .where(eq(schema.updateSnapshots.appId, appId))
        .orderBy(desc(schema.updateSnapshots.id))
        .limit(1)
        .get();
      if (latestSnapshot) {
        db.update(schema.updateSnapshots)
          .set({ newVersion: app.version })
          .where(eq(schema.updateSnapshots.id, latestSnapshot.id))
          .run();
      }
    } catch {
      // Best-effort
    }

    db.update(schema.installedApps)
      .set({
        status: allHealthy ? "running" : "error",
        containerIds: JSON.stringify(containers),
        version: app.version,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    pinImageDigest(appId, effectiveCompose);

    if (allHealthy) {
      writeNotification("info", `${app.name} updated`, `Updated to version ${app.version}`, appId);
    }
    return { success: true, verified: allHealthy };
  } catch (err: any) {
    const errorDetail = err?.stderr || err.message;
    recordInstallError(appId, `docker compose up -d (update)`, err, effectiveCompose, env);

    db.update(schema.installedApps)
      .set({ status: "error", updatedAt: new Date().toISOString() })
      .where(eq(schema.installedApps.appId, appId))
      .run();

    writeNotification("critical", `Failed to update ${app.name}`, errorDetail, appId);
    return { success: false, error: errorDetail };
  }
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
