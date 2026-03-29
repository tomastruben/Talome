import { exec as execCb, execSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join } from "node:path";
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

export async function discoverContainers(appId: string): Promise<string[]> {
  try {
    const containers = await listContainers();
    return containers
      .filter((c) => {
        const name = c.name.toLowerCase();
        const id = appId.toLowerCase();
        return name === id || name.startsWith(`${id}-`) || name.startsWith(`${id}_`);
      })
      .map((c) => c.id);
  } catch {
    return [];
  }
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
