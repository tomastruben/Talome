/**
 * Install-path glue for Umbrel 2.0 manifests: feeds real settings, installed
 * apps and host capabilities into the pure planner in `umbrel-v2.ts`, writes
 * the transformed compose file and persists the user's choices.
 *
 * Install options reach the install pipeline through AsyncLocalStorage so the
 * existing `installApp(appId, storeId, env, volumeMounts, onProgress)`
 * signature (used by routes, AI tools, MCP and the setup loop) stays unchanged:
 *
 *   await runWithUmbrelInstallOptions(options, () => installApp(...));
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { atomicWriteFileSync, TALOME_HOME } from "../utils/filesystem.js";
import { getSetting } from "../utils/settings.js";
import { writeNotification } from "../db/notifications.js";
import { createLogger } from "../utils/logger.js";
import { APP_DATA_DIR, getCatalogApp } from "./compose-exec.js";
import type { DependencyCheck } from "./lifecycle.js";
import {
  applyUmbrelV2Plan,
  GPU_UNAVAILABLE_WARNING,
  hostFolderPolicyFor,
  normalizeBackupIgnore,
  planUmbrelV2Install,
  resolveUmbrelDependencies,
  UmbrelInstallOptionsSchema,
  validateHostFolder,
  type UmbrelInstallOptions,
  type UmbrelInstalledProvider,
  type UmbrelV2Context,
  type UmbrelV2Meta,
  type UmbrelV2Plan,
} from "./umbrel-v2.js";

const log = createLogger("umbrel-v2");

type CatalogRow = typeof schema.appCatalog.$inferSelect;

// ── Install options context ──────────────────────────────────────────────────

const installOptionsStorage = new AsyncLocalStorage<UmbrelInstallOptions>();

/** Run `fn` (typically an `installApp` call) with Umbrel install options in scope. */
export function runWithUmbrelInstallOptions<T>(
  options: UmbrelInstallOptions | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!options || Object.keys(options).length === 0) return fn();
  return installOptionsStorage.run(options, fn);
}

/** Install options for the install currently running in this async context. */
export function getActiveUmbrelInstallOptions(): UmbrelInstallOptions {
  return installOptionsStorage.getStore() ?? {};
}

// ── Catalog metadata ─────────────────────────────────────────────────────────

export function parseUmbrelMeta(value: string | null | undefined): UmbrelV2Meta | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as UmbrelV2Meta) : null;
  } catch {
    return null;
  }
}

function getCatalogRow(appId: string, storeSourceId: string): CatalogRow | undefined {
  return getCatalogApp(appId, storeSourceId);
}

/** Installed apps with the interfaces their manifests implement. */
function listInstalledProviders(): UmbrelInstalledProvider[] {
  const installed = db.select().from(schema.installedApps).all();
  return installed
    .filter((app) => app.status !== "installing" && app.status !== "error")
    .map((app) => {
      const row = getCatalogRow(app.appId, app.storeSourceId);
      const meta = parseUmbrelMeta(row?.umbrelMeta);
      return { appId: app.appId, ...(meta?.implements?.length ? { implements: meta.implements } : {}) };
    });
}

function settingPath(key: string): string | undefined {
  const value = getSetting(key)?.trim();
  return value && value.startsWith("/") ? value.replace(/\/+$/, "") || "/" : undefined;
}

/** Build the planner context from Talome settings and host state. */
export function buildUmbrelV2Context(appId: string): UmbrelV2Context {
  return {
    appId,
    paths: {
      appDataDir: join(APP_DATA_DIR, appId),
      appDataParent: APP_DATA_DIR,
      mediaRoot: settingPath("media_root"),
      downloadsRoot: settingPath("downloads_root"),
      booksRoot: settingPath("books_root"),
      // Talome's own state (DB, secrets, other apps' data, store cache) is never an app folder.
      protectedTrees: [
        TALOME_HOME,
        dirname(resolve(process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db"))),
      ],
    },
    installedApps: listInstalledProviders(),
    hasDri: existsSync("/dev/dri"),
  };
}

/** Preview the install plan for a catalog app (used by the stores API). */
export function previewUmbrelV2Install(
  appId: string,
  storeSourceId: string,
  options: UmbrelInstallOptions = {},
): { found: false } | { found: true; meta: UmbrelV2Meta | null; plan: UmbrelV2Plan } {
  const row = getCatalogRow(appId, storeSourceId);
  if (!row) return { found: false };
  const meta = parseUmbrelMeta(row.umbrelMeta);
  let compose: Record<string, unknown> | null = null;
  try {
    const loaded = yaml.load(readFileSync(row.composePath, "utf-8"));
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) compose = loaded as Record<string, unknown>;
  } catch {
    // Missing/invalid compose — plan with what the manifest declares.
  }
  return { found: true, meta, plan: planUmbrelV2Install(meta, compose, options, buildUmbrelV2Context(appId)) };
}

// ── Install hooks (called from lifecycle.ts installAppInner) ─────────────────

/**
 * Dependency hook: dependencies satisfied by an installed app that
 * `implements` them (or an explicit provider choice) are moved from
 * `missing` to `installed`. Non-Umbrel apps pass through untouched.
 */
export function reconcileUmbrelDependencies(app: CatalogRow, depCheck: DependencyCheck): DependencyCheck {
  if (app.source !== "umbrel" || depCheck.satisfied) return depCheck;
  try {
    const selections = getActiveUmbrelInstallOptions().dependencies ?? {};
    const providers = listInstalledProviders();
    const resolved = resolveUmbrelDependencies(
      depCheck.missing.map((d) => d.appId),
      providers,
      selections,
    );
    const byDependency = new Map(resolved.resolutions.map((r) => [r.dependency, r]));
    const missing: DependencyCheck["missing"] = [];
    const installed = [...depCheck.installed];
    for (const dep of depCheck.missing) {
      const resolution = byDependency.get(dep.appId);
      const provider = resolution?.provider;
      if (!provider) {
        missing.push(dep);
        continue;
      }
      const inst = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, provider)).get();
      installed.push({
        appId: provider,
        name: resolution.viaImplements ? `${provider} (provides ${dep.appId})` : dep.name,
        status: inst?.status ?? "running",
      });
    }
    return { satisfied: missing.length === 0, missing, installed };
  } catch (err: unknown) {
    log.warn(`dependency reconciliation for ${app.appId}`, err);
    return depCheck;
  }
}

export type UmbrelV2InstallResult =
  | { ok: true; composePath: string | null; env: Record<string, string>; plan: UmbrelV2Plan | null }
  | { ok: false; error: string };

/**
 * Compose hook: applies folderAccess, environment choices, GPU devices,
 * `${UMBREL_ROOT}` path mapping and data-root redirection to the compose file
 * Talome is about to run. Returns the (possibly new) compose path and the env
 * overrides to write. Non-Umbrel apps are a no-op.
 */
export function applyUmbrelV2Install(
  app: CatalogRow,
  appId: string,
  composePath: string,
  envOverrides: Record<string, string>,
): UmbrelV2InstallResult {
  if (app.source !== "umbrel") return { ok: true, composePath: null, env: envOverrides, plan: null };

  const rawOptions = getActiveUmbrelInstallOptions();
  const parsedOptions = UmbrelInstallOptionsSchema.safeParse(rawOptions);
  if (!parsedOptions.success) return { ok: false, error: "Invalid Umbrel install options" };
  const options = parsedOptions.data;

  let compose: Record<string, unknown>;
  try {
    const loaded = yaml.load(readFileSync(composePath, "utf-8"));
    if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
      return { ok: true, composePath: null, env: envOverrides, plan: null };
    }
    compose = loaded as Record<string, unknown>;
  } catch (err: unknown) {
    log.warn(`reading compose for ${appId}`, err);
    return { ok: true, composePath: null, env: envOverrides, plan: null };
  }

  const meta = parseUmbrelMeta(app.umbrelMeta);
  const ctx = buildUmbrelV2Context(appId);
  const plan = planUmbrelV2Install(meta, compose, options, ctx);
  plan.blockers.push(...checkResolvedHostFolders(plan, ctx.paths));
  if (plan.blockers.length > 0) {
    return { ok: false, error: plan.blockers.join(" ") };
  }

  for (const dir of plan.ensureDirs) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err: unknown) {
      log.warn(`creating ${dir} for ${appId}`, err);
    }
  }

  const { compose: transformed, changed } = applyUmbrelV2Plan(compose, plan);
  let nextComposePath: string | null = null;
  if (changed) {
    const overridePath = join(APP_DATA_DIR, appId, "docker-compose.yml");
    mkdirSync(dirname(overridePath), { recursive: true });
    atomicWriteFileSync(overridePath, yaml.dump(transformed, { lineWidth: -1 }), "utf-8");
    nextComposePath = overridePath;
  }

  // User-provided env (the `env` install parameter) wins over manifest choices.
  const env = { ...plan.interpolationEnv, ...envOverrides };

  saveInstallOptions(appId, app.storeSourceId, options, plan);

  // The GPU warning is already raised by lifecycle's permission validation.
  const notes = plan.warnings.filter((w) => w !== GPU_UNAVAILABLE_WARNING);
  if (notes.length > 0) {
    writeNotification("warning", `Notes for ${app.name}`, notes.join(" "), appId);
  }

  return { ok: true, composePath: nextComposePath, env, plan };
}

/**
 * The planner validates the paths the user typed; a symlink could still point
 * somewhere protected, so re-check the real location of every chosen folder.
 */
function checkResolvedHostFolders(plan: UmbrelV2Plan, paths: UmbrelV2Context["paths"]): string[] {
  const chosen = plan.folders.filter((f) => f.userSelected).map((f) => ({ label: `Folder "${f.name}"`, path: f.source }));
  if (plan.dataRoot.hostPath) chosen.push({ label: "Data folder", path: plan.dataRoot.hostPath });
  const policy = hostFolderPolicyFor(paths);
  const problems: string[] = [];
  for (const { label, path } of chosen) {
    if (!existsSync(path)) continue;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (real === path) continue;
    const error = validateHostFolder(real, policy);
    if (error) problems.push(`${label}: ${path} resolves to ${real} — ${error}.`);
  }
  return problems;
}

function saveInstallOptions(
  appId: string,
  storeSourceId: string,
  options: UmbrelInstallOptions,
  plan: UmbrelV2Plan,
): void {
  const summary = {
    folders: plan.folders.map((f) => ({ id: f.id, source: f.source, mounts: f.mounts })),
    environment: plan.environment.filter((e) => e.value !== undefined).map((e) => ({ name: e.name, value: e.value, origin: e.origin })),
    devices: plan.gpu.devices,
    requiresHttps: plan.requiresHttps,
    dataRoot: plan.dataRoot,
    dependencies: plan.dependencies,
    backupIgnore: plan.backupIgnore,
    warnings: plan.warnings,
  };
  try {
    pruneStaleInstallOptions(appId);
    const now = new Date().toISOString();
    db.insert(schema.appInstallOptions)
      .values({ appId, storeSourceId, options: JSON.stringify(options), plan: JSON.stringify(summary), updatedAt: now })
      .onConflictDoUpdate({
        target: schema.appInstallOptions.appId,
        set: { storeSourceId, options: JSON.stringify(options), plan: JSON.stringify(summary), updatedAt: now },
      })
      .run();
  } catch (err: unknown) {
    log.warn(`persisting install options for ${appId}`, err);
  }
}

/**
 * Options are saved while the install is still running (before `up`), so a
 * failed install or a later uninstall leaves a row behind. Drop rows whose app
 * is not installed (the app being installed right now is kept).
 */
function pruneStaleInstallOptions(keepAppId: string): void {
  const installed = new Set(db.select({ appId: schema.installedApps.appId }).from(schema.installedApps).all().map((r) => r.appId));
  const rows = db.select({ appId: schema.appInstallOptions.appId }).from(schema.appInstallOptions).all();
  for (const row of rows) {
    if (row.appId === keepAppId || installed.has(row.appId)) continue;
    db.delete(schema.appInstallOptions).where(eq(schema.appInstallOptions.appId, row.appId)).run();
  }
}

// ── Getters for other subsystems ─────────────────────────────────────────────

function installedCatalogMeta(appId: string): UmbrelV2Meta | null {
  const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
  if (!installed) return null;
  return parseUmbrelMeta(getCatalogRow(appId, installed.storeSourceId)?.umbrelMeta);
}

/**
 * Paths (relative to the app's data directory) an installed app asks backups
 * to skip — Umbrel `backupIgnore`, e.g. `data/cache/*`. Empty when none.
 * For the backups workstream.
 */
export function getAppBackupIgnore(appId: string): string[] {
  try {
    return normalizeBackupIgnore(installedCatalogMeta(appId)?.backupIgnore);
  } catch {
    return [];
  }
}

/** True when an installed app declares `requiresHttps` — the proxy layer should serve it over TLS. */
export function appRequiresHttps(appId: string): boolean {
  try {
    return installedCatalogMeta(appId)?.requiresHttps === true;
  } catch {
    return false;
  }
}

/**
 * Saved install choices + resolved plan summary for an installed app, if any.
 * Returns null for apps that are not (or no longer, or not successfully)
 * installed so callers never act on a failed or uninstalled install's choices.
 */
export function getAppInstallOptions(
  appId: string,
): { options: UmbrelInstallOptions; plan: Record<string, unknown> } | null {
  try {
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
    if (!installed || installed.status === "error") return null;
    const row = db.select().from(schema.appInstallOptions).where(eq(schema.appInstallOptions.appId, appId)).get();
    if (!row) return null;
    return { options: JSON.parse(row.options) as UmbrelInstallOptions, plan: JSON.parse(row.plan) as Record<string, unknown> };
  } catch {
    return null;
  }
}
