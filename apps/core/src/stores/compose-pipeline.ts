import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "../utils/filesystem.js";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import yaml from "js-yaml";
import { ensureTalomeNetwork, injectTalomeNetwork } from "../docker/talome-network.js";
import { getSetting } from "../utils/settings.js";
import { detectFilesystemType } from "../platform/index.js";
import type { AppVolume } from "@talome/types";

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

const APP_DATA_DIR = join(homedir(), ".talome", "app-data");

export function checkVolumeMountFilesystems(volumeMounts: Record<string, string>): string[] {
  const warnings: string[] = [];
  for (const [name, hostPath] of Object.entries(volumeMounts)) {
    if (!hostPath || !existsSync(hostPath)) continue;
    const fsType = detectFilesystemType(hostPath);
    if (fsType === "exfat" || fsType === "msdos") {
      warnings.push(
        `Volume "${name}" (${hostPath}) is on ${fsType.toUpperCase()} — Docker may have write issues (known kernel bug with VirtioFS). Recommend APFS or ext4 for reliable operation.`
      );
    }
  }
  return warnings;
}

// ── Talome network injection ───────────────────────────────────────────────

export async function injectNetworkIntoCompose(composePath: string, appId: string): Promise<string> {
  await ensureTalomeNetwork();

  const raw = readFileSync(composePath, "utf-8");
  const doc = yaml.load(raw) as Record<string, unknown>;
  if (!doc?.services) return composePath;

  injectTalomeNetwork(doc);

  // Write to the app-data override location
  const overrideDir = join(APP_DATA_DIR, appId);
  mkdirSync(overrideDir, { recursive: true });
  const overridePath = join(overrideDir, "docker-compose.yml");
  atomicWriteFileSync(overridePath, yaml.dump(doc, { lineWidth: -1 }), "utf-8");
  return overridePath;
}

// ── Compose variable scanning ─────────────────────────────────────────────

export function findComposeVars(composePath: string): string[] {
  try {
    const raw = readFileSync(composePath, "utf-8");
    const vars = new Set<string>();
    const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) vars.add(m[1]);
    return [...vars];
  } catch {
    return [];
  }
}

// ── Umbrel compose sanitization ───────────────────────────────────────────

export function generateUmbrelPlatformEnv(
  composePath: string,
  appId: string,
): Record<string, string> {
  const needed = new Set(findComposeVars(composePath));
  const gen: Record<string, string> = {};

  // APP_PASSWORD — random secret (Umbrel generates one per app)
  if (needed.has("APP_PASSWORD")) {
    gen.APP_PASSWORD = randomBytes(32).toString("hex");
  }

  // APP_SEED — random 256-bit seed
  if (needed.has("APP_SEED")) {
    gen.APP_SEED = randomBytes(32).toString("hex");
  }

  // DEVICE_DOMAIN_NAME / DEVICE_HOSTNAME — system hostname
  const host = hostname() || "localhost";
  if (needed.has("DEVICE_DOMAIN_NAME")) gen.DEVICE_DOMAIN_NAME = host;
  if (needed.has("DEVICE_HOSTNAME")) gen.DEVICE_HOSTNAME = host;

  // APP_DOMAIN — same as DEVICE_DOMAIN_NAME for now
  if (needed.has("APP_DOMAIN")) gen.APP_DOMAIN = host;

  // Any APP_*_KEY or APP_*_SECRET patterns — generate random hex
  for (const v of needed) {
    if (gen[v]) continue;
    if (/^APP_.*_KEY$/.test(v)) {
      gen[v] = randomBytes(16).toString("hex");
    } else if (/^APP_.*_SECRET$/.test(v)) {
      gen[v] = randomBytes(32).toString("hex");
    }
  }

  return gen;
}

export function sanitizeUmbrelCompose(
  composePath: string,
  appId: string,
  webPort: number | undefined,
): string | null {
  try {
    const raw = readFileSync(composePath, "utf-8");
    const doc = yaml.load(raw) as DockerComposeDocument;
    if (!doc?.services) return null;

    let modified = false;

    // Extract app_proxy info before removing it
    const proxy = doc.services.app_proxy;
    let proxyTargetPort: number | undefined;
    if (proxy?.environment && typeof proxy.environment === "object" && !Array.isArray(proxy.environment)) {
      const p = proxy.environment.APP_PORT;
      if (p != null) proxyTargetPort = parseInt(String(p), 10);
    }
    // Remove app_proxy service
    if (doc.services.app_proxy) {
      delete doc.services.app_proxy;
      modified = true;
    }

    // Remove depends_on references to app_proxy in remaining services
    for (const svc of Object.values(doc.services)) {
      if (!svc?.depends_on) continue;
      if (Array.isArray(svc.depends_on)) {
        const idx = svc.depends_on.indexOf("app_proxy");
        if (idx >= 0) { svc.depends_on.splice(idx, 1); modified = true; }
        if (svc.depends_on.length === 0) delete svc.depends_on;
      } else if (typeof svc.depends_on === "object") {
        if ("app_proxy" in svc.depends_on) {
          delete (svc.depends_on as Record<string, unknown>).app_proxy;
          modified = true;
          if (Object.keys(svc.depends_on).length === 0) delete svc.depends_on;
        }
      }
    }

    // Add port mapping to the main app service if it has none
    const containerPort = proxyTargetPort || 80;
    const hostPort = webPort || 8080;
    const proxyEnv = proxy?.environment && typeof proxy.environment === "object" && !Array.isArray(proxy.environment) ? proxy.environment : null;
    const proxyAppHost = proxyEnv ? String(proxyEnv.APP_HOST ?? "") : "";
    const mainServiceName = proxyAppHost
      ? Object.keys(doc.services).find((n) => {
          const svcName = `${appId}_${n}_1`;
          return proxyAppHost === svcName || proxyAppHost.includes(n);
        })
      : undefined;
    const targetService = mainServiceName
      ? doc.services[mainServiceName]
      : Object.values(doc.services).find((s) => s.image);

    if (targetService && !targetService.ports?.length) {
      targetService.ports = [`${hostPort}:${containerPort}`];
      modified = true;
    }

    // Fix Docker Compose v1 hostname references
    const serviceNames = Object.keys(doc.services);
    for (const svc of Object.values(doc.services)) {
      if (!svc?.environment || typeof svc.environment !== "object" || Array.isArray(svc.environment)) continue;
      for (const [key, val] of Object.entries(svc.environment)) {
        if (typeof val !== "string") continue;
        for (const sn of serviceNames) {
          const v1Pattern = new RegExp(`${appId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[_-]${sn}[_-]1`, "gi");
          if (v1Pattern.test(val)) {
            (svc.environment as Record<string, string | number | null>)[key] = val.replace(v1Pattern, sn);
            modified = true;
          }
        }
      }
    }

    // Replace hardcoded PUID/PGID/TZ with interpolation variables
    for (const svc of Object.values(doc.services)) {
      modified = replaceHardcodedEnv(svc, modified);
    }

    // Inject default memory limits for services without resource constraints
    for (const svc of Object.values(doc.services)) {
      if (injectDefaultResourceLimits(svc)) modified = true;
    }

    // Remove deprecated version attribute
    if (doc.version) {
      delete doc.version;
      modified = true;
    }

    if (!modified) return null;

    const overrideDir = join(APP_DATA_DIR, appId);
    mkdirSync(overrideDir, { recursive: true });
    const overridePath = join(overrideDir, "docker-compose.yml");
    atomicWriteFileSync(overridePath, yaml.dump(doc, { lineWidth: -1 }), "utf-8");
    return overridePath;
  } catch {
    return null;
  }
}

// ── Default resource limits injection ──────────────────────────────────────

/**
 * Injects default memory limits into services that don't already have them.
 * Prevents a single runaway container from consuming all host memory.
 */
export function injectDefaultResourceLimits(svc: DockerComposeService): boolean {
  const deploy = svc.deploy as Record<string, unknown> | undefined;
  const resources = deploy?.resources as Record<string, unknown> | undefined;
  const limits = resources?.limits as Record<string, unknown> | undefined;
  if (limits) return false;

  if (!svc.deploy) svc.deploy = {};
  const dep = svc.deploy as Record<string, unknown>;
  if (!dep.resources) dep.resources = {};
  const res = dep.resources as Record<string, unknown>;
  if (!res.limits) {
    res.limits = { memory: "2g" };
    return true;
  }
  return false;
}

// ── Hardcoded env replacement ─────────────────────────────────────────────

const ENV_INTERPOLATION_MAP: Record<string, string> = {
  PUID: "${PUID}",
  PGID: "${PGID}",
  TZ: "${TZ}",
};

export function replaceHardcodedEnv(svc: DockerComposeService, modified: boolean): boolean {
  if (!svc?.environment) return modified;

  if (Array.isArray(svc.environment)) {
    svc.environment = svc.environment.map((entry: string) => {
      for (const [key, interp] of Object.entries(ENV_INTERPOLATION_MAP)) {
        const re = new RegExp(`^${key}=\\d+$`);
        if (key === "TZ") {
          if (entry.startsWith(`${key}=`) && !entry.includes("${")) {
            modified = true;
            return `${key}=${interp}`;
          }
        } else if (re.test(entry)) {
          modified = true;
          return `${key}=${interp}`;
        }
      }
      return entry;
    });
  } else if (typeof svc.environment === "object") {
    for (const [key, interp] of Object.entries(ENV_INTERPOLATION_MAP)) {
      const val = svc.environment[key];
      if (val == null) continue;
      const strVal = String(val);
      if (key === "TZ") {
        if (!strVal.includes("${")) {
          svc.environment[key] = interp;
          modified = true;
        }
      } else if (/^\d+$/.test(strVal)) {
        svc.environment[key] = interp;
        modified = true;
      }
    }
  }

  return modified;
}

// ── CasaOS compose sanitization ───────────────────────────────────────────

export function sanitizeCasaosCompose(
  composePath: string,
  appId: string,
): string | null {
  try {
    const raw = readFileSync(composePath, "utf-8");
    const doc = yaml.load(raw) as DockerComposeDocument;
    if (!doc?.services) return null;

    let modified = false;
    const dataDir = join(APP_DATA_DIR, appId);

    for (const svc of Object.values(doc.services)) {
      if (!Array.isArray(svc.volumes)) continue;
      svc.volumes = svc.volumes.map((v) => {
        if (typeof v === "string") {
          const rewritten = rewriteCasaosPath(v, appId, dataDir);
          if (rewritten !== v) { modified = true; return rewritten; }
          return v;
        }
        if (typeof v === "object" && v !== null && typeof v.source === "string") {
          const newSource = rewriteCasaosSource(v.source, appId, dataDir);
          if (newSource !== v.source) {
            modified = true;
            return { ...v, source: newSource };
          }
        }
        return v;
      });

      modified = replaceHardcodedEnv(svc, modified);
    }

    // Inject default memory limits for services without resource constraints
    for (const svc of Object.values(doc.services)) {
      if (injectDefaultResourceLimits(svc)) modified = true;
    }

    if (doc.version) { delete doc.version; modified = true; }

    if (!modified) return null;

    mkdirSync(dataDir, { recursive: true });
    const overridePath = join(dataDir, "docker-compose.yml");
    atomicWriteFileSync(overridePath, yaml.dump(doc, { lineWidth: -1 }), "utf-8");
    return overridePath;
  } catch {
    return null;
  }
}

function rewriteCasaosPath(vol: string, appId: string, dataDir: string): string {
  const parts = vol.split(":");
  if (parts.length < 2) return vol;
  const newSource = rewriteCasaosSource(parts[0], appId, dataDir);
  if (newSource === parts[0]) return vol;
  return [newSource, ...parts.slice(1)].join(":");
}

function rewriteCasaosSource(source: string, appId: string, dataDir: string): string {
  const expanded = source
    .replace(/\$\{?AppID\}?/g, appId)
    .replace(/\$\{?APP_ID\}?/g, appId);

  if (!expanded.startsWith("/DATA/")) return source;

  // /DATA/AppData/<appId>/... → ~/.talome/app-data/<appId>/...
  const appDataMatch = expanded.match(/^\/DATA\/AppData\/[^/]+\/?(.*)/);
  if (appDataMatch) {
    const sub = appDataMatch[1];
    return sub ? join(dataDir, sub) : dataDir;
  }

  // /DATA/Media/... → check storage settings, fall back to app-data
  const mediaMatch = expanded.match(/^\/DATA\/Media\/?(.*)/);
  if (mediaMatch) {
    const sub = mediaMatch[1];
    const subLower = sub.toLowerCase();
    if (subLower.startsWith("book")) {
      const booksRoot = getSetting("books_root");
      if (booksRoot) return booksRoot.replace(/\/+$/, "");
    }
    const mediaRoot = getSetting("media_root");
    if (mediaRoot) {
      const base = mediaRoot.replace(/\/+$/, "");
      return sub ? join(base, sub) : base;
    }
    const fallback = join(dataDir, sub || "media");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }

  // /DATA/Downloads/... → check downloads_root setting
  const dlMatch = expanded.match(/^\/DATA\/Downloads\/?(.*)/);
  if (dlMatch) {
    const downloadsRoot = getSetting("downloads_root");
    if (downloadsRoot) {
      const base = downloadsRoot.replace(/\/+$/, "");
      return dlMatch[1] ? join(base, dlMatch[1]) : base;
    }
    const fallback = join(dataDir, "downloads");
    mkdirSync(fallback, { recursive: true });
    return fallback;
  }

  // Any other /DATA/... path → fall back to app-data
  const remaining = expanded.replace(/^\/DATA\//, "");
  const fallback = join(dataDir, remaining || "data");
  mkdirSync(fallback, { recursive: true });
  return fallback;
}

// ── Volume mount injection ────────────────────────────────────────────────

export function applyVolumeMounts(
  composePath: string,
  appId: string,
  volumeMounts: Record<string, string>,
  catalogVolumes: AppVolume[],
): string | null {
  const entries = Object.entries(volumeMounts).filter(([, v]) => v.trim());
  if (entries.length === 0) return null;

  // Build map: containerPath → user-provided hostPath
  const mountMap = new Map<string, string>();
  for (const [name, hostPath] of entries) {
    const vol = catalogVolumes.find((v) => v.name === name);
    if (vol) mountMap.set(vol.containerPath, hostPath.trim());
  }
  if (mountMap.size === 0) return null;

  const raw = readFileSync(composePath, "utf-8");
  const doc = yaml.load(raw) as Record<string, unknown>;
  if (!doc?.services) return null;

  const services = doc.services as Record<string, Record<string, unknown>>;
  for (const svc of Object.values(services)) {
    if (!Array.isArray(svc.volumes)) continue;
    svc.volumes = (svc.volumes as (string | Record<string, unknown>)[]).map((v) => {
      if (typeof v === "string") {
        const parts = v.split(":");
        if (parts.length < 2) return v;
        const containerPath = parts[1];
        const userPath = mountMap.get(containerPath);
        if (userPath) {
          // Replace host-side path, keep container path and flags (e.g. :ro)
          return [userPath, ...parts.slice(1)].join(":");
        }
        return v;
      }
      // Handle CasaOS/Umbrel object-format volumes: { type: bind, source: ..., target: ... }
      if (typeof v === "object" && v !== null && typeof v.target === "string") {
        const containerPath = v.target as string;
        const userPath = mountMap.get(containerPath);
        if (userPath) {
          return { ...v, source: userPath };
        }
      }
      return v;
    });
  }

  const overrideDir = join(APP_DATA_DIR, appId);
  mkdirSync(overrideDir, { recursive: true });
  const overridePath = join(overrideDir, "docker-compose.yml");
  atomicWriteFileSync(overridePath, yaml.dump(doc), "utf-8");
  return overridePath;
}
