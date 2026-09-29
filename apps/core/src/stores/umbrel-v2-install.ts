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
import { getSetting, setSetting } from "../utils/settings.js";
import { writeNotification } from "../db/notifications.js";
import { createLogger } from "../utils/logger.js";
import { getAppBackupConfig, setAppBackupConfig } from "../backup/store.js";
import { requiresHttpsInstallWarning } from "../proxy/https-policy.js";
import { onOperationEvent, type OperationEvent } from "../ops/operations.js";
import { APP_DATA_DIR, getCatalogApp } from "./compose-exec.js";
import { fillGeneratedInstallEnv } from "./generated-env.js";
import type { DependencyCheck } from "./lifecycle.js";
import {
  applyUmbrelV2Plan,
  GPU_UNAVAILABLE_WARNING,
  hostFolderPolicyFor,
  REQUIRES_HTTPS_WARNING,
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
 * overrides to write.
 *
 * For every source it first fills the per-install secrets a Talome-store
 * manifest asks Talome to generate (see generated-env.ts) — this hook is the
 * one step every install caller (routes, AI tools, MCP, setup) runs before the
 * .env is written and missing variables are checked. Otherwise non-Umbrel apps
 * are a no-op.
 */
export function applyUmbrelV2Install(
  app: CatalogRow,
  appId: string,
  composePath: string,
  installEnv: Record<string, string>,
): UmbrelV2InstallResult {
  const generated = fillGeneratedInstallEnv(appId, app.composePath, installEnv);
  if (generated.generated.length > 0 || generated.reused.length > 0) {
    log.info(
      `Install env for ${appId}: generated ${generated.generated.join(", ") || "none"}` +
        `; reused from the previous install ${generated.reused.join(", ") || "none"}`,
    );
  }
  const envOverrides = generated.env;
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

  // No TLS route for an app that requires HTTPS: say so plainly instead of
  // the generic "open it through the reverse proxy" note.
  const httpsWarning = requiresHttpsInstallWarning(appId, app.name, {
    webPort: app.webPort,
    requiresHttps: plan.requiresHttps,
  });
  if (httpsWarning) {
    const idx = plan.warnings.indexOf(REQUIRES_HTTPS_WARNING);
    if (idx >= 0) plan.warnings.splice(idx, 1, httpsWarning);
    else plan.warnings.push(httpsWarning);
  }

  saveInstallOptions(appId, app.storeSourceId, options, plan);

  // Umbrel `backupIgnore` (caches, thumbnails, …) becomes part of the app's
  // backup excludes — merged with anything the user configured, never
  // replacing it — once the install operation succeeds.
  queueBackupIgnoreMerge(appId, plan.backupIgnore);

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

// ── Backups: Umbrel backupIgnore → app backup excludes ───────────────────────

/** Upper bound of the backup config schema (backup/types.ts). */
const MAX_BACKUP_EXCLUDE_PATTERNS = 200;
const MAX_BACKUP_EXCLUDE_PATTERN_LENGTH = 512;

/** Settings key prefix: the patterns Talome added from an app's Umbrel manifest (JSON array). */
export const UMBREL_BACKUP_IGNORE_ADDED_PREFIX = "umbrel_backup_ignore_added:";

function readAddedPatterns(appId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(getSetting(`${UMBREL_BACKUP_IGNORE_ADDED_PREFIX}${appId}`) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function writeAddedPatterns(appId: string, patterns: string[]): void {
  setSetting(`${UMBREL_BACKUP_IGNORE_ADDED_PREFIX}${appId}`, JSON.stringify(patterns));
}

/**
 * Add an app's Umbrel `backupIgnore` patterns to its backup excludes and
 * report whether the merge completed. The result is the union of what is
 * configured and the manifest's patterns (existing order first,
 * de-duplicated) — user-set patterns are never removed or rewritten. Patterns
 * Talome added are remembered so they can be dropped if the same app id is
 * later installed from a store with a different data layout. Never throws.
 */
export function tryMergeAppBackupIgnore(appId: string, patterns: readonly string[]): { ok: boolean; added: string[] } {
  try {
    const wanted = normalizeBackupIgnore([...patterns]).filter((p) => p.length <= MAX_BACKUP_EXCLUDE_PATTERN_LENGTH);
    if (wanted.length === 0) return { ok: true, added: [] };
    const current = getAppBackupConfig(appId).excludePatterns;
    const have = new Set(current.map((p) => p.trim()));
    const room = Math.max(0, MAX_BACKUP_EXCLUDE_PATTERNS - current.length);
    const added = wanted.filter((p) => !have.has(p)).slice(0, room);
    if (added.length === 0) return { ok: true, added: [] };
    setAppBackupConfig(appId, { excludePatterns: [...current, ...added] });
    const recorded = readAddedPatterns(appId);
    writeAddedPatterns(appId, [...recorded, ...added.filter((p) => !recorded.includes(p))]);
    return { ok: true, added };
  } catch (err: unknown) {
    log.warn(`merging backupIgnore into backup config for ${appId}`, err);
    return { ok: false, added: [] };
  }
}

/** {@link tryMergeAppBackupIgnore}, returning only the patterns that were added. */
export function mergeAppBackupIgnore(appId: string, patterns: readonly string[]): string[] {
  return tryMergeAppBackupIgnore(appId, patterns).added;
}

/**
 * Remove the patterns Talome previously added from an Umbrel manifest (and
 * only those — user patterns stay). Used when the app id is installed from a
 * non-Umbrel store, whose data layout the Umbrel patterns do not describe.
 * Returns the removed patterns. Never throws.
 */
export function dropAddedUmbrelBackupIgnore(appId: string): string[] {
  try {
    const recorded = readAddedPatterns(appId);
    if (recorded.length === 0) return [];
    const current = getAppBackupConfig(appId).excludePatterns;
    const drop = new Set(recorded);
    const kept = current.filter((p) => !drop.has(p.trim()));
    if (kept.length !== current.length) setAppBackupConfig(appId, { excludePatterns: kept });
    writeAddedPatterns(appId, []);
    return current.filter((p) => drop.has(p.trim()));
  } catch (err: unknown) {
    log.warn(`dropping Umbrel backupIgnore patterns for ${appId}`, err);
    return [];
  }
}

// The merge waits for the install operation to succeed: a failed install
// (missing env, invalid compose, `compose up` error) must not leave backup
// config behind for an app that is not installed.
const pendingBackupIgnore = new Map<string, string[]>();
let installEventsSubscribed = false;

function queueBackupIgnoreMerge(appId: string, patterns: readonly string[]): void {
  pendingBackupIgnore.set(appId, [...patterns]);
  subscribeInstallEvents();
}

/** Terminal install operations settle the pending merge (exported for tests). */
export function handleInstallOperationEvent(event: Pick<OperationEvent, "appId" | "kind" | "status">): void {
  if (event.kind !== "install") return;
  if (event.status !== "succeeded" && event.status !== "failed" && event.status !== "rolled_back" && event.status !== "interrupted") return;
  const pending = pendingBackupIgnore.get(event.appId);
  pendingBackupIgnore.delete(event.appId);
  if (event.status !== "succeeded") return;
  if (pending) {
    tryMergeAppBackupIgnore(event.appId, pending);
  } else if (!isInstalledFromUmbrel(event.appId)) {
    // Installed from a non-Umbrel store: stale Umbrel patterns would silently
    // exclude paths from this layout's backups.
    const dropped = dropAddedUmbrelBackupIgnore(event.appId);
    if (dropped.length > 0) log.info(`Removed Umbrel backupIgnore patterns from ${event.appId}'s backup excludes: ${dropped.join(", ")}`);
  }
}

function isInstalledFromUmbrel(appId: string): boolean {
  try {
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
    return !!installed && getCatalogRow(appId, installed.storeSourceId)?.source === "umbrel";
  } catch {
    return true; // unknown: never drop patterns on a guess
  }
}

function subscribeInstallEvents(): void {
  if (installEventsSubscribed) return;
  installEventsSubscribed = true;
  onOperationEvent(handleInstallOperationEvent);
}

/** Subscribe before any install runs (called from initializeStores). */
export function watchInstallsForBackupIgnore(): void {
  subscribeInstallEvents();
}

/** Settings marker: set once every installed Umbrel app's backupIgnore was merged. */
export const UMBREL_BACKUP_IGNORE_BACKFILL_KEY = "umbrel_backup_ignore_backfilled_at";

export interface BackfillUmbrelBackupIgnoreOptions {
  /**
   * False while a store's catalog may not carry current Umbrel metadata yet
   * (e.g. a disabled store parsed by an older parser). Apps from such stores
   * keep the backfill pending instead of being marked done with nothing merged.
   */
  isCatalogCurrent?: (storeSourceId: string) => boolean;
}

/**
 * One-time backfill for Umbrel apps installed before `backupIgnore` reached
 * the backup engine. Idempotent (union merge) and guarded by a settings
 * marker that is only set once every app merged cleanly — a failed merge or a
 * stale catalog retries on the next boot. Call it after migrations and after
 * the catalog carries Umbrel metadata (see stores/sync.ts initializeStores).
 * Never throws.
 */
export function backfillUmbrelBackupIgnore(
  options: BackfillUmbrelBackupIgnoreOptions = {},
): { ran: boolean; updated: string[]; pending: string[] } {
  try {
    if (getSetting(UMBREL_BACKUP_IGNORE_BACKFILL_KEY)) return { ran: false, updated: [], pending: [] };
    const isCatalogCurrent = options.isCatalogCurrent ?? (() => true);
    const updated: string[] = [];
    const pending: string[] = [];
    const installed = db.select().from(schema.installedApps).all();
    for (const app of installed) {
      if (app.status === "installing") continue;
      const row = getCatalogRow(app.appId, app.storeSourceId);
      if (row?.source !== "umbrel") continue;
      if (!isCatalogCurrent(app.storeSourceId)) {
        pending.push(app.appId);
        continue;
      }
      const result = tryMergeAppBackupIgnore(app.appId, getAppBackupIgnore(app.appId));
      if (!result.ok) pending.push(app.appId);
      else if (result.added.length > 0) updated.push(app.appId);
    }
    if (pending.length === 0) {
      setSetting(UMBREL_BACKUP_IGNORE_BACKFILL_KEY, new Date().toISOString());
    } else {
      log.warn(`Umbrel backupIgnore backfill incomplete for ${pending.join(", ")} — retrying next boot`);
    }
    if (updated.length > 0) log.info(`Added Umbrel backupIgnore patterns to backup excludes for: ${updated.join(", ")}`);
    return { ran: true, updated, pending };
  } catch (err: unknown) {
    log.warn("Umbrel backupIgnore backfill", err);
    return { ran: false, updated: [], pending: [] };
  }
}

// ── HTTPS access ─────────────────────────────────────────────────────────────

/**
 * Warnings an install result should carry about how the app can be reached —
 * currently: an app that requires HTTPS but has no TLS route. Empty for
 * everything else. Call after a successful install.
 */
export function getInstallAccessWarnings(appId: string, appName?: string): string[] {
  try {
    if (!appRequiresHttps(appId)) return [];
    const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
    const row = installed ? getCatalogRow(appId, installed.storeSourceId) : undefined;
    const warning = requiresHttpsInstallWarning(appId, appName ?? row?.name ?? appId, {
      webPort: row?.webPort ?? null,
      requiresHttps: true,
    });
    return warning ? [warning] : [];
  } catch {
    return [];
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
