/**
 * Compose parsing for backups: resolves bind-mount volumes (with ${VAR}
 * interpolation), classifies them, and recognises database services whose
 * data can be captured with a logical dump.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { eq, and } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { DbEngine } from "./types.js";
import { isWithin } from "./fs-utils.js";

export interface ComposeVolume {
  service: string;
  /** Source as written in the compose file */
  raw: string;
  /** Resolved absolute host path (bind mounts only) */
  hostPath: string | null;
  target: string;
  kind: "bind" | "named";
  readOnly: boolean;
  /** "config" = app data (under the compose dir, the app data dir or the app's chosen data root), "media" = anything else */
  type: "config" | "media";
  exists: boolean;
}

export interface ComposeService {
  name: string;
  image: string | null;
  containerName: string | null;
  environment: Record<string, string>;
  volumes: ComposeVolume[];
  dbEngine: DbEngine | null;
  /** Host paths of volumes that hold the database's raw data files */
  dbDataPaths: string[];
}

export interface ParsedCompose {
  projectName: string | null;
  services: ComposeService[];
}

export interface AppContext {
  appId: string;
  appName: string;
  version: string | null;
  storeSourceId: string | null;
  composePath: string;
  /** True when the compose file is Talome's per-app override (safe to rewrite on restore) */
  composeIsOverride: boolean;
  composeDir: string;
  /** Talome's per-app data dir (${APP_DATA_DIR} in Umbrel-style composes) */
  appDataDir: string;
  /**
   * Host folder chosen at install time for an Umbrel app's data root
   * (`storage.dataRoot`: ${APP_DATA_DIR}/data moved elsewhere), or null.
   * It holds the app's primary data, so it is app data — not media.
   */
  dataRootDir: string | null;
  env: Record<string, string>;
  envOverrides: Record<string, string>;
  compose: ParsedCompose;
}

const SYSTEM_PREFIXES = ["/var/run", "/run", "/etc", "/proc", "/sys", "/dev", "/lib/modules", "/boot"];

export function getAppDataBaseDir(): string {
  return join(homedir(), ".talome", "app-data");
}

// ── Interpolation ───────────────────────────────────────────────────────────

/** Docker-compose style variable interpolation (${VAR}, ${VAR:-def}, ${VAR-def}, $VAR, $$). */
export function interpolate(value: string, env: Record<string, string | undefined>): string {
  return value.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-?+])([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, op, arg, bare) => {
    if (match === "$$") return "$";
    const name = (braced ?? bare) as string;
    const current = env[name];
    if (!op) return current ?? "";
    const val = arg as string;
    switch (op) {
      case ":-":
        return current ? current : val;
      case "-":
        return current !== undefined ? current : val;
      case ":+":
        return current ? val : "";
      case "+":
        return current !== undefined ? val : "";
      default:
        // ? / :? (required) — fall back to empty rather than failing a backup
        return current ?? "";
    }
  });
}

export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).replace(/^export\s+/, "").trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// ── Database detection ──────────────────────────────────────────────────────

function imageRepoName(image: string): string {
  // strip digest and tag, keep the last path component
  const noDigest = image.split("@")[0];
  const lastSlash = noDigest.lastIndexOf("/");
  const lastColon = noDigest.lastIndexOf(":");
  const repo = lastColon > lastSlash ? noDigest.slice(0, lastColon) : noDigest;
  return repo.toLowerCase();
}

/**
 * Images that work WITH a database but are not one: metrics exporters,
 * backup/dump jobs, poolers, admin UIs, upgrade helpers
 * (prometheuscommunity/postgres-exporter, prodrigestivill/postgres-backup-local,
 * tianon/postgres-upgrade, …). Dumping them fails and would fail every backup.
 */
const DB_SIDECAR_WORD = /(^|[-_.])(exporter|backups?|dump(er)?|restore|admin|metrics|monitor(ing)?|operator|proxy|pooler|bouncer|upgrade|migrate|migrations?|cli|client|tools?)([-_.]|$)/;

export function detectDbEngine(image: string | null | undefined): DbEngine | null {
  return detectDbEngineDetailed(image)?.engine ?? null;
}

/** `exact`: a well-known database image name (not just a name containing "postgres"). */
function detectDbEngineDetailed(image: string | null | undefined): { engine: DbEngine; exact: boolean } | null {
  if (!image) return null;
  const repo = imageRepoName(image);
  const last = repo.split("/").pop() ?? repo;
  if (/^(postgres|postgresql|postgis|timescaledb(-ha)?|pgvecto-rs|pgvector|pgvecto\.rs)$/.test(last)) return { engine: "postgres", exact: true };
  if (/^(mariadb|mysql|mysql-server|percona|percona-server)$/.test(last)) return { engine: "mysql", exact: true };
  if (/^(redis|valkey|keydb|redis-stack|redis-stack-server)$/.test(last)) return { engine: "redis", exact: true };
  if (DB_SIDECAR_WORD.test(last)) return null;
  if (repo.includes("immich-app/postgres")) return { engine: "postgres", exact: true };
  if (/(^|[-_])postgres(ql)?([-_]|$)/.test(last)) return { engine: "postgres", exact: false };
  return null;
}

function isDbDataTarget(engine: DbEngine, target: string, env: Record<string, string>, image: string | null): boolean {
  const t = target.replace(/\/+$/, "");
  if (engine === "postgres") {
    const pgdata = env.PGDATA?.replace(/\/+$/, "");
    if (pgdata && (t === pgdata || pgdata.startsWith(`${t}/`))) return true;
    return (
      t === "/var/lib/postgresql" ||
      t.startsWith("/var/lib/postgresql/") ||
      t === "/bitnami/postgresql" ||
      t === "/home/postgres/pgdata"
    );
  }
  if (engine === "mysql") {
    if (t === "/var/lib/mysql" || t.startsWith("/var/lib/mysql/") || t === "/bitnami/mariadb" || t === "/bitnami/mysql") return true;
    // linuxserver/mariadb keeps its databases under /config
    return t === "/config" && !!image && imageRepoName(image).includes("linuxserver/mariadb");
  }
  return false;
}

// ── Parsing ─────────────────────────────────────────────────────────────────

function normalizeEnvironment(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "string") continue;
      const idx = item.indexOf("=");
      if (idx > 0) out[item.slice(0, idx)] = item.slice(idx + 1);
    }
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      out[k] = String(v);
    }
  }
  return out;
}

function isSystemPath(p: string): boolean {
  if (p.endsWith("docker.sock")) return true;
  return SYSTEM_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

export interface ParseComposeOptions {
  composeDir: string;
  appDataDir: string;
  /** The app's chosen data root (Umbrel storage.dataRoot), classified as app data */
  dataRootDir?: string | null;
  env: Record<string, string>;
}

export function parseCompose(content: string, opts: ParseComposeOptions): ParsedCompose {
  const doc = (parseYaml(content) ?? {}) as Record<string, unknown>;
  const servicesRaw = (doc.services ?? {}) as Record<string, Record<string, unknown> | null>;
  const services: ComposeService[] = [];
  const seenHostPaths = new Set<string>();

  for (const [name, svcRaw] of Object.entries(servicesRaw)) {
    const svc = svcRaw ?? {};
    const image = typeof svc.image === "string" ? interpolate(svc.image, opts.env) : null;
    const environment = normalizeEnvironment(svc.environment);
    for (const [k, v] of Object.entries(environment)) environment[k] = interpolate(v, opts.env);
    const detected = detectDbEngineDetailed(image);
    let dbEngine = detected?.engine ?? null;
    const volumes: ComposeVolume[] = [];
    const dbDataPaths: string[] = [];
    let hasDataTarget = false;

    for (const vol of (Array.isArray(svc.volumes) ? svc.volumes : []) as unknown[]) {
      let raw: string;
      let target = "";
      let readOnly = false;
      let explicitType: string | null = null;
      if (typeof vol === "string") {
        const parts = vol.split(":");
        if (parts.length < 2) continue; // anonymous volume
        raw = parts[0];
        target = parts[1];
        readOnly = parts.slice(2).some((p) => p.split(",").includes("ro"));
      } else if (vol && typeof vol === "object") {
        const v = vol as Record<string, unknown>;
        if (typeof v.source !== "string" || !v.source) continue;
        raw = v.source;
        target = typeof v.target === "string" ? v.target : "";
        readOnly = v.read_only === true;
        explicitType = typeof v.type === "string" ? v.type : null;
        if (explicitType === "tmpfs" || explicitType === "npipe") continue;
      } else {
        continue;
      }

      let source = interpolate(raw, opts.env).trim();
      if (source.startsWith("~")) source = join(homedir(), source.slice(1));
      const isBind =
        explicitType === "bind" || source.startsWith("/") || source.startsWith(".") || (explicitType !== "volume" && source.includes("/"));
      if (dbEngine && isDbDataTarget(dbEngine, target, environment, image)) hasDataTarget = true;
      if (!isBind) {
        volumes.push({ service: name, raw, hostPath: null, target, kind: "named", readOnly, type: "config", exists: false });
        continue;
      }
      const hostPath = resolve(opts.composeDir, source);
      if (isSystemPath(hostPath)) continue;
      const type =
        isWithin(opts.composeDir, hostPath) || isWithin(opts.appDataDir, hostPath) || (opts.dataRootDir ? isWithin(opts.dataRootDir, hostPath) : false)
          ? "config"
          : "media";
      const entry: ComposeVolume = {
        service: name,
        raw,
        hostPath,
        target,
        kind: "bind",
        readOnly,
        type,
        exists: existsSync(hostPath),
      };
      if (dbEngine && isDbDataTarget(dbEngine, target, environment, image)) dbDataPaths.push(hostPath);
      if (seenHostPaths.has(hostPath)) {
        // Same host path mounted twice — keep the first mapping only
        continue;
      }
      seenHostPaths.add(hostPath);
      volumes.push(entry);
    }

    // A name that merely contains "postgres" counts as a database only when it
    // keeps database data (a volume at the data directory)
    if (detected && !detected.exact && !hasDataTarget) {
      dbEngine = null;
      dbDataPaths.length = 0;
    }
    services.push({
      name,
      image,
      containerName: typeof svc.container_name === "string" ? interpolate(svc.container_name, opts.env) : null,
      environment,
      volumes,
      dbEngine,
      dbDataPaths,
    });
  }

  return { projectName: typeof doc.name === "string" ? doc.name : null, services };
}

/**
 * True when a SQL database service keeps its data neither in a bind mount nor
 * in a named volume at its data directory — i.e. only in an anonymous volume
 * (the image's VOLUME) or the container's own layer. That data survives a
 * stop/start, but not the container being removed (`docker compose down`,
 * a re-created container without its anonymous volumes).
 */
export function dbDataIsEphemeral(svc: ComposeService): boolean {
  if (svc.dbEngine !== "postgres" && svc.dbEngine !== "mysql") return false;
  if (svc.dbDataPaths.length > 0) return false;
  const engine = svc.dbEngine;
  return !svc.volumes.some((v) => v.kind === "named" && isDbDataTarget(engine, v.target, svc.environment, svc.image));
}

/** Text every ephemeral-database warning contains (to pick them out of a warning list). */
export const EPHEMERAL_DB_WARNING_MARK = "keeps its data only in an anonymous Docker volume";

/** Warning for a database whose data lives only in an anonymous volume. */
export function ephemeralDbWarning(svc: Pick<ComposeService, "name">): string {
  return (
    `The ${svc.name} database ${EPHEMERAL_DB_WARNING_MARK}: it is lost whenever the container is removed ` +
    `(e.g. docker compose down). Add a named volume or a folder for its data directory to the compose file.`
  );
}

/** All bind volumes of the app, de-duplicated. */
export function bindVolumes(compose: ParsedCompose): ComposeVolume[] {
  return compose.services.flatMap((s) => s.volumes.filter((v) => v.kind === "bind" && v.hostPath));
}

// ── App context ─────────────────────────────────────────────────────────────

/**
 * The data root folder an Umbrel app was installed with (app_install_options
 * plan, written by stores/umbrel-v2-install.ts), or null. Missing table (older
 * database, MCP stdio before migrations) or unreadable JSON → null.
 */
export function readAppDataRoot(appId: string): string | null {
  try {
    const row = db
      .select({ plan: schema.appInstallOptions.plan })
      .from(schema.appInstallOptions)
      .where(eq(schema.appInstallOptions.appId, appId))
      .get();
    if (!row) return null;
    const plan = JSON.parse(row.plan) as { dataRoot?: { hostPath?: unknown } } | null;
    const hostPath = plan?.dataRoot?.hostPath;
    if (typeof hostPath !== "string" || !isAbsolute(hostPath)) return null;
    const resolved = resolve(hostPath);
    // Never let a broad folder turn every bind mount (media, system paths) into app data
    return resolved === "/" || resolved === homedir() ? null : resolved;
  } catch {
    return null;
  }
}

export type AppContextResult = { ok: true; ctx: AppContext } | { ok: false; error: string };

export function resolveAppContext(appId: string): AppContextResult {
  const installed = db.select().from(schema.installedApps).where(eq(schema.installedApps.appId, appId)).get();
  if (!installed) return { ok: false, error: `App '${appId}' is not installed.` };
  const catalog = db
    .select()
    .from(schema.appCatalog)
    .where(and(eq(schema.appCatalog.appId, appId), eq(schema.appCatalog.storeSourceId, installed.storeSourceId)))
    .get();
  const composePath = installed.overrideComposePath ?? catalog?.composePath ?? null;
  if (!composePath || !existsSync(composePath)) {
    return { ok: false, error: `Compose file for '${appId}' not found.` };
  }
  let envOverrides: Record<string, string> = {};
  try {
    envOverrides = JSON.parse(installed.envConfig) as Record<string, string>;
  } catch {
    envOverrides = {};
  }
  const composeDir = dirname(composePath);
  const appDataDir = join(getAppDataBaseDir(), appId);
  let dotEnv: Record<string, string> = {};
  const dotEnvPath = join(composeDir, ".env");
  if (existsSync(dotEnvPath)) {
    try {
      dotEnv = parseDotEnv(readFileSync(dotEnvPath, "utf-8"));
    } catch {
      dotEnv = {};
    }
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    APP_DATA_DIR: appDataDir,
    APP_ID: appId,
    AppID: appId,
    ...dotEnv,
    ...envOverrides,
  };
  const dataRootDir = readAppDataRoot(appId);
  let compose: ParsedCompose;
  try {
    compose = parseCompose(readFileSync(composePath, "utf-8"), { composeDir, appDataDir, dataRootDir, env });
  } catch (err) {
    return { ok: false, error: `Could not parse compose file: ${err instanceof Error ? err.message : String(err)}` };
  }
  return {
    ok: true,
    ctx: {
      appId,
      appName: installed.displayName ?? catalog?.name ?? appId,
      version: installed.version ?? null,
      storeSourceId: installed.storeSourceId ?? null,
      composePath,
      composeIsOverride: installed.overrideComposePath === composePath,
      composeDir,
      appDataDir,
      dataRootDir,
      env,
      envOverrides,
      compose,
    },
  };
}
