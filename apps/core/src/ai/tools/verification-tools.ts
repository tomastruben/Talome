import { tool } from "ai";
import { z } from "zod";
import {
  listProbedApps,
  listVerifiableStacks,
  verifyApp,
  verifyStack,
  type VerificationResult,
} from "../../verification/index.js";

function compact(result: VerificationResult) {
  return {
    target: `${result.targetType}:${result.targetId}`,
    status: result.status,
    summary: result.summary,
    verifiedAt: result.verifiedAt,
    chain: result.chain?.map((l) => ({ link: l.label, status: l.status })),
    checks: result.checks.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      evidence: c.evidence,
      ...(c.remediation && c.status !== "pass" ? { remediation: c.remediation } : {}),
    })),
  };
}

// ── verify_app_outcome ───────────────────────────────────────────────────────

export const verifyAppOutcomeTool = tool({
  description: `Verify that an app or stack actually WORKS for the user — not just that its container is running. Runs read-only semantic probes against the app's own API and returns status (verified | degraded | failed | unknown) with per-check evidence and remediation.
Apps: Jellyfin (API key, libraries, library folders exist), Sonarr/Radarr/Readarr (API key, root folder accessible, download client healthy, indexers), Prowlarr (indexers, sync to *arr), qBittorrent (login, save path visible to the *arr), Immich (server, storage, phone-backup URL), Audiobookshelf (libraries), Home Assistant (API, core state), Overseerr/Jellyseerr (media server + Sonarr/Radarr connectivity).
Stacks: media-server (request → indexer → download → import → library, incl. path mapping between qBittorrent, the *arr apps and Jellyfin), photo-management, books, smart-home.
Use after installing or wiring apps, and when the user says something "doesn't work". Fix failed checks using their remediation, then verify again.`,
  inputSchema: z.object({
    appId: z.string().min(1).max(64).optional().describe("App to verify, e.g. 'sonarr', 'jellyfin', 'immich'"),
    stackId: z.string().min(1).max(64).optional().describe("Stack to verify end-to-end, e.g. 'media-server', 'photo-management'"),
  }),
  execute: async ({ appId, stackId }) => {
    if (!appId && !stackId) {
      return {
        success: false,
        error: "Provide appId or stackId.",
        verifiableApps: listProbedApps(),
        verifiableStacks: listVerifiableStacks().map((s) => s.id),
      };
    }
    // Read tier: active (side-effecting) probes are never run from the assistant.
    const outcome = stackId ? await verifyStack(stackId) : await verifyApp(appId as string);
    if (!outcome.ok) {
      return {
        success: false,
        error: outcome.error,
        verifiableApps: listProbedApps(),
        verifiableStacks: listVerifiableStacks().map((s) => s.id),
      };
    }
    return { success: true, ...compact(outcome.result) };
  },
});
