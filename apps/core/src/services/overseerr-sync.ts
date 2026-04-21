import { EventEmitter } from "node:events";
import { getSetting } from "../utils/settings.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SyncStatus {
  apiReachable: boolean;
  sonarrConnected: boolean;
  radarrConnected: boolean;
  pendingRequests: number;
  approvedRequests: number;
  lastSyncCheck: string;
  issues: string[];
}

export interface TrackedRequest {
  requestId: number;
  timestamp: string;
  verified: boolean;
}

interface RequestCountSnapshot {
  pending: number;
  approved: number;
  timestamp: number;
}

// ── Event emitter ────────────────────────────────────────────────────────────

class OverseerrSyncEmitter extends EventEmitter {}

export const overseerrSyncEmitter = new OverseerrSyncEmitter();
overseerrSyncEmitter.setMaxListeners(20);

// ── Internal state ───────────────────────────────────────────────────────────

let lastSnapshot: RequestCountSnapshot | null = null;
const trackedRequests = new Map<number, TrackedRequest>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getConfig(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = getSetting("overseerr_url");
  const apiKey = getSetting("overseerr_api_key");
  if (!baseUrl || !apiKey) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
}

async function apiFetch(
  baseUrl: string,
  apiKey: string,
  path: string,
  method = "GET",
): Promise<{ ok: boolean; data?: unknown; status?: number }> {
  try {
    const res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      headers: { "X-Api-Key": apiKey, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("application/json") ? await res.json() : await res.text();
    return { ok: true, data };
  } catch {
    return { ok: false };
  }
}

// ── OverseerrSyncValidator ───────────────────────────────────────────────────

export class OverseerrSyncValidator {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  /** Test basic API connectivity via HEAD /api/v1/status */
  async checkApiReachable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/status`, {
        method: "HEAD",
        headers: { "X-Api-Key": this.apiKey },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Verify Sonarr integration is configured in Overseerr */
  async checkSonarrConnected(): Promise<boolean> {
    const result = await apiFetch(this.baseUrl, this.apiKey, "/settings/sonarr");
    if (!result.ok || !result.data) return false;
    const servers = result.data as Array<Record<string, unknown>>;
    return Array.isArray(servers) && servers.length > 0;
  }

  /** Verify Radarr integration is configured in Overseerr */
  async checkRadarrConnected(): Promise<boolean> {
    const result = await apiFetch(this.baseUrl, this.apiKey, "/settings/radarr");
    if (!result.ok || !result.data) return false;
    const servers = result.data as Array<Record<string, unknown>>;
    return Array.isArray(servers) && servers.length > 0;
  }

  /** Count pending and approved requests */
  async countRequests(): Promise<{ pending: number; approved: number }> {
    const [pendingRes, approvedRes] = await Promise.all([
      apiFetch(this.baseUrl, this.apiKey, "/request?take=1&filter=pending"),
      apiFetch(this.baseUrl, this.apiKey, "/request?take=1&filter=approved"),
    ]);

    const extractTotal = (res: { ok: boolean; data?: unknown }): number => {
      if (!res.ok || !res.data) return 0;
      const d = res.data as { pageInfo?: { results?: number } };
      return d.pageInfo?.results ?? 0;
    };

    return { pending: extractTotal(pendingRes), approved: extractTotal(approvedRes) };
  }

  /** Run all checks and return a full SyncStatus */
  async validate(): Promise<SyncStatus> {
    const issues: string[] = [];

    const apiReachable = await this.checkApiReachable();
    if (!apiReachable) {
      issues.push("Overseerr API is not reachable");
      return {
        apiReachable: false,
        sonarrConnected: false,
        radarrConnected: false,
        pendingRequests: 0,
        approvedRequests: 0,
        lastSyncCheck: new Date().toISOString(),
        issues,
      };
    }

    const [sonarrConnected, radarrConnected, counts] = await Promise.all([
      this.checkSonarrConnected(),
      this.checkRadarrConnected(),
      this.countRequests(),
    ]);

    if (!sonarrConnected) issues.push("Sonarr integration not verified");
    if (!radarrConnected) issues.push("Radarr integration not verified");

    // Compare to stored snapshot (1 hour staleness)
    const now = Date.now();
    if (lastSnapshot && now - lastSnapshot.timestamp < 3600_000) {
      const pendingDelta = counts.pending - lastSnapshot.pending;
      if (pendingDelta > 10) {
        issues.push(
          `Pending requests grew by ${pendingDelta} since last check — requests may not be processing`,
        );
      }
    }

    // Store new snapshot
    lastSnapshot = { pending: counts.pending, approved: counts.approved, timestamp: now };

    return {
      apiReachable,
      sonarrConnected,
      radarrConnected,
      pendingRequests: counts.pending,
      approvedRequests: counts.approved,
      lastSyncCheck: new Date().toISOString(),
      issues,
    };
  }
}

// ── Request tracking & follow-up verification ────────────────────────────────

/**
 * Log a request that was made through the Overseerr integration,
 * then schedule a 10-second follow-up check to verify it appears in the queue.
 */
export function trackOverseerrRequest(requestId: number): void {
  const entry: TrackedRequest = {
    requestId,
    timestamp: new Date().toISOString(),
    verified: false,
  };
  trackedRequests.set(requestId, entry);

  setTimeout(() => {
    void verifyRequestInQueue(requestId);
  }, 10_000);
}

async function verifyRequestInQueue(requestId: number): Promise<void> {
  const config = getConfig();
  if (!config) return;

  const result = await apiFetch(config.baseUrl, config.apiKey, `/request/${requestId}`);

  const entry = trackedRequests.get(requestId);
  if (!entry) return;

  if (result.ok && result.data) {
    entry.verified = true;
    trackedRequests.set(requestId, entry);
    return;
  }

  // Request not found — emit diagnostic event
  overseerrSyncEmitter.emit("overseerr_request_not_synced", {
    requestId,
    timestamp: entry.timestamp,
    suggestions: [
      "Check that Overseerr can reach Sonarr/Radarr (Settings > Services)",
      "Verify the API key has not been rotated",
      "Look at the Overseerr container logs for errors",
      "Ensure the media type (movie/tv) has a default server configured",
    ],
  });
}

/** Get all tracked requests (for diagnostics) */
export function getTrackedRequests(): TrackedRequest[] {
  return Array.from(trackedRequests.values());
}

// ── Route handler ────────────────────────────────────────────────────────────

/**
 * Build a SyncStatus from current config, or return an error status
 * if Overseerr is not configured.
 */
export async function getSyncStatus(): Promise<SyncStatus | { error: string }> {
  const config = getConfig();
  if (!config) {
    return { error: "Overseerr is not configured (missing overseerr_url or overseerr_api_key)" };
  }
  const validator = new OverseerrSyncValidator(config.baseUrl, config.apiKey);
  return validator.validate();
}
