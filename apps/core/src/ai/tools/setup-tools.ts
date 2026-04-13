/**
 * AI Tools — Setup status + trigger.
 *
 * Users can ask "how configured is my server?" or "set up my server" via chat.
 */

import { tool } from "ai";
import { z } from "zod";
import { computeHealthScore } from "../../setup/health-score.js";
import { startSetupRun, isSetupRunning, listSetupRuns } from "../../setup/loop.js";

export const checkSetupStatusTool = tool({
  description:
    "Check the setup/health status of all installed apps. Shows which apps are configured, " +
    "which need setup, and what's missing (API keys, URLs, connectivity, wiring).",
  inputSchema: z.object({}),
  execute: async () => {
    const health = await computeHealthScore();
    const running = isSetupRunning();
    const recentRuns = listSetupRuns(3);

    return {
      overallScore: health.overall,
      configured: health.configured,
      total: health.total,
      setupRunning: running,
      apps: health.apps.map((a) => ({
        appId: a.appId,
        name: a.name,
        score: a.score,
        issues: a.issues,
      })),
      recentRuns: recentRuns.map((r) => ({
        id: r.id,
        status: r.status,
        trigger: r.trigger,
        healthBefore: r.healthScoreBefore,
        healthAfter: r.healthScoreAfter,
        startedAt: r.startedAt,
      })),
    };
  },
});

export const startSetupTool = tool({
  description:
    "Start the autonomous setup loop to automatically configure all installed apps. " +
    "Extracts API keys, sets URLs, wires services together. Returns a run ID to track progress.",
  inputSchema: z.object({
    reason: z
      .string()
      .optional()
      .describe("Optional reason for triggering the setup (e.g. user request, new app installed)"),
  }),
  execute: async ({ reason }) => {
    if (isSetupRunning()) {
      return { status: "already_running", message: "A setup run is already in progress." };
    }

    try {
      const runId = await startSetupRun(reason ?? "user_request");
      return {
        status: "started",
        runId,
        message: "Setup loop started. It will automatically configure apps and report progress.",
      };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : "Failed to start setup loop",
      };
    }
  },
});
