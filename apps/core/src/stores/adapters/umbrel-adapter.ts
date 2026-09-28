import { readFileSync, existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import type { AppManifest, AppPort, AppEnvVar, AppVolume, StoreSource } from "@talome/types";
import { type StoreAdapter, inferMediaVolume, yieldToEventLoop, PARSE_YIELD_EVERY } from "./types.js";
import {
  scalarToString,
  UmbrelEnvironmentInputSchema,
  UmbrelFolderAccessSchema,
  UmbrelStorageSchema,
  type UmbrelEnvironmentInput,
  type UmbrelFolderAccess,
  type UmbrelV2Meta,
} from "../umbrel-v2.js";

// ── Docker Compose YAML interfaces ────────────────────────────────────────────

interface DockerComposeService {
  image?: string;
  ports?: Array<string | { published?: string | number; target?: string | number }>;
  volumes?: Array<string | { type?: string; source?: string; target?: string }>;
  environment?: Record<string, string | number | null> | string[];
  depends_on?: string[] | Record<string, unknown>;
  privileged?: boolean;
  network_mode?: string;
  [key: string]: unknown;
}

interface DockerComposeDocument {
  version?: string;
  services?: Record<string, DockerComposeService>;
  [key: string]: unknown;
}

// ── Umbrel manifest (lenient, Umbrel 2.0 aware) ────────────────────────────────

/** Fields Talome's base AppManifest consumes directly. */
interface UmbrelManifest {
  id: string;
  name?: string;
  version?: string;
  tagline?: string;
  description?: string;
  releaseNotes?: string;
  icon?: string;
  gallery?: string[];
  category?: string;
  developer?: string;
  submitter?: string;
  website?: string;
  repo?: string;
  support?: string;
  installNotes?: string;
  port?: number;
  dependencies?: string[];
  permissions?: string[];
  defaultUsername?: string;
  defaultPassword?: string;
}

const optionalString = z.preprocess(scalarToString, z.string());
const stringList = z.array(z.preprocess(scalarToString, z.string().min(1)));

/**
 * Per-field schemas. Each optional field is validated on its own so one bad
 * value only drops that field (with a warning) instead of the whole app.
 */
const UMBREL_FIELD_SCHEMAS: Record<string, z.ZodType> = {
  manifestVersion: optionalString,
  disabled: z.boolean(),
  name: optionalString,
  tagline: optionalString,
  icon: z.string(),
  category: optionalString,
  version: optionalString,
  port: z.preprocess(
    (v) => (typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : v),
    z.number().int().min(1).max(65535),
  ),
  description: optionalString,
  website: z.string(),
  developer: optionalString,
  submitter: optionalString,
  submission: z.string(),
  repo: z.string(),
  support: z.string(),
  gallery: z.array(z.unknown()).transform((items) => items.filter((g): g is string => typeof g === "string" && g.length > 0)),
  releaseNotes: optionalString,
  installNotes: optionalString,
  dependencies: stringList,
  permissions: stringList,
  path: z.string(),
  defaultUsername: optionalString,
  defaultPassword: optionalString,
  deterministicPassword: z.boolean(),
  optimizedForUmbrelHome: z.boolean(),
  torOnly: z.boolean(),
  requiresHttps: z.boolean(),
  nativeTlsHostnameSuffixes: z.array(z.string().min(1)),
  installSize: z.number().int().nonnegative(),
  widgets: z.array(z.unknown()),
  defaultShell: z.string(),
  implements: stringList,
  backupIgnore: z.array(z.string()),
  storage: UmbrelStorageSchema,
};

/** List fields whose items are validated individually. */
const UMBREL_ITEM_SCHEMAS = {
  folderAccess: UmbrelFolderAccessSchema,
  environment: UmbrelEnvironmentInputSchema,
} as const;

const V2_META_KEYS = [
  "manifestVersion", "disabled", "submitter", "submission", "path", "deterministicPassword",
  "optimizedForUmbrelHome", "torOnly", "requiresHttps", "nativeTlsHostnameSuffixes", "installSize",
  "widgets", "defaultShell", "implements", "backupIgnore", "storage", "permissions", "dependencies",
] as const;

export type UmbrelManifestParseResult =
  | { ok: true; manifest: UmbrelManifest; meta: UmbrelV2Meta; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid value";
  const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}

/**
 * Leniently parse an Umbrel `umbrel-app.yml` document (1.x or 2.0).
 * Only a missing/invalid `id` is fatal; invalid optional fields are dropped
 * with a warning and unknown fields are preserved in `meta.unknownFields`.
 */
export function parseUmbrelManifest(raw: unknown): UmbrelManifestParseResult {
  const warnings: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "manifest is not a YAML mapping", warnings };
  }
  const input = raw as Record<string, unknown>;

  const id = z.preprocess(scalarToString, z.string().trim().min(1)).safeParse(input.id);
  if (!id.success) return { ok: false, error: "manifest has no valid id", warnings };

  const fields: Record<string, unknown> = { id: id.data };
  const unknownFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (key === "id") continue;
    if (value === null || value === undefined) continue;

    if (key in UMBREL_ITEM_SCHEMAS) {
      const schema = UMBREL_ITEM_SCHEMAS[key as keyof typeof UMBREL_ITEM_SCHEMAS];
      if (!Array.isArray(value)) {
        warnings.push(`${key}: expected a list, field ignored`);
        continue;
      }
      const items: unknown[] = [];
      value.forEach((item, index) => {
        const parsed = schema.safeParse(item);
        if (parsed.success) items.push(parsed.data);
        else warnings.push(`${key}[${index}] ignored — ${describeIssue(parsed.error)}`);
      });
      if (items.length > 0) fields[key] = items;
      continue;
    }

    const schema = UMBREL_FIELD_SCHEMAS[key];
    if (!schema) {
      unknownFields[key] = value;
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) fields[key] = parsed.data;
    else warnings.push(`${key} ignored — ${describeIssue(parsed.error)}`);
  }

  const meta: UmbrelV2Meta = {};
  for (const key of V2_META_KEYS) {
    if (fields[key] !== undefined) (meta as Record<string, unknown>)[key] = fields[key];
  }
  if (fields.folderAccess) meta.folderAccess = fields.folderAccess as UmbrelFolderAccess[];
  if (fields.environment) meta.environment = fields.environment as UmbrelEnvironmentInput[];
  if (Object.keys(unknownFields).length > 0) meta.unknownFields = unknownFields;
  if (warnings.length > 0) meta.warnings = warnings;

  return { ok: true, manifest: fields as unknown as UmbrelManifest, meta, warnings };
}

/** True when the parsed metadata carries anything worth persisting. */
function hasMeta(meta: UmbrelV2Meta): boolean {
  return Object.keys(meta).length > 0;
}

/** AppManifest plus the Umbrel 2.0 metadata persisted in app_catalog.umbrel_meta. */
export type UmbrelAppManifest = AppManifest & { umbrelMeta?: UmbrelV2Meta };

const UMBREL_OFFICIAL_REPO = "https://github.com/getumbrel/umbrel-apps.git";
const UMBREL_GALLERY_BASE = "https://raw.githubusercontent.com/getumbrel/umbrel-apps-gallery/master";

function isUmbrelAppDir(dirPath: string): boolean {
  return existsSync(join(dirPath, "umbrel-app.yml"));
}

function isUmbrelOfficialSource(source?: StoreSource): boolean {
  if (!source?.gitUrl) return false;
  return source.gitUrl.replace(/\.git$/, "") === UMBREL_OFFICIAL_REPO.replace(/\.git$/, "");
}

function resolveUmbrelAssetUrl(
  appDir: string,
  appId: string,
  asset: string | undefined,
  isOfficial: boolean,
  hasFile: (relPath: string) => boolean,
): string | undefined {
  if (!asset || typeof asset !== "string") return undefined;
  if (asset.startsWith("http://") || asset.startsWith("https://")) return asset;
  if (isOfficial) return `${UMBREL_GALLERY_BASE}/${appId}/${asset}`;
  const localPath = join(appDir, asset);
  return hasFile(asset) ? `/api/apps/store-asset?path=${encodeURIComponent(localPath)}` : undefined;
}

function parsePorts(compose: DockerComposeDocument): AppPort[] {
  const ports: AppPort[] = [];
  if (!compose?.services) return ports;

  for (const [name, s] of Object.entries(compose.services)) {
    if (name === "app_proxy") continue;
    if (!s.ports) continue;

    for (const p of s.ports) {
      if (typeof p === "string") {
        const match = p.match(/^(\d+):(\d+)/);
        if (match) {
          ports.push({ host: parseInt(match[1]), container: parseInt(match[2]) });
        }
      } else if (typeof p === "object" && p.published && p.target) {
        const host = parseInt(String(p.published));
        const container = parseInt(String(p.target));
        if (!isNaN(host) && !isNaN(container)) {
          ports.push({ host, container });
        }
      }
    }
  }
  return ports;
}

function parseVolumes(compose: DockerComposeDocument): AppVolume[] {
  const volumes: AppVolume[] = [];
  if (!compose?.services) return volumes;

  for (const [name, s] of Object.entries(compose.services)) {
    if (name === "app_proxy") continue;
    if (!s.volumes) continue;

    for (const v of s.volumes) {
      if (typeof v === "string") {
        const parts = v.split(":");
        if (parts.length >= 2) {
          const containerPath = parts[1];
          volumes.push({
            name: parts[0].replace(/.*\//, ""),
            containerPath,
            mediaVolume: inferMediaVolume(containerPath),
          });
        }
      }
    }
  }
  return volumes;
}

/** Umbrel platform vars auto-generated at install time — never expose to the user. */
const UMBREL_PLATFORM_VARS = new Set([
  "APP_PASSWORD", "APP_SEED", "APP_DATA_DIR", "APP_ID", "AppID",
  "DEVICE_DOMAIN_NAME", "DEVICE_HOSTNAME",
  "UMBREL_ROOT", "TOR_DATA_DIR", "TOR_PROXY_IP", "TOR_PROXY_PORT",
  // Bitcoin/Lightning node vars — injected by Umbrel orchestrator
  "APP_BITCOIN_NETWORK", "APP_BITCOIN_NODE_IP", "APP_BITCOIN_RPC_PORT",
  "APP_BITCOIN_RPC_USER", "APP_BITCOIN_RPC_PASS",
  "APP_LIGHTNING_NODE_IP", "APP_LIGHTNING_NODE_DATA_DIR",
  "APP_LIGHTNING_NODE_GRPC_PORT", "APP_LIGHTNING_NODE_REST_PORT",
  "CORE_LIGHTNING_PATH", "APP_CORE_LIGHTNING_BITCOIN_NETWORK",
]);

/** Check if a string value is a compose interpolation reference like ${VAR} */
function isInterpolation(val: string): string | null {
  const m = val.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  return m ? m[1] : null;
}

function parseEnvVars(compose: DockerComposeDocument): AppEnvVar[] {
  const envVars: AppEnvVar[] = [];
  const seen = new Set<string>();
  if (!compose?.services) return envVars;

  for (const [name, s] of Object.entries(compose.services)) {
    if (name === "app_proxy") continue;
    if (!s.environment) continue;

    const env = s.environment;
    if (typeof env === "object" && !Array.isArray(env)) {
      for (const [key, val] of Object.entries(env)) {
        if (seen.has(key)) continue;
        if (key.startsWith("APP_") || key.startsWith("$")) continue;
        seen.add(key);

        const strVal = val != null ? String(val) : undefined;
        // Detect ${VAR} interpolation — not a real default
        const isRef = strVal ? isInterpolation(strVal) : null;

        envVars.push({
          key,
          label: key,
          required: false,
          default: isRef ? undefined : strVal,
        });
      }
    }
  }
  return envVars;
}

/**
 * Scan the entire compose for ${VAR} interpolation references.
 * Returns unique variable names that are NOT built-in platform vars.
 */
function parseComposeInterpolationVars(compose: DockerComposeDocument): string[] {
  const vars = new Set<string>();
  const raw = JSON.stringify(compose);
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (!UMBREL_PLATFORM_VARS.has(m[1])) {
      vars.add(m[1]);
    }
  }
  return [...vars];
}

function getMainImage(compose: DockerComposeDocument): string | undefined {
  if (!compose?.services) return undefined;
  for (const [name, s] of Object.entries(compose.services)) {
    if (name === "app_proxy") continue;
    if (s.image) return s.image.split("@")[0];
  }
  return undefined;
}

function parseUmbrelPermissions(permissions: unknown, compose: DockerComposeDocument | null): AppManifest["permissions"] | undefined {
  const result: NonNullable<AppManifest["permissions"]> = {};
  let hasAny = false;

  // Parse Umbrel permissions array (e.g. ["STORAGE_DOWNLOADS", "GPU"])
  if (Array.isArray(permissions)) {
    for (const p of permissions) {
      if (typeof p !== "string") continue;
      const upper = p.toUpperCase();
      if (upper === "GPU" || upper.includes("GPU")) {
        result.gpu = true;
        hasAny = true;
      }
      if (upper.startsWith("STORAGE_")) {
        if (!result.storageAccess) result.storageAccess = [];
        result.storageAccess.push(p);
        hasAny = true;
      }
    }
  }

  // Detect privileged/network_mode from compose
  if (compose?.services) {
    for (const svc of Object.values(compose.services)) {
      if (svc?.privileged) {
        result.privileged = true;
        hasAny = true;
      }
      if (svc?.network_mode === "host") {
        result.networkMode = "host";
        hasAny = true;
      }
    }
  }

  return hasAny ? result : undefined;
}

// ── Per-app builder (shared by sync + async parsing) ─────────────────────────

export interface UmbrelAppInput {
  /** Directory name inside the store. */
  entry: string;
  appDir: string;
  /** File names present directly inside appDir. */
  files: ReadonlySet<string>;
  manifestText: string | null;
  composeText: string | null;
  storeId: string;
  isOfficial: boolean;
}

export type UmbrelAppBuildResult =
  | { ok: true; manifest: UmbrelAppManifest; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

/** Build a Talome manifest from one Umbrel app directory's already-read files. */
export function buildUmbrelApp(input: UmbrelAppInput): UmbrelAppBuildResult {
  const { entry, appDir, files, storeId, isOfficial } = input;
  if (input.manifestText === null) return { ok: false, error: "umbrel-app.yml unreadable", warnings: [] };

  let rawManifest: unknown;
  try {
    rawManifest = yaml.load(input.manifestText);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return { ok: false, error: `umbrel-app.yml is not valid YAML: ${message}`, warnings: [] };
  }

  const parsed = parseUmbrelManifest(rawManifest);
  if (!parsed.ok) return parsed;
  const raw = parsed.manifest;
  const warnings = [...parsed.warnings];

  const composePath = join(appDir, "docker-compose.yml");
  let compose: DockerComposeDocument | null = null;
  if (input.composeText !== null) {
    try {
      const loaded = yaml.load(input.composeText);
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
        compose = loaded as DockerComposeDocument;
      } else {
        warnings.push("docker-compose.yml is not a mapping");
      }
    } catch {
      // compose parse failure is non-fatal
      warnings.push("docker-compose.yml is not valid YAML");
    }
  }

  const ports = compose ? parsePorts(compose) : [];
  const volumes = compose ? parseVolumes(compose) : [];
  const envVars = compose ? parseEnvVars(compose) : [];
  const image = compose ? getMainImage(compose) : undefined;

  const hasFile = (relPath: string): boolean =>
    relPath.includes("/") ? existsSync(join(appDir, relPath)) : files.has(relPath);

  const gallery: string[] = [];
  for (const g of raw.gallery ?? []) {
    const resolved = resolveUmbrelAssetUrl(appDir, raw.id, g, isOfficial, hasFile);
    if (resolved) gallery.push(resolved);
  }

  let iconUrl: string | undefined;
  if (typeof raw.icon === "string" && raw.icon.length > 0) {
    iconUrl = resolveUmbrelAssetUrl(appDir, raw.id, raw.icon, isOfficial, hasFile);
  } else if (isOfficial) {
    iconUrl = `${UMBREL_GALLERY_BASE}/${raw.id}/icon.svg`;
  } else {
    const localIconCandidates = ["icon.svg", "icon.png", "icon.jpg"];
    for (const candidate of localIconCandidates) {
      if (files.has(candidate)) {
        iconUrl = `/api/apps/store-asset?path=${encodeURIComponent(join(appDir, candidate))}`;
        break;
      }
    }
  }

  const webPort = raw.port ?? ports[0]?.host;
  const umbrelMeta = parsed.meta;

  const manifest: UmbrelAppManifest = {
    id: raw.id,
    name: raw.name || entry,
    version: raw.version || "latest",
    tagline: raw.tagline || "",
    description: raw.description || "",
    releaseNotes: raw.releaseNotes || undefined,
    icon: "📦",
    iconUrl,
    screenshots: gallery.length > 0 ? gallery : undefined,
    coverUrl: gallery[0],
    category: (raw.category || "other").toLowerCase(),
    author: raw.developer || raw.submitter || "Unknown",
    website: raw.website,
    repo: raw.repo,
    support: raw.support,
    installNotes: raw.installNotes || undefined,
    source: "umbrel",
    storeId,
    composePath,
    image,
    ports,
    volumes,
    env: envVars,
    dependencies: raw.dependencies?.length ? raw.dependencies : undefined,
    permissions: parseUmbrelPermissions(raw.permissions, compose),
    defaultUsername: raw.defaultUsername || undefined,
    defaultPassword: raw.defaultPassword || undefined,
    webPort: webPort !== undefined && !isNaN(webPort) ? webPort : undefined,
    ...(hasMeta(umbrelMeta) ? { umbrelMeta } : {}),
  };

  return { ok: true, manifest, warnings };
}

/** Result of reading every app directory in a store (used by the compat report). */
export interface UmbrelStoreScanEntry {
  entry: string;
  appDir: string;
  result: UmbrelAppBuildResult;
}

async function isDirectoryEntry(storePath: string, dirent: Dirent): Promise<boolean> {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return (await stat(join(storePath, dirent.name))).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Asynchronously scan an Umbrel store, yielding to the event loop every few
 * apps so a ~700-app catalog never blocks the server.
 */
export async function scanUmbrelStore(
  storePath: string,
  storeId: string,
  source?: StoreSource,
): Promise<UmbrelStoreScanEntry[]> {
  const isOfficial = isUmbrelOfficialSource(source);
  let entries: Dirent[];
  try {
    entries = await readdir(storePath, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const out: UmbrelStoreScanEntry[] = [];
  let processed = 0;
  for (const dirent of entries) {
    if (++processed % PARSE_YIELD_EVERY === 0) await yieldToEventLoop();
    if (dirent.name.startsWith(".")) continue;
    if (!(await isDirectoryEntry(storePath, dirent))) continue;

    const appDir = join(storePath, dirent.name);
    let fileList: string[];
    try {
      fileList = await readdir(appDir);
    } catch {
      continue;
    }
    const files = new Set(fileList);
    if (!files.has("umbrel-app.yml")) continue;

    const manifestText = await readFile(join(appDir, "umbrel-app.yml"), "utf-8").catch(() => null);
    const composeText = files.has("docker-compose.yml")
      ? await readFile(join(appDir, "docker-compose.yml"), "utf-8").catch(() => null)
      : null;

    out.push({
      entry: dirent.name,
      appDir,
      result: buildUmbrelApp({ entry: dirent.name, appDir, files, manifestText, composeText, storeId, isOfficial }),
    });
  }
  return out;
}

function readTextSync(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export const umbrelAdapter: StoreAdapter = {
  type: "umbrel",

  detect(storePath: string): boolean {
    if (existsSync(join(storePath, "umbrel-app-store.yml"))) return true;

    // Official umbrel-apps repo doesn't have umbrel-app-store.yml at root
    // but contains app dirs with umbrel-app.yml inside
    try {
      const entries = readdirSync(storePath);
      let umbrelAppCount = 0;
      for (const entry of entries.slice(0, 20)) {
        const full = join(storePath, entry);
        if (statSync(full).isDirectory() && isUmbrelAppDir(full)) {
          umbrelAppCount++;
          if (umbrelAppCount >= 3) return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  },

  parse(storePath: string, storeId: string, source?: StoreSource): AppManifest[] {
    const results: AppManifest[] = [];
    let entries: string[];
    const isOfficial = isUmbrelOfficialSource(source);

    try {
      entries = readdirSync(storePath).sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }

    for (const entry of entries) {
      try {
        if (entry.startsWith(".")) continue;
        const appDir = join(storePath, entry);
        if (!statSync(appDir).isDirectory()) continue;

        const files = new Set(readdirSync(appDir));
        if (!files.has("umbrel-app.yml")) continue;

        const result = buildUmbrelApp({
          entry,
          appDir,
          files,
          manifestText: readTextSync(join(appDir, "umbrel-app.yml")),
          composeText: files.has("docker-compose.yml") ? readTextSync(join(appDir, "docker-compose.yml")) : null,
          storeId,
          isOfficial,
        });
        if (result.ok) results.push(result.manifest);
      } catch {
        // Skip malformed apps
      }
    }

    return results;
  },

  async parseAsync(storePath: string, storeId: string, source?: StoreSource): Promise<AppManifest[]> {
    const scanned = await scanUmbrelStore(storePath, storeId, source);
    const results: AppManifest[] = [];
    for (const { result } of scanned) {
      if (result.ok) results.push(result.manifest);
    }
    return results;
  },
};
