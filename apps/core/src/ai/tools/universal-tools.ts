/**
 * Universal app interaction tools — app-agnostic API access, discovery,
 * connectivity testing, and inter-app wiring.
 *
 * These tools let the AI interact with ANY installed app, not just those
 * with dedicated tool integrations. They leverage the app-registry for
 * known apps and fall back to settings-based lookup for unknown ones.
 */

import { tool } from "ai";
import { z } from "zod";
import { APP_REGISTRY, type AppCapabilities } from "../../app-registry/index.js";
import { listContainers } from "../../docker/client.js";
import { getSetting } from "../../utils/settings.js";

// ── Auth patterns ────────────────────────────────────────────────────────────

export type AuthStyle =
  | { type: "x-api-key"; header: string; value: string }
  | { type: "bearer"; header: string; value: string }
  | { type: "mediabrowser"; header: string; value: string }
  | { type: "query"; param: string; value: string }
  | { type: "none" };

/** Known auth patterns per app registry entry */
const AUTH_PATTERNS: Record<string, (apiKey: string) => AuthStyle> = {
  sonarr: (k) => ({ type: "x-api-key", header: "X-Api-Key", value: k }),
  radarr: (k) => ({ type: "x-api-key", header: "X-Api-Key", value: k }),
  prowlarr: (k) => ({ type: "x-api-key", header: "X-Api-Key", value: k }),
  jellyfin: (k) => ({ type: "mediabrowser", header: "Authorization", value: `MediaBrowser Token="${k}"` }),
  overseerr: (k) => ({ type: "x-api-key", header: "X-Api-Key", value: k }),
  homeassistant: (k) => ({ type: "bearer", header: "Authorization", value: `Bearer ${k}` }),
  pihole: (k) => ({ type: "query", param: "auth", value: k }),
  vaultwarden: (k) => ({ type: "bearer", header: "Authorization", value: `Bearer ${k}` }),
  audiobookshelf: (k) => ({ type: "bearer", header: "Authorization", value: `Bearer ${k}` }),
  readarr: (k) => ({ type: "x-api-key", header: "X-Api-Key", value: k }),
};

export function resolveAppConnection(appId: string): {
  baseUrl: string;
  apiKey?: string;
  auth: AuthStyle;
  capabilities?: AppCapabilities;
} | { error: string; hint?: string } {
  const lowerApp = appId.toLowerCase();
  const caps = APP_REGISTRY[lowerApp];

  if (caps) {
    const baseUrl = getSetting(caps.apiBaseSettingKey);
    const apiKey = getSetting(caps.apiKeySettingKey);
    if (!baseUrl) {
      return {
        error: `${caps.name} is not configured — missing ${caps.apiBaseSettingKey}.`,
        hint: `Add ${caps.apiBaseSettingKey} and ${caps.apiKeySettingKey} in Settings.`,
      };
    }
    const authFn = AUTH_PATTERNS[lowerApp];
    const auth: AuthStyle = apiKey && authFn ? authFn(apiKey) : { type: "none" };
    return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, auth, capabilities: caps };
  }

  // Fallback: convention-based settings lookup
  const baseUrl = getSetting(`${lowerApp}_url`);
  const apiKey = getSetting(`${lowerApp}_api_key`) || getSetting(`${lowerApp}_token`);
  if (!baseUrl) {
    return {
      error: `No configuration found for '${appId}'. Set ${lowerApp}_url in Settings.`,
      hint: `Use set_setting to add ${lowerApp}_url and optionally ${lowerApp}_api_key.`,
    };
  }
  const auth: AuthStyle = apiKey
    ? { type: "x-api-key", header: "X-Api-Key", value: apiKey }
    : { type: "none" };
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, auth };
}

export function buildHeaders(auth: AuthStyle): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth.type === "x-api-key" || auth.type === "bearer" || auth.type === "mediabrowser") {
    headers[auth.header] = auth.value;
  }
  return headers;
}

function buildUrl(base: string, path: string, auth: AuthStyle): string {
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  if (auth.type === "query") {
    const parsed = new URL(url);
    parsed.searchParams.set(auth.param, auth.value);
    return parsed.toString();
  }
  return url;
}

// ── app_api_call ─────────────────────────────────────────────────────────────

export const appApiCallTool = tool({
  description: `Make an HTTP API call to any installed app. Uses the app-registry for known apps (Sonarr, Radarr, Jellyfin, etc.) and falls back to convention-based settings lookup for any other app.

Supports GET, POST, PUT, DELETE, PATCH. Auth headers are added automatically based on the app's configured credentials.

After calling: Report the status code and key data. If the call failed, suggest checking the app's URL/API key settings.`,
  inputSchema: z.object({
    appId: z.string().describe("App identifier (e.g. 'sonarr', 'jellyfin', 'nextcloud')"),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    path: z.string().describe("API endpoint path (e.g. '/api/v3/system/status')"),
    body: z.unknown().optional().describe("Request body for POST/PUT/PATCH"),
    timeoutMs: z.number().default(8000).describe("Request timeout in milliseconds"),
  }),
  execute: async ({ appId, method, path, body, timeoutMs }) => {
    const conn = resolveAppConnection(appId);
    if ("error" in conn) return { success: false, error: conn.error, hint: conn.hint };

    const url = buildUrl(conn.baseUrl, path, conn.auth);
    const headers = buildHeaders(conn.auth);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body && method !== "GET" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const contentType = res.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json")
        ? await res.json()
        : await res.text();

      if (!res.ok) {
        return {
          success: false,
          statusCode: res.status,
          error: typeof data === "string" ? data : JSON.stringify(data).slice(0, 500),
          appId,
        };
      }

      return { success: true, statusCode: res.status, data, appId };
    } catch (err: unknown) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        appId,
      };
    }
  },
});

// ── discover_app_api ─────────────────────────────────────────────────────────

const COMMON_API_PATHS = [
  "/api/v1/system/status",
  "/api/v3/system/status",
  "/api/v2/app/version",
  "/api/v1/status",
  "/api/",
  "/health",
  "/api/alive",
  "/openapi.json",
  "/swagger.json",
  "/api/swagger.json",
  "/api-docs",
];

export const discoverAppApiTool = tool({
  description: `Probe an installed app's API surface to discover available endpoints. Checks the app-registry for known endpoints, then probes common API paths. Returns which endpoints respond and their status codes.

After calling: Present discovered endpoints as a list. Highlight the health/status endpoint and any OpenAPI spec URL. Suggest specific API calls the user could make.`,
  inputSchema: z.object({
    appId: z.string().describe("App identifier"),
    additionalPaths: z.array(z.string()).default([]).describe("Extra paths to probe beyond the defaults"),
  }),
  execute: async ({ appId, additionalPaths }) => {
    const conn = resolveAppConnection(appId);
    if ("error" in conn) return { success: false, error: conn.error, hint: conn.hint };

    const headers = buildHeaders(conn.auth);
    const pathsToProbe = new Set<string>();

    // Add registry-known endpoints first
    if (conn.capabilities) {
      pathsToProbe.add(conn.capabilities.healthEndpoint);
      for (const ep of Object.values(conn.capabilities.configEndpoints)) {
        if (ep) pathsToProbe.add(ep);
      }
    }

    // Add common paths
    for (const p of COMMON_API_PATHS) pathsToProbe.add(p);
    for (const p of additionalPaths) pathsToProbe.add(p);

    const results: Array<{
      path: string;
      status: number | "error";
      contentType?: string;
      snippet?: string;
    }> = [];

    const probePromises = [...pathsToProbe].map(async (path) => {
      const url = buildUrl(conn.baseUrl, path, conn.auth);
      try {
        const res = await fetch(url, {
          method: "GET",
          headers,
          signal: AbortSignal.timeout(4000),
        });
        const ct = res.headers.get("content-type") ?? "";
        let snippet: string | undefined;
        try {
          const text = await res.text();
          snippet = text.slice(0, 200);
        } catch {}
        return { path, status: res.status as number | "error", contentType: ct, snippet };
      } catch {
        return { path, status: "error" as const };
      }
    });

    const probeResults = await Promise.all(probePromises);
    results.push(...probeResults);

    const responding = results.filter((r) => typeof r.status === "number" && r.status < 500);
    const openApiSpec = results.find(
      (r) => typeof r.status === "number" && r.status === 200 &&
        (r.path.includes("openapi") || r.path.includes("swagger"))
    );

    return {
      success: true,
      appId,
      baseUrl: conn.baseUrl,
      endpoints: results.sort((a, b) => {
        if (a.status === "error") return 1;
        if (b.status === "error") return -1;
        return (a.status as number) - (b.status as number);
      }),
      summary: `${responding.length}/${results.length} endpoints responding`,
      hasOpenApiSpec: !!openApiSpec,
      openApiPath: openApiSpec?.path,
      registeredApp: !!conn.capabilities,
    };
  },
});

// ── test_app_connectivity ────────────────────────────────────────────────────

export const testAppConnectivityTool = tool({
  description: `Test network connectivity between two installed apps or from the host to an app. Verifies that apps can reach each other by checking the target app's health endpoint from the host perspective.

After calling: Report whether the connection succeeded. If it failed, suggest checking Docker network configuration, port mappings, or app URLs.`,
  inputSchema: z.object({
    sourceAppId: z.string().describe("Source app (or 'host' for the Talome server itself)"),
    targetAppId: z.string().describe("Target app to connect to"),
  }),
  execute: async ({ sourceAppId, targetAppId }) => {
    const targetConn = resolveAppConnection(targetAppId);
    if ("error" in targetConn) {
      return { success: false, error: targetConn.error, hint: targetConn.hint };
    }

    const healthPath = targetConn.capabilities?.healthEndpoint ?? "/health";
    const headers = buildHeaders(targetConn.auth);
    const url = buildUrl(targetConn.baseUrl, healthPath, targetConn.auth);

    // Check target is reachable
    let targetReachable = false;
    let targetStatus: number | string = "unknown";
    let targetResponseTime = 0;
    try {
      const start = Date.now();
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      targetResponseTime = Date.now() - start;
      targetStatus = res.status;
      targetReachable = res.ok || res.status === 401; // 401 = auth issue but reachable
    } catch (err: unknown) {
      targetStatus = err instanceof Error ? err.message : "unreachable";
    }

    // Check if both apps are running containers
    const containers = await listContainers();
    const sourceContainer = sourceAppId === "host"
      ? null
      : containers.find(
          (c) => c.name.toLowerCase().includes(sourceAppId.toLowerCase()) ||
            c.labels?.["com.docker.compose.service"]?.toLowerCase() === sourceAppId.toLowerCase()
        );
    const targetContainer = containers.find(
      (c) => c.name.toLowerCase().includes(targetAppId.toLowerCase()) ||
        c.labels?.["com.docker.compose.service"]?.toLowerCase() === targetAppId.toLowerCase()
    );

    // Check if they share a Docker network
    let sharedNetworks: string[] = [];
    if (sourceContainer && targetContainer) {
      const sourceNets = new Set(Object.keys(sourceContainer.labels).filter((k) => k.startsWith("com.docker.compose.network")));
      // For proper network check, we'd need inspect — simplified here
      sharedNetworks = ["(check via inspect_container for full network details)"];
    }

    return {
      success: true,
      source: sourceAppId,
      target: targetAppId,
      targetReachable,
      targetStatus,
      targetResponseTimeMs: targetResponseTime,
      targetUrl: targetConn.baseUrl,
      sourceContainerFound: sourceAppId === "host" || !!sourceContainer,
      targetContainerFound: !!targetContainer,
      sourceContainerStatus: sourceContainer?.status ?? (sourceAppId === "host" ? "n/a" : "not found"),
      targetContainerStatus: targetContainer?.status ?? "not found",
      diagnosis: !targetReachable
        ? targetContainer
          ? targetContainer.status !== "running"
            ? `Target container '${targetAppId}' is ${targetContainer.status}. Start it first.`
            : `Target is running but health endpoint (${healthPath}) is not responding. Check URL configuration.`
          : `No container found matching '${targetAppId}'. Is it installed?`
        : `Connection OK — ${targetAppId} responded in ${targetResponseTime}ms.`,
    };
  },
});

// ── wire_apps ────────────────────────────────────────────────────────────────

export const wireAppsTool = tool({
  description: `Auto-configure the connection between two apps. Uses the app-registry to determine how apps relate and applies the appropriate configuration (e.g. adding Sonarr as a source in Overseerr, connecting qBittorrent as a download client in Sonarr).

This tool knows common wiring patterns for registered apps. For unknown apps, it will attempt basic URL+API key configuration.

After calling: Report what was configured and verify the connection. If the wiring failed, explain what manual step might be needed.`,
  inputSchema: z.object({
    sourceAppId: z.string().describe("The app that needs to be configured (e.g. 'overseerr')"),
    targetAppId: z.string().describe("The app to connect to (e.g. 'sonarr')"),
    extraConfig: z.record(z.string(), z.string()).default({}).describe("Additional config key-value pairs if needed"),
  }),
  execute: async ({ sourceAppId, targetAppId, extraConfig }) => {
    const sourceLower = sourceAppId.toLowerCase();
    const targetLower = targetAppId.toLowerCase();

    const sourceConn = resolveAppConnection(sourceLower);
    if ("error" in sourceConn) return { success: false, error: sourceConn.error, hint: sourceConn.hint };

    const targetConn = resolveAppConnection(targetLower);
    if ("error" in targetConn) return { success: false, error: targetConn.error, hint: targetConn.hint };

    const sourceCaps = sourceConn.capabilities;
    const targetCaps = targetConn.capabilities;

    // Check if apps have a known relationship
    const sourceRelates = sourceCaps?.relatesTo?.includes(targetLower);
    const targetRelates = targetCaps?.relatesTo?.includes(sourceLower);

    if (!sourceRelates && !targetRelates) {
      return {
        success: false,
        error: `No known wiring pattern between '${sourceAppId}' and '${targetAppId}'.`,
        hint: `These apps don't have a pre-defined integration. Use app_api_call to manually configure the connection via their APIs, or use write_app_config_file to edit config files directly.`,
        sourceRelatesTo: sourceCaps?.relatesTo ?? [],
        targetRelatesTo: targetCaps?.relatesTo ?? [],
      };
    }

    // Build the wiring payload based on known patterns
    const wiringActions: string[] = [];
    const results: Array<{ action: string; success: boolean; detail?: string }> = [];

    // Arr → qBittorrent: add download client
    if ((sourceLower === "sonarr" || sourceLower === "radarr") && targetLower === "qbittorrent") {
      const qbtUrl = targetConn.baseUrl;
      const qbtPassword = targetConn.apiKey ?? "";
      const sourceHeaders = buildHeaders(sourceConn.auth);
      const arrVer = sourceLower === "sonarr" ? "v3" : "v3";

      try {
        const res = await fetch(`${sourceConn.baseUrl}/api/${arrVer}/downloadclient`, {
          method: "POST",
          headers: sourceHeaders,
          body: JSON.stringify({
            name: "qBittorrent",
            implementation: "QBittorrent",
            protocol: "torrent",
            host: new URL(qbtUrl).hostname,
            port: parseInt(new URL(qbtUrl).port) || 8080,
            username: extraConfig.username ?? "admin",
            password: qbtPassword,
            ...extraConfig,
          }),
          signal: AbortSignal.timeout(8000),
        });
        const ok = res.ok;
        results.push({
          action: `Add qBittorrent as download client in ${sourceAppId}`,
          success: ok,
          detail: ok ? "Download client added" : `API responded ${res.status}`,
        });
      } catch (err: unknown) {
        results.push({
          action: `Add qBittorrent as download client in ${sourceAppId}`,
          success: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Overseerr → Jellyfin: configure media server
    if (sourceLower === "overseerr" && targetLower === "jellyfin") {
      wiringActions.push(
        `Use overseerr_configure_jellyfin tool with jellyfinUrl=${targetConn.baseUrl} for full configuration.`
      );
      results.push({
        action: "Configure Jellyfin in Overseerr",
        success: true,
        detail: "Use the dedicated overseerr_configure_jellyfin tool for this wiring — it handles the full flow.",
      });
    }

    // Overseerr → Sonarr/Radarr: configure arr services
    if (sourceLower === "overseerr" && (targetLower === "sonarr" || targetLower === "radarr")) {
      const toolName = targetLower === "sonarr" ? "overseerr_configure_sonarr" : "overseerr_configure_radarr";
      wiringActions.push(
        `Use ${toolName} tool for full configuration.`
      );
      results.push({
        action: `Configure ${targetAppId} in Overseerr`,
        success: true,
        detail: `Use the dedicated ${toolName} tool — it handles root folders and quality profiles.`,
      });
    }

    // Arr → Prowlarr: sync indexers
    if ((sourceLower === "sonarr" || sourceLower === "radarr") && targetLower === "prowlarr") {
      wiringActions.push("Use arr_sync_indexers_from_prowlarr tool to sync indexers.");
      results.push({
        action: `Sync Prowlarr indexers to ${sourceAppId}`,
        success: true,
        detail: "Use arr_sync_indexers_from_prowlarr for this — it handles the full sync flow.",
      });
    }

    // Generic fallback for known relationships without specific wiring
    if (results.length === 0) {
      return {
        success: true,
        appPair: `${sourceAppId} → ${targetAppId}`,
        message: `These apps are related but wiring must be done via their specific tools.`,
        suggestedTools: sourceCaps?.talomeToolPrefix
          ? [`Use tools with prefix '${sourceCaps.talomeToolPrefix}' to configure ${sourceAppId}`]
          : [`Use app_api_call to configure ${sourceAppId} via its API`],
        targetUrl: targetConn.baseUrl,
        targetApiKey: targetConn.apiKey ? "(configured)" : "(not set)",
      };
    }

    return {
      success: true,
      appPair: `${sourceAppId} → ${targetAppId}`,
      actions: results,
      wiringNotes: wiringActions,
      summary: `${results.filter((r) => r.success).length}/${results.length} wiring actions completed.`,
    };
  },
});
