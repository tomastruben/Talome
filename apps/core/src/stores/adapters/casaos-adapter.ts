import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import yaml from "js-yaml";
import type { AppManifest, AppPort, AppEnvVar, AppVolume } from "@talome/types";
import { type StoreAdapter, inferMediaVolume } from "./types.js";

// ── Docker Compose YAML interfaces ────────────────────────────────────────────

interface DockerComposeService {
  image?: string;
  ports?: Array<string | { published?: string | number; target?: string | number }>;
  volumes?: Array<string | { type?: string; source?: string; target?: string }>;
  environment?: Record<string, string | number | null> | string[];
  privileged?: boolean;
  network_mode?: string;
  runtime?: string;
  devices?: string[];
  deploy?: { resources?: { reservations?: { devices?: Array<{ capabilities?: string[]; driver?: string }> } } };
  "x-casaos"?: CasaOSServiceMeta;
  [key: string]: unknown;
}

interface CasaOSServiceMeta {
  volumes?: Array<{ container?: string; description?: Record<string, string> }>;
  envs?: Array<{ container?: string; description?: Record<string, string> }>;
  [key: string]: unknown;
}

interface DockerComposeDocument {
  name?: string;
  version?: string;
  services?: Record<string, DockerComposeService>;
  "x-casaos"?: CasaOSAppMeta;
  [key: string]: unknown;
}

interface CasaOSAppMeta {
  title?: Record<string, string> | string;
  tagline?: Record<string, string> | string;
  description?: Record<string, string> | string;
  icon?: string;
  thumbnail?: string;
  screenshot_link?: string[];
  category?: string;
  author?: string;
  developer?: string;
  port_map?: string | number;
  main?: string;
  architectures?: string[];
  tips?: { before_install?: Record<string, string> | string };
  [key: string]: unknown;
}

function findAppsDir(storePath: string): string | null {
  const candidates = ["Apps", "apps"];
  for (const dir of candidates) {
    const full = join(storePath, dir);
    if (existsSync(full) && statSync(full).isDirectory()) return full;
  }
  return null;
}

interface ExtractedServiceMeta {
  image?: string;
  ports?: DockerComposeService["ports"];
  volumes?: DockerComposeService["volumes"];
  environment?: DockerComposeService["environment"];
  xcasaos: CasaOSServiceMeta;
}

function extractCasaOSMetadata(compose: DockerComposeDocument): {
  appLevel: CasaOSAppMeta;
  mainService: string | null;
  services: Record<string, ExtractedServiceMeta>;
} {
  const appLevel = compose?.["x-casaos"] || ({} as CasaOSAppMeta);
  const services: Record<string, ExtractedServiceMeta> = {};
  const mainService = appLevel.main || null;

  if (compose?.services) {
    for (const [name, s] of Object.entries(compose.services)) {
      services[name] = {
        image: s.image,
        ports: s.ports,
        volumes: s.volumes,
        environment: s.environment,
        xcasaos: s["x-casaos"] || {},
      };
    }
  }

  return { appLevel, mainService, services };
}

function parsePorts(serviceDef: ExtractedServiceMeta): AppPort[] {
  const ports: AppPort[] = [];
  if (!serviceDef?.ports) return ports;

  for (const p of serviceDef.ports) {
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
  return ports;
}

function parseVolumes(serviceDef: ExtractedServiceMeta, svcXcasaos: CasaOSServiceMeta): AppVolume[] {
  const volumes: AppVolume[] = [];
  if (!serviceDef?.volumes) return volumes;

  const descriptions: Record<string, string> = {};
  if (svcXcasaos?.volumes) {
    for (const v of svcXcasaos.volumes) {
      if (v.container) {
        const desc = v.description?.en_us || v.description?.en_US || Object.values(v.description || {})[0] || "";
        descriptions[v.container] = desc as string;
      }
    }
  }

  for (const v of serviceDef.volumes) {
    if (typeof v === "string") {
      const parts = v.split(":");
      if (parts.length >= 2) {
        const containerPath = parts[1];
        volumes.push({
          name: basename(parts[0]),
          containerPath,
          description: descriptions[containerPath],
          mediaVolume: inferMediaVolume(containerPath),
        });
      }
    } else if (typeof v === "object" && v.source && v.target) {
      volumes.push({
        name: basename(v.source),
        containerPath: v.target,
        description: descriptions[v.target],
        mediaVolume: inferMediaVolume(v.target),
      });
    }
  }
  return volumes;
}

function parseEnvVars(serviceDef: ExtractedServiceMeta, svcXcasaos: CasaOSServiceMeta): AppEnvVar[] {
  const envVars: AppEnvVar[] = [];
  if (!serviceDef?.environment) return envVars;

  const descriptions: Record<string, string> = {};
  if (svcXcasaos?.envs) {
    for (const e of svcXcasaos.envs) {
      if (e.container) {
        const desc = e.description?.en_us || e.description?.en_US || Object.values(e.description || {})[0] || "";
        descriptions[e.container] = desc as string;
      }
    }
  }

  const env = serviceDef.environment;
  if (Array.isArray(env)) {
    for (const item of env) {
      if (typeof item === "string") {
        const [key, ...rest] = item.split("=");
        const val = rest.join("=");
        envVars.push({
          key,
          label: descriptions[key] || key,
          required: false,
          default: val || undefined,
        });
      }
    }
  } else if (typeof env === "object") {
    for (const [key, val] of Object.entries(env)) {
      envVars.push({
        key,
        label: descriptions[key] || key,
        required: false,
        default: val != null ? String(val) : undefined,
      });
    }
  }

  return envVars;
}

function getLocalized(obj: Record<string, string> | string | undefined): string {
  if (!obj) return "";
  if (typeof obj === "string") return obj;
  return obj.en_us || obj.en_US || obj.en || Object.values(obj)[0] || "";
}

function extractLocalizedFields(appLevel: CasaOSAppMeta): Record<string, Record<string, string>> | undefined {
  const fields: Record<string, Record<string, string>> = {};
  let hasAny = false;

  for (const field of ["title", "tagline", "description"] as const) {
    const obj = appLevel[field];
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const locales: Record<string, string> = {};
      for (const [locale, value] of Object.entries(obj)) {
        if (typeof value === "string" && value.length > 0) {
          locales[locale] = value;
        }
      }
      if (Object.keys(locales).length > 1) {
        fields[field] = locales;
        hasAny = true;
      }
    }
  }

  return hasAny ? fields : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function inferPermissionsFromCompose(compose: DockerComposeDocument): AppManifest["permissions"] | undefined {
  const result: NonNullable<AppManifest["permissions"]> = {};
  let hasAny = false;

  if (!compose?.services) return undefined;

  for (const svc of Object.values(compose.services)) {
    if (svc?.privileged) {
      result.privileged = true;
      hasAny = true;
    }
    if (svc?.network_mode === "host") {
      result.networkMode = "host";
      hasAny = true;
    }
    // GPU via deploy resource reservations
    const deployDevices = svc?.deploy?.resources?.reservations?.devices;
    if (Array.isArray(deployDevices)) {
      for (const dev of deployDevices) {
        if (dev?.capabilities?.includes("gpu") || dev?.driver === "nvidia") {
          result.gpu = true;
          hasAny = true;
        }
      }
    }
    // GPU via nvidia runtime or /dev/dri device mounts
    if (svc?.runtime === "nvidia") {
      result.gpu = true;
      hasAny = true;
    }
    for (const d of svc?.devices ?? []) {
      if (typeof d === "string" && (d.includes("/dev/dri") || d.includes("/dev/nvidia"))) {
        result.gpu = true;
        hasAny = true;
      }
    }
  }

  return hasAny ? result : undefined;
}

export const casaosAdapter: StoreAdapter = {
  type: "casaos",

  detect(storePath: string): boolean {
    return findAppsDir(storePath) !== null && existsSync(join(storePath, "category-list.json"));
  },

  parse(storePath: string, storeId: string): AppManifest[] {
    const appsDir = findAppsDir(storePath);
    if (!appsDir) return [];

    const results: AppManifest[] = [];
    let entries: string[];

    try {
      entries = readdirSync(appsDir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      try {
        const appDir = join(appsDir, entry);
        if (!statSync(appDir).isDirectory()) continue;

        const composePath = join(appDir, "docker-compose.yml");
        if (!existsSync(composePath)) continue;

        const raw = readFileSync(composePath, "utf-8");
        const compose = yaml.load(raw) as DockerComposeDocument;
        if (!compose) continue;

        const { appLevel, mainService, services } = extractCasaOSMetadata(compose);

        const appId = compose.name || entry.toLowerCase().replace(/\s+/g, "-");
        const mainSvcName = mainService || Object.keys(services)[0];
        const mainSvc = services[mainSvcName];

        if (!mainSvc) continue;

        const ports = parsePorts(mainSvc);
        const volumes = parseVolumes(mainSvc, mainSvc.xcasaos);
        const envVars = parseEnvVars(mainSvc, mainSvc.xcasaos);

        const iconPath = join(appDir, "icon.png");
        const iconUrl = appLevel.icon || (existsSync(iconPath) ? `/api/apps/store-asset?path=${encodeURIComponent(iconPath)}` : undefined);

        const localScreenshots: string[] = [];
        try {
          const files = readdirSync(appDir);
          for (const f of files) {
            if (f.startsWith("screenshot") && (f.endsWith(".png") || f.endsWith(".jpg"))) {
              localScreenshots.push(`/api/apps/store-asset?path=${encodeURIComponent(join(appDir, f))}`);
            }
          }
        } catch { /* ignore */ }

        // CasaOS provides richer remote asset metadata; prefer it over local files
        // to keep screenshots visible in the dashboard.
        const remoteScreenshots = toStringArray(appLevel.screenshot_link);
        const screenshots = remoteScreenshots.length > 0 ? remoteScreenshots : localScreenshots;
        const thumbnail = typeof appLevel.thumbnail === "string" && appLevel.thumbnail.length > 0
          ? appLevel.thumbnail
          : undefined;
        const coverUrl = thumbnail || screenshots.find((s) => !s.startsWith("file://"));
        const installNotes = getLocalized(appLevel?.tips?.before_install) || undefined;

        const portMap = appLevel.port_map;
        let webPort: number | undefined;
        if (portMap) {
          const parsed = parseInt(String(portMap).replace(/\$\{.*\}/, ""));
          if (!isNaN(parsed)) webPort = parsed;
        }
        if (!webPort && ports.length > 0) {
          webPort = ports[0].host;
        }

        const localizedFields = extractLocalizedFields(appLevel);
        const permissions = inferPermissionsFromCompose(compose);

        results.push({
          id: appId,
          name: getLocalized(appLevel.title) || entry,
          version: mainSvc.image?.split(":")[1]?.split("@")[0] || "latest",
          tagline: getLocalized(appLevel.tagline) || "",
          description: getLocalized(appLevel.description) || "",
          releaseNotes: undefined,
          icon: "📦",
          iconUrl: typeof iconUrl === "string" ? iconUrl : undefined,
          screenshots: screenshots.length > 0 ? screenshots : undefined,
          coverUrl,
          category: (appLevel.category || "other").toLowerCase(),
          author: appLevel.author || appLevel.developer || "Unknown",
          website: undefined,
          repo: undefined,
          installNotes,
          source: "casaos",
          storeId,
          composePath,
          image: mainSvc.image,
          ports,
          volumes,
          env: envVars,
          architectures: appLevel.architectures,
          dependencies: undefined,
          permissions,
          webPort,
          localizedFields,
        } as AppManifest & { localizedFields?: Record<string, Record<string, string>> });
      } catch {
        // Skip malformed apps
      }
    }

    return results;
  },
};
