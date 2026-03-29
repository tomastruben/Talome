/**
 * Post-install auto-configuration for known apps.
 *
 * Handles:
 * - API key extraction from config files (arr apps generate config.xml)
 * - Settings auto-save (activates the app's tool domain)
 * - Inter-app wiring (Prowlarr ↔ arr, arr ↔ qBittorrent, root folders)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { APP_REGISTRY, type AppCapabilities } from "./index.js";
import { isSecretSettingKey, encryptSetting } from "../utils/crypto.js";

const APP_DATA_DIR = join(homedir(), ".talome", "app-data");

// ── Config file paths for apps that generate API keys ──────────────────────

const ARR_CONFIG: Record<string, { configPath: string; apiKeyTag: string; defaultPort: number }> = {
  sonarr:   { configPath: "config/config.xml", apiKeyTag: "ApiKey", defaultPort: 8989 },
  radarr:   { configPath: "config/config.xml", apiKeyTag: "ApiKey", defaultPort: 7878 },
  readarr:  { configPath: "config/config.xml", apiKeyTag: "ApiKey", defaultPort: 8787 },
  prowlarr: { configPath: "config/config.xml", apiKeyTag: "ApiKey", defaultPort: 9696 },
};

// ── API key extraction ─────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll for an API key in the app's config file.
 * Arr apps take 5-10s to generate config.xml on first start.
 */
export async function extractApiKey(
  appId: string,
): Promise<string | null> {
  const config = ARR_CONFIG[appId.toLowerCase()];
  if (!config) return null;

  const configPath = join(APP_DATA_DIR, appId, config.configPath);
  const maxAttempts = 15; // 30s total

  for (let i = 0; i < maxAttempts; i++) {
    if (existsSync(configPath)) {
      try {
        const xml = readFileSync(configPath, "utf-8");
        const match = xml.match(new RegExp(`<${config.apiKeyTag}>([^<]+)</${config.apiKeyTag}>`));
        if (match?.[1]) {
          return match[1];
        }
      } catch {
        // File may still be written — retry
      }
    }
    await sleep(2000);
  }

  return null;
}

// ── Settings save ──────────────────────────────────────────────────────────

function setSetting(key: string, value: string): void {
  const storedValue = isSecretSettingKey(key) ? encryptSetting(value) : value;
  db.insert(schema.settings)
    .values({ key, value: storedValue })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: storedValue } })
    .run();
}

function getSetting(key: string): string | undefined {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row?.value ?? undefined;
}

/**
 * Save base URL and API key to settings. This activates the app's tool domain.
 */
export function saveAppSettings(
  appId: string,
  apiKey: string,
  port: number,
): string[] {
  const caps = APP_REGISTRY[appId.toLowerCase()];
  if (!caps) return [];

  const saved: string[] = [];

  // Use localhost — Talome core runs on the host, not inside Docker.
  // Container DNS names (e.g. http://readarr:8787) are only for inter-container
  // wiring (Prowlarr → arr), which autoWireApp handles separately.
  const url = `http://localhost:${port}`;
  setSetting(caps.apiBaseSettingKey, url);
  saved.push(caps.apiBaseSettingKey);

  setSetting(caps.apiKeySettingKey, apiKey);
  saved.push(caps.apiKeySettingKey);

  return saved;
}

// ── Inter-app wiring ───────────────────────────────────────────────────────

interface WiringResult {
  target: string;
  action: string;
  success: boolean;
  detail?: string;
}

async function arrApiCall(
  baseUrl: string,
  apiKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data?: unknown }> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const data = res.headers.get("content-type")?.includes("json")
      ? await res.json()
      : await res.text();
    return { ok: res.ok, status: res.status, data };
  } catch (err: unknown) {
    return { ok: false, status: 0, data: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Wire a newly installed app to related apps that are already configured.
 */
export async function autoWireApp(appId: string): Promise<WiringResult[]> {
  const caps = APP_REGISTRY[appId.toLowerCase()];
  if (!caps?.relatesTo?.length) return [];

  const results: WiringResult[] = [];
  const appUrl = getSetting(caps.apiBaseSettingKey);
  const appKey = getSetting(caps.apiKeySettingKey);
  if (!appUrl || !appKey) return results;

  const isArr = ["sonarr", "radarr", "readarr"].includes(appId.toLowerCase());

  for (const relatedId of caps.relatesTo) {
    const relatedCaps = APP_REGISTRY[relatedId];
    if (!relatedCaps) continue;

    const relatedUrl = getSetting(relatedCaps.apiBaseSettingKey);
    const relatedKey = getSetting(relatedCaps.apiKeySettingKey);
    if (!relatedUrl || !relatedKey) continue;

    // arr → prowlarr: Register as application in Prowlarr
    if (isArr && relatedId === "prowlarr") {
      const apiVersion = appId.toLowerCase() === "readarr" ? "v1" : "v3";
      const appTypes: Record<string, string> = {
        sonarr: "Sonarr",
        radarr: "Radarr",
        readarr: "Readarr",
      };
      const implName = appTypes[appId.toLowerCase()];

      // Use container DNS names for inter-container communication.
      // Settings URLs are localhost (for Talome host access), but Prowlarr ↔ arr
      // talk over the shared talome network using container names.
      const defaultPort = ARR_CONFIG[appId.toLowerCase()]?.defaultPort;
      const prowlarrContainerUrl = `http://prowlarr:${ARR_CONFIG.prowlarr.defaultPort}`;
      const appContainerUrl = defaultPort ? `http://${appId}:${defaultPort}` : appUrl;

      const res = await arrApiCall(relatedUrl, relatedKey, "POST", "/api/v1/applications", {
        name: implName,
        syncLevel: "fullSync",
        implementation: implName,
        configContract: `${implName}Settings`,
        fields: [
          { name: "prowlarrUrl", value: prowlarrContainerUrl },
          { name: "baseUrl", value: appContainerUrl },
          { name: "apiKey", value: appKey },
        ],
      });
      results.push({
        target: "prowlarr",
        action: "registered_application",
        success: res.ok,
        detail: res.ok ? `Registered ${implName} in Prowlarr` : `API ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`,
      });

      // Trigger index sync if registration succeeded
      if (res.ok) {
        await arrApiCall(relatedUrl, relatedKey, "POST", "/api/v1/command", {
          name: "AppIndexerSync",
        });
      }
    }

    // arr → qbittorrent: Add download client
    if (isArr && relatedId === "qbittorrent") {
      const apiVersion = appId.toLowerCase() === "readarr" ? "v1" : "v3";
      // Prefer container DNS name (works on the shared talome bridge network).
      // Fall back to host.docker.internal only on macOS (Docker Desktop / OrbStack)
      // where gluetun VPN setups are common and qBittorrent may not be on talome.
      // On Linux, host.docker.internal is unreliable without extra_hosts config.
      const qbtServiceName = APP_REGISTRY.qbittorrent?.dockerServiceName ?? "qbittorrent";
      const qbtPort = APP_REGISTRY.qbittorrent?.commonPorts[0] || 8080;
      const qbtHost = process.platform === "darwin" ? "host.docker.internal" : qbtServiceName;

      const res = await arrApiCall(appUrl, appKey, "POST", `/api/${apiVersion}/downloadclient`, {
        name: "qBittorrent",
        implementation: "QBittorrent",
        configContract: "QBittorrentSettings",
        protocol: "torrent",
        enable: true,
        fields: [
          { name: "host", value: qbtHost },
          { name: "port", value: qbtPort },
          { name: "username", value: "admin" },
          { name: "password", value: relatedKey || "" },
          { name: "category", value: appId.toLowerCase() },
        ],
      });
      results.push({
        target: "qbittorrent",
        action: "download_client",
        success: res.ok,
        detail: res.ok ? "Added qBittorrent as download client" : `API ${res.status}: ${JSON.stringify(res.data).slice(0, 200)}`,
      });
    }
  }

  return results;
}

// ── Auth fix ───────────────────────────────────────────────────────────────

/**
 * Ensure arr apps have AuthenticationRequired=DisabledForLocalAddresses.
 *
 * Radarr v5+ with AuthenticationRequired=Enabled blocks static file routes
 * (like /MediaCover/) even with a valid X-Api-Key header — API key auth only
 * works on /api/ routes. Talome's poster proxy fetches images from localhost,
 * so local auth must be disabled for covers to load in the dashboard.
 */
function fixArrAuthForLocalAccess(appId: string): boolean {
  const config = ARR_CONFIG[appId.toLowerCase()];
  if (!config) return false;

  const configPath = join(APP_DATA_DIR, appId, config.configPath);
  if (!existsSync(configPath)) return false;

  try {
    let xml = readFileSync(configPath, "utf-8");
    if (xml.includes("<AuthenticationRequired>Enabled</AuthenticationRequired>")) {
      xml = xml.replace(
        "<AuthenticationRequired>Enabled</AuthenticationRequired>",
        "<AuthenticationRequired>DisabledForLocalAddresses</AuthenticationRequired>",
      );
      writeFileSync(configPath, xml, "utf-8");
      console.log(`[auto-config] ${appId}: Fixed AuthenticationRequired → DisabledForLocalAddresses`);
      return true;
    }
  } catch {
    // Best-effort
  }
  return false;
}

// ── Orchestrator ───────────────────────────────────────────────────────────

export interface AutoConfigResult {
  apiKeyExtracted: boolean;
  settingsSaved: string[];
  wiring: WiringResult[];
  warnings: string[];
}

/**
 * Full auto-configure flow: extract key → save settings → wire related apps.
 * Best-effort — never throws.
 */
export async function autoConfigureApp(
  appId: string,
  caps: AppCapabilities,
): Promise<AutoConfigResult> {
  const result: AutoConfigResult = {
    apiKeyExtracted: false,
    settingsSaved: [],
    wiring: [],
    warnings: [],
  };

  // Fix auth for local access (poster proxy needs this)
  fixArrAuthForLocalAccess(appId);

  // Extract API key (arr apps)
  const config = ARR_CONFIG[appId.toLowerCase()];
  if (config) {
    const apiKey = await extractApiKey(appId);
    if (apiKey) {
      result.apiKeyExtracted = true;
      result.settingsSaved = saveAppSettings(appId, apiKey, config.defaultPort);
      console.log(`[auto-config] ${appId}: API key extracted, settings saved (${result.settingsSaved.join(", ")})`);

      // Wire to related apps
      result.wiring = await autoWireApp(appId);
      for (const w of result.wiring) {
        console.log(`[auto-config] ${appId} → ${w.target}: ${w.action} ${w.success ? "✓" : "✗"} ${w.detail ?? ""}`);
      }
    } else {
      result.warnings.push(`Could not extract API key from config — ${appId} may need manual configuration`);
    }
  }

  return result;
}
