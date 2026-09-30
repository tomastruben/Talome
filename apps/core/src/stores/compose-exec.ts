import { exec as execCb, execSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { basename, dirname, join } from "node:path";
import yaml from "js-yaml";
import { homedir } from "node:os";
import { listContainers } from "../docker/client.js";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";

const exec = promisify(execCb);

export const APP_DATA_DIR = join(homedir(), ".talome", "app-data");

// ── Environment helpers ───────────────────────────────────────────────────

export function getTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getUidGid(): { uid: string; gid: string } {
  try {
    const uid = execSync("id -u", { encoding: "utf-8" }).trim();
    const gid = execSync("id -g", { encoding: "utf-8" }).trim();
    return { uid, gid };
  } catch {
    return { uid: "1000", gid: "1000" };
  }
}

export function buildEnv(appId: string, userEnv: Record<string, string> = {}): Record<string, string> {
  const { uid, gid } = getUidGid();
  const dataDir = join(APP_DATA_DIR, appId);
  mkdirSync(dataDir, { recursive: true });

  return {
    ...process.env as Record<string, string>,
    PUID: uid,
    PGID: gid,
    TZ: getTimezone(),
    APP_DATA_DIR: dataDir,
    APP_ID: appId,
    AppID: appId,
    ...userEnv,
  };
}

export function writeAppDotEnv(appId: string, envOverrides: Record<string, string> = {}): void {
  const { uid, gid } = getUidGid();
  const dataDir = join(APP_DATA_DIR, appId);
  mkdirSync(dataDir, { recursive: true });

  const vars: Record<string, string> = {
    PUID: uid,
    PGID: gid,
    TZ: getTimezone(),
    APP_DATA_DIR: dataDir,
    APP_ID: appId,
    AppID: appId,
    ...envOverrides,
  };

  const lines = Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  atomicWriteFileSync(join(dataDir, ".env"), lines + "\n", "utf-8");
}

// ── Per-app compose lock ──────────────────────────────────────────────────
// Prevents concurrent compose modifications on the same app (e.g. setAppEnv
// racing with a restart, or two simultaneous installs).
// Uses a promise-chain pattern: each caller chains onto the previous holder's
// completion. The chain is extended synchronously (before any await), so there
// is no check-then-set race window.

const appLocks = new Map<string, Promise<void>>();

export async function withAppLock<T>(appId: string, fn: () => Promise<T>): Promise<T> {
  const prev = appLocks.get(appId) ?? Promise.resolve();

  let release: () => void;
  const myTurn = new Promise<void>((resolve) => { release = resolve; });
  // Chain synchronously: whoever calls withAppLock next will await myTurn
  const tail = prev.then(() => myTurn);
  appLocks.set(appId, tail);

  // Wait for previous holder to finish
  await prev;

  try {
    return await fn();
  } finally {
    release!();
    // Clean up only if nobody else has chained after us
    if (appLocks.get(appId) === tail) {
      appLocks.delete(appId);
    }
  }
}

// ── Shell execution ───────────────────────────────────────────────────────

export async function run(
  cmd: string,
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return exec(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeout ?? 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

/**
 * Validate a compose file before running `docker compose up`.
 * Catches YAML syntax errors, invalid service definitions, and missing
 * interpolation variables with clear error messages — much better than
 * the cryptic errors from a failed `up -d`.
 */
export async function validateCompose(
  composePath: string,
  opts: { cwd: string; env: Record<string, string> },
): Promise<{ valid: boolean; error?: string }> {
  try {
    await exec(`docker compose -f "${composePath}" config --quiet`, {
      cwd: opts.cwd,
      env: opts.env,
      timeout: 15_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return { valid: true };
  } catch (err: any) {
    const stderr = err?.stderr || err?.message || String(err);
    return { valid: false, error: stderr };
  }
}

// ── Compose path resolution ──────────────────────────────────────────────

/**
 * Resolve the effective compose file path for an installed app.
 * Priority: 1) override path from DB, 2) catalog path, 3) Docker label discovery.
 * Single source of truth — use this instead of ad-hoc lookups.
 */
export async function resolveComposePath(appId: string): Promise<string | null> {
  // 1. Check installed app's override path
  const installed = getInstalledApp(appId);
  if (installed?.overrideComposePath) return installed.overrideComposePath;

  // 2. Check catalog compose path
  if (installed) {
    const catalog = getCatalogApp(appId, installed.storeSourceId);
    if (catalog?.composePath) return catalog.composePath;
  }

  // 3. Discover from Docker container labels
  try {
    const containers = await listContainers();
    const match = containers.find((c) => {
      const service = c.labels["com.docker.compose.service"]?.toLowerCase();
      return service === appId.toLowerCase() || c.name.toLowerCase() === appId.toLowerCase();
    });
    if (match) {
      const configFiles = match.labels["com.docker.compose.project.config_files"];
      if (configFiles) {
        const path = configFiles.split(",")[0].trim();
        if (path) return path;
      }
    }
  } catch {
    // Discovery failed — non-fatal
  }

  return null;
}

// ── Container discovery ───────────────────────────────────────────────────
// Compose labels are authoritative: every container compose creates carries
// com.docker.compose.project (and config_files). Container names are not —
// compose files may set any container_name (user apps name containers after
// their services), so the name heuristic is only a last resort for containers
// that carry no compose labels at all.

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
export const COMPOSE_CONFIG_FILES_LABEL = "com.docker.compose.project.config_files";

/** Compose's normalisation of a project name (lowercase; only a-z, 0-9, "_" and "-"). */
export function normalizeComposeProjectName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "").replace(/^[^a-z0-9]+/, "");
}

/**
 * The project name `docker compose -f <composePath>` uses: the file's
 * top-level `name:` when set, otherwise its directory's name. Null when it
 * cannot be determined.
 */
export function composeFileProjectName(composePath: string): string | null {
  try {
    const doc = yaml.load(readFileSync(composePath, "utf-8")) as { name?: unknown } | null;
    if (doc && typeof doc.name === "string" && doc.name.trim() && !doc.name.includes("$")) {
      const named = normalizeComposeProjectName(doc.name);
      if (named) return named;
    }
  } catch {
    // Unreadable file — fall back to the directory name
  }
  const fromDir = normalizeComposeProjectName(basename(dirname(composePath)));
  return fromDir || null;
}

function nameMatchesAppId(name: string, appId: string): boolean {
  const n = name.toLowerCase();
  const id = appId.toLowerCase();
  return n === id || n.startsWith(`${id}-`) || n.startsWith(`${id}_`);
}

/** Project names an app's containers may carry (its id, and its compose file's project). */
export function appComposeProjects(appId: string, composePath?: string | null): Set<string> {
  const projects = new Set<string>();
  const fromId = normalizeComposeProjectName(appId);
  if (fromId) projects.add(fromId);
  if (composePath) {
    const fromFile = composeFileProjectName(composePath);
    if (fromFile) projects.add(fromFile);
  }
  return projects;
}

/** True when a container belongs to the app's compose project (labels only). */
export function isAppComposeContainer(
  container: { labels?: Record<string, string> },
  appId: string,
  composePath?: string | null,
  projects: Set<string> = appComposeProjects(appId, composePath),
): boolean {
  const labels = container.labels ?? {};
  const files = labels[COMPOSE_CONFIG_FILES_LABEL];
  if (composePath && files && files.split(",").map((f) => f.trim()).includes(composePath)) return true;
  const project = labels[COMPOSE_PROJECT_LABEL];
  return typeof project === "string" && projects.has(project);
}

/**
 * Pick an app's containers out of a listing: those of its compose project
 * (by label). With `strict: false` (the default), when no labelled container
 * exists, containers whose name is the app id or starts with it are accepted
 * (legacy/hand-started containers). Anything that removes containers must use
 * `strict: true`.
 */
export function selectComposeContainers<T extends { name: string; labels?: Record<string, string> }>(
  all: readonly T[],
  appId: string,
  composePath?: string | null,
  opts: { strict?: boolean } = {},
): T[] {
  const projects = appComposeProjects(appId, composePath);
  const labelled = all.filter((c) => isAppComposeContainer(c, appId, composePath, projects));
  if (labelled.length > 0 || opts.strict) return labelled;
  return all.filter((c) => {
    // A different compose project whose own name starts with the id
    // (plex → plex-meta-manager) is another app, whatever its containers are called.
    const otherProject = c.labels?.[COMPOSE_PROJECT_LABEL];
    if (otherProject && nameMatchesAppId(otherProject, appId)) return false;
    return nameMatchesAppId(c.name, appId);
  });
}

/** Ids of an app's containers (running or not), by compose project label. */
export async function discoverContainers(appId: string, composePath?: string | null): Promise<string[]> {
  try {
    const containers = await listContainers({ fresh: true });
    return selectComposeContainers(containers, appId, composePath).map((c) => c.id);
  } catch {
    return [];
  }
}

/**
 * The app's compose-project containers (strict: labels only), fresh from
 * Docker. Throws when Docker cannot be listed — callers deciding whether
 * containers are gone must not treat "unknown" as "none".
 */
export async function listProjectContainers(appId: string, composePath?: string | null) {
  const containers = await listContainers({ fresh: true });
  return selectComposeContainers(containers, appId, composePath, { strict: true });
}

// ── Docker Compose v2 availability ─────────────────────────────────────────

export const COMPOSE_MISSING_MESSAGE =
  "Docker Compose v2 plugin not found: `docker compose version` failed. Talome runs apps with `docker compose`; " +
  "install the Docker Compose v2 plugin (e.g. the docker-compose-plugin package, or Docker Desktop/OrbStack) and try again.";

const COMPOSE_PROBE_OK_TTL_MS = 10 * 60_000;
const COMPOSE_PROBE_FAIL_TTL_MS = 15_000;
let composeProbe: { at: number; result: { available: boolean; version?: string; error?: string } } | null = null;

/**
 * Whether the Docker Compose v2 plugin is usable (`docker compose version`).
 * Cached: a success for 10 minutes, a failure briefly (so installing the
 * plugin is picked up without a restart).
 */
export async function probeDockerCompose(opts: { fresh?: boolean } = {}): Promise<{ available: boolean; version?: string; error?: string }> {
  const now = Date.now();
  if (!opts.fresh && composeProbe) {
    const ttl = composeProbe.result.available ? COMPOSE_PROBE_OK_TTL_MS : COMPOSE_PROBE_FAIL_TTL_MS;
    if (now - composeProbe.at < ttl) return composeProbe.result;
  }
  let result: { available: boolean; version?: string; error?: string };
  try {
    const { stdout } = await exec("docker compose version --short", { timeout: 10_000, maxBuffer: 1024 * 1024 });
    result = { available: true, version: stdout.trim() };
  } catch (err: any) {
    result = { available: false, error: String(err?.stderr || err?.message || err).trim().slice(0, 500) };
  }
  composeProbe = { at: now, result };
  return result;
}

/** Test hook: forget the cached compose probe. */
export function __resetComposeProbeForTests(): void {
  composeProbe = null;
}

/**
 * True when a docker CLI error means the compose plugin itself is missing
 * (the classic `docker` CLI then parses `compose -f` as its own flags).
 */
export function isComposeMissingError(text: string): boolean {
  return /unknown shorthand flag: 'f' in -f/.test(text) ||
    /'compose' is not a docker command/i.test(text) ||
    /docker: unknown command: docker compose/i.test(text) ||
    /unknown command "compose" for "docker"/i.test(text);
}

// ── Image digest capture ──────────────────────────────────────────────────

export function captureImageDigest(composePath: string): { image: string | null; digest: string | null } {
  try {
    const result = execSync(
      `docker compose -f "${composePath}" images --format json 2>/dev/null`,
      { encoding: "utf-8", timeout: 10_000 },
    );
    const lines = result.trim().split("\n").filter(Boolean);
    if (lines.length > 0) {
      const first = JSON.parse(lines[0]);
      const image = first.ID || first.Repository || null;
      const repo = first.Repository;
      const tag = first.Tag || "latest";
      if (repo) {
        try {
          const inspectResult = execSync(
            `docker image inspect "${repo}:${tag}" --format "{{index .RepoDigests 0}}" 2>/dev/null`,
            { encoding: "utf-8", timeout: 5_000 },
          ).trim();
          const digestMatch = inspectResult.match(/sha256:[a-f0-9]{64}/);
          if (digestMatch) {
            return { image, digest: digestMatch[0] };
          }
        } catch {
          // Fallback to image ID
        }
      }
      return { image, digest: null };
    }
  } catch {
    // Best-effort
  }
  return { image: null, digest: null };
}

export function pinImageDigest(appId: string, composePath: string): void {
  try {
    const { digest } = captureImageDigest(composePath);
    if (digest) {
      db.update(schema.installedApps)
        .set({ imageDigest: digest })
        .where(eq(schema.installedApps.appId, appId))
        .run();
    }
  } catch {
    // Best-effort — don't fail the operation
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────

export function getCatalogApp(appId: string, storeSourceId: string) {
  return db
    .select()
    .from(schema.appCatalog)
    .where(
      and(
        eq(schema.appCatalog.appId, appId),
        eq(schema.appCatalog.storeSourceId, storeSourceId),
      ),
    )
    .get();
}

export function getInstalledApp(appId: string) {
  return db
    .select()
    .from(schema.installedApps)
    .where(eq(schema.installedApps.appId, appId))
    .get();
}

// Need `and` for getCatalogApp
import { and } from "drizzle-orm";
