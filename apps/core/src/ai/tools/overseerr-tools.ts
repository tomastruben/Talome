import { tool } from "ai";
import { z } from "zod";
import { getSetting } from "../../utils/settings.js";

interface OverseerrConfig {
  baseUrl: string;
  apiKey: string;
}

function getOverseerrConfig(): OverseerrConfig | null {
  const baseUrl = getSetting("overseerr_url");
  const apiKey = getSetting("overseerr_api_key");
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function overseerrFetch(path: string, options?: RequestInit): Promise<{ success: boolean; data?: unknown; error?: string; hint?: string }> {
  const config = getOverseerrConfig();
  if (!config) {
    return {
      success: false,
      error: "Overseerr API credentials are missing (overseerr_url and/or overseerr_api_key).",
      hint:
        "Use config automation: discover paths with get_app_config, then edit Overseerr config via read_app_config_file/write_app_config_file and restart the app.",
    };
  }
  try {
    const res = await fetch(`${config.baseUrl}/api/v1${path}`, {
      ...options,
      headers: {
        "X-Api-Key": config.apiKey,
        "Content-Type": "application/json",
        ...(options?.headers ?? {}),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, error: `Overseerr API error ${res.status}: ${text}` };
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { success: true, data };
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── overseerr_get_status ──────────────────────────────────────────────────────

export const overseerrGetStatusTool = tool({
  description: "Get Overseerr status, version, and whether initial setup is complete.",
  inputSchema: z.object({}),
  execute: async () => {
    const result = await overseerrFetch("/status");
    if (!result.success) return result;
    return { success: true, status: result.data };
  },
});

// ── overseerr_configure_jellyfin ──────────────────────────────────────────────

export const overseerrConfigureJellyfinTool = tool({
  description: "Connect Overseerr to a Jellyfin server. This is required during Overseerr first-time setup.",
  inputSchema: z.object({
    hostname: z.string().describe("Jellyfin hostname (Docker service name or IP), e.g. 'jellyfin'"),
    port: z.number().default(8096).describe("Jellyfin port"),
    apiKey: z.string().describe("Jellyfin API key"),
    useSsl: z.boolean().default(false).describe("Use HTTPS"),
    urlBase: z.string().default("").describe("URL base path if Jellyfin is behind a reverse proxy"),
  }),
  execute: async ({ hostname, port, apiKey, useSsl, urlBase }) => {
    const body = { hostname, port, apiKey, useSsl, urlBase };
    const result = await overseerrFetch("/settings/jellyfin", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result.success) return result;
    return { success: true, message: `Overseerr connected to Jellyfin at ${hostname}:${port}.` };
  },
});

// ── overseerr_configure_sonarr ────────────────────────────────────────────────

export const overseerrConfigureSonarrTool = tool({
  description: "Add Sonarr as a server in Overseerr so users can request TV shows.",
  inputSchema: z.object({
    name: z.string().default("Sonarr").describe("Display name"),
    hostname: z.string().describe("Sonarr hostname (Docker service name or IP)"),
    port: z.number().default(8989).describe("Sonarr port"),
    apiKey: z.string().describe("Sonarr API key"),
    useSsl: z.boolean().default(false).describe("Use HTTPS"),
    isDefault: z.boolean().default(true).describe("Set as default Sonarr server"),
    qualityProfileId: z.number().optional().describe("Quality profile ID"),
    rootFolderPath: z.string().optional().describe("Root folder path, e.g. /data/media/tv"),
  }),
  execute: async ({ name, hostname, port, apiKey, useSsl, isDefault, qualityProfileId, rootFolderPath }) => {
    const body = {
      name,
      hostname,
      port,
      apiKey,
      useSsl,
      isDefault,
      activeProfileId: qualityProfileId,
      rootFolder: rootFolderPath,
    };
    const result = await overseerrFetch("/settings/sonarr", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result.success) return result;
    return { success: true, message: `Sonarr server '${name}' added to Overseerr.`, server: result.data };
  },
});

// ── overseerr_configure_radarr ────────────────────────────────────────────────

export const overseerrConfigureRadarrTool = tool({
  description: "Add Radarr as a server in Overseerr so users can request movies.",
  inputSchema: z.object({
    name: z.string().default("Radarr").describe("Display name"),
    hostname: z.string().describe("Radarr hostname (Docker service name or IP)"),
    port: z.number().default(7878).describe("Radarr port"),
    apiKey: z.string().describe("Radarr API key"),
    useSsl: z.boolean().default(false).describe("Use HTTPS"),
    isDefault: z.boolean().default(true).describe("Set as default Radarr server"),
    qualityProfileId: z.number().optional().describe("Quality profile ID"),
    rootFolderPath: z.string().optional().describe("Root folder path, e.g. /data/media/movies"),
  }),
  execute: async ({ name, hostname, port, apiKey, useSsl, isDefault, qualityProfileId, rootFolderPath }) => {
    const body = {
      name,
      hostname,
      port,
      apiKey,
      useSsl,
      isDefault,
      activeProfileId: qualityProfileId,
      rootFolder: rootFolderPath,
    };
    const result = await overseerrFetch("/settings/radarr", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!result.success) return result;
    return { success: true, message: `Radarr server '${name}' added to Overseerr.`, server: result.data };
  },
});

// ── overseerr_list_requests ───────────────────────────────────────────────────

export const overseerrListRequestsTool = tool({
  description: "List pending or recent media requests in Overseerr.",
  inputSchema: z.object({
    status: z.enum(["all", "pending", "approved", "declined", "available"]).default("pending"),
    take: z.number().default(20).describe("Number of requests to return"),
  }),
  execute: async ({ status, take }) => {
    const filter = status === "all" ? "" : `&filter=${status}`;
    const result = await overseerrFetch(`/request?take=${take}&sort=added${filter}`);
    if (!result.success) return result;
    const res = result.data as { results: Array<Record<string, unknown>>; pageInfo: unknown };
    const requests = (res.results ?? []).map((r) => ({
      id: r.id,
      status: r.status,
      type: r.type,
      createdAt: r.createdAt,
      media: (r.media as Record<string, unknown>)?.title ?? (r.media as Record<string, unknown>)?.name,
    }));
    return { success: true, requests, total: (res.pageInfo as Record<string, unknown>)?.results };
  },
});

// ── overseerr_approve_request ─────────────────────────────────────────────────

export const overseerrApproveRequestTool = tool({
  description: "Approve a pending media request in Overseerr. Use overseerr_list_requests to get request IDs.",
  inputSchema: z.object({
    requestId: z.number().describe("The request ID to approve"),
  }),
  execute: async ({ requestId }) => {
    const result = await overseerrFetch(`/request/${requestId}/approve`, { method: "POST" });
    if (!result.success) return result;
    return { success: true, message: `Request ${requestId} approved.` };
  },
});

// ── overseerr_decline_request ───────────────────────────────────────────────

export const overseerrDeclineRequestTool = tool({
  description: "Decline a pending media request in Overseerr. Use overseerr_list_requests to get request IDs.",
  inputSchema: z.object({
    requestId: z.number().describe("The request ID to decline"),
  }),
  execute: async ({ requestId }) => {
    const result = await overseerrFetch(`/request/${requestId}/decline`, { method: "POST" });
    if (!result.success) return result;
    return { success: true, message: `Request ${requestId} declined.` };
  },
});
