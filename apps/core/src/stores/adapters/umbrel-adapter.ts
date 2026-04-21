import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import type { AppManifest, AppPort, AppEnvVar, AppVolume, StoreSource } from "@talome/types";
import { type StoreAdapter, inferMediaVolume } from "./types.js";

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

interface UmbrelManifest {
  id?: string;
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
  port?: number | string;
  dependencies?: string[];
  permissions?: unknown;
  defaultUsername?: string;
  defaultPassword?: string;
}

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
): string | undefined {
  if (!asset || typeof asset !== "string") return undefined;
  if (asset.startsWith("http://") || asset.startsWith("https://")) return asset;
  if (isOfficial) return `${UMBREL_GALLERY_BASE}/${appId}/${asset}`;
  const localPath = join(appDir, asset);
  return existsSync(localPath) ? `/api/apps/store-asset?path=${encodeURIComponent(localPath)}` : undefined;
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
      entries = readdirSync(storePath);
    } catch {
      return [];
    }

    for (const entry of entries) {
      try {
        const appDir = join(storePath, entry);
        if (!statSync(appDir).isDirectory()) continue;

        const manifestPath = join(appDir, "umbrel-app.yml");
        if (!existsSync(manifestPath)) continue;

        const raw = yaml.load(readFileSync(manifestPath, "utf-8")) as UmbrelManifest;
        if (!raw?.id) continue;

        const composePath = join(appDir, "docker-compose.yml");
        let compose: DockerComposeDocument | null = null;
        if (existsSync(composePath)) {
          try {
            compose = yaml.load(readFileSync(composePath, "utf-8")) as DockerComposeDocument;
          } catch { /* compose parse failure is non-fatal */ }
        }

        const ports = compose ? parsePorts(compose) : [];
        const volumes = compose ? parseVolumes(compose) : [];
        const envVars = compose ? parseEnvVars(compose) : [];
        const image = compose ? getMainImage(compose) : undefined;

        const gallery: string[] = [];
        if (raw.gallery) {
          for (const g of raw.gallery) {
            if (typeof g === "string") {
              const resolved = resolveUmbrelAssetUrl(appDir, raw.id, g, isOfficial);
              if (resolved) gallery.push(resolved);
            }
          }
        }

        let iconUrl: string | undefined;
        if (typeof raw.icon === "string" && raw.icon.length > 0) {
          iconUrl = resolveUmbrelAssetUrl(appDir, raw.id, raw.icon, isOfficial);
        } else if (isOfficial) {
          iconUrl = `${UMBREL_GALLERY_BASE}/${raw.id}/icon.svg`;
        } else {
          const localIconCandidates = ["icon.svg", "icon.png", "icon.jpg"];
          for (const candidate of localIconCandidates) {
            const candidatePath = join(appDir, candidate);
            if (existsSync(candidatePath)) {
              iconUrl = `/api/apps/store-asset?path=${encodeURIComponent(candidatePath)}`;
              break;
            }
          }
        }

        const webPort = raw.port ? parseInt(String(raw.port)) : ports[0]?.host;

        results.push({
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
          webPort: !isNaN(webPort) ? webPort : undefined,
        });
      } catch {
        // Skip malformed apps
      }
    }

    return results;
  },
};
