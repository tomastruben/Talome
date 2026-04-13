/**
 * Setup Loop Engine — Autonomous App Configuration
 *
 * Uses Haiku with generateText() to configure installed apps via a constrained
 * tool set. Each iteration: compute health, inject context, call AI, log results.
 *
 * Inspired by autoresearch: fixed budget, immutable eval (health score),
 * negative result logging (failed approaches), Markdown-as-program.
 */

import { generateText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { getSetting } from "../utils/settings.js";
import { shouldRunService } from "../agent-loop/budget.js";
import { logAiUsage } from "../agent-loop/budget.js";
import { computeHealthScore, type ServerHealthScore } from "./health-score.js";
import { logAttempt, getAllFailedApproaches, getRunAttempts } from "./results-log.js";
import { emitSetupEvent } from "./setup-emitter.js";

// Tools — import the constrained set
import { setSettingTool, getSettingsTool } from "../ai/tools/settings-tools.js";
import { testAppConnectivityTool, wireAppsTool, appApiCallTool } from "../ai/tools/universal-tools.js";
import { readAppConfigFileTool, listAppConfigFilesTool } from "../ai/tools/config-tools.js";
import { execContainerTool, getContainerLogsTool, listContainersTool } from "../ai/tools/docker-tools.js";
import { jellyfinCreateApiKeyTool } from "../ai/tools/jellyfin-tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ─────────────────────────────────────────────────────────────────

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const MAX_ITERATIONS = 30;
const ITERATION_TIMEOUT_MS = 120_000;
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const NO_IMPROVEMENT_LIMIT = 3;

// ── State ─────────────────────────────────────────────────────────────────────

let currentRunId: string | null = null;
let pauseRequested = false;

// ── Constrained tool set for the setup agent ──────────────────────────────────

const SETUP_TOOLS = {
  set_setting: setSettingTool,
  get_settings: getSettingsTool,
  test_app_connectivity: testAppConnectivityTool,
  wire_apps: wireAppsTool,
  read_app_config_file: readAppConfigFileTool,
  list_app_config_files: listAppConfigFilesTool,
  exec_container: execContainerTool,
  get_container_logs: getContainerLogsTool,
  list_containers: listContainersTool,
  app_api_call: appApiCallTool,
  jellyfin_create_api_key: jellyfinCreateApiKeyTool,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function generateRunId(): string {
  return `sr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getSetupProgram(): string {
  try {
    return readFileSync(resolve(__dirname, "../ai/knowledge/setup-program.md"), "utf-8");
  } catch {
    return "Configure every installed app to 100% health score using available tools.";
  }
}

function buildHealthContext(health: ServerHealthScore): string {
  const lines = [`## Current Health Score: ${health.overall}%`, ""];
  for (const app of health.apps) {
    const status = app.score === 100 ? "OK" : `${app.score}%`;
    lines.push(`- **${app.name}** (${app.appId}): ${status}`);
    if (app.issues.length > 0) {
      for (const issue of app.issues) {
        lines.push(`  - ${issue}`);
      }
    }
  }
  return lines.join("\n");
}

function buildFailedContext(): string {
  const failed = getAllFailedApproaches();
  if (failed.length === 0) return "No previous failures.";

  const lines = ["## Previously Failed Approaches (DO NOT retry these):", ""];
  for (const f of failed) {
    lines.push(`- **${f.appId}** / ${f.action}: "${f.approach}" → ${f.error ?? "unknown error"}`);
  }
  return lines.join("\n");
}

function buildSettingsContext(): string {
  const keys = [
    "sonarr_url", "sonarr_api_key", "radarr_url", "radarr_api_key",
    "prowlarr_url", "prowlarr_api_key", "jellyfin_url", "jellyfin_api_key",
    "qbittorrent_url", "qbittorrent_password", "overseerr_url", "overseerr_api_key",
    "readarr_url", "readarr_api_key", "audiobookshelf_url", "audiobookshelf_api_key",
    "homeassistant_url", "homeassistant_token", "pihole_url", "pihole_api_key",
    "vaultwarden_url", "vaultwarden_admin_token",
  ];
  const lines = ["## Current Settings:", ""];
  for (const key of keys) {
    const val = getSetting(key);
    if (key.includes("key") || key.includes("token") || key.includes("password")) {
      lines.push(`- ${key}: ${val ? "***SET***" : "NOT SET"}`);
    } else {
      lines.push(`- ${key}: ${val ?? "NOT SET"}`);
    }
  }
  return lines.join("\n");
}

// ── Core Loop ─────────────────────────────────────────────────────────────────

export function isSetupRunning(): boolean {
  return currentRunId !== null;
}

export function pauseSetup(runId: string): void {
  if (currentRunId === runId) {
    pauseRequested = true;
  }
}

/** Start a new setup run. Returns the run ID. */
export async function startSetupRun(trigger: string): Promise<string> {
  if (currentRunId) {
    throw new Error("A setup run is already in progress");
  }

  const apiKey = getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("No Anthropic API key configured — cannot run setup loop");
  }

  const runId = generateRunId();
  const now = new Date().toISOString();

  // Compute initial health score
  const healthBefore = await computeHealthScore();

  // Create the run record
  db.run(sql`
    INSERT INTO setup_runs (id, status, trigger, health_score_before, apps_targeted, started_at)
    VALUES (${runId}, 'running', ${trigger}, ${healthBefore.overall}, ${JSON.stringify(healthBefore.apps.map((a) => a.appId))}, ${now})
  `);

  currentRunId = runId;
  pauseRequested = false;

  emitSetupEvent({
    type: "started",
    runId,
    message: `Setup run started (trigger: ${trigger}), health: ${healthBefore.overall}%`,
    healthScore: healthBefore.overall,
    appScores: healthBefore.apps.map((a) => ({ appId: a.appId, name: a.name, score: a.score })),
  });

  // Run the loop in the background — don't await
  void executeSetupLoop(runId, apiKey, healthBefore).catch((err) => {
    completeRun(runId, "failed", err instanceof Error ? err.message : "Unknown error");
  });

  return runId;
}

async function executeSetupLoop(
  runId: string,
  apiKey: string,
  initialHealth: ServerHealthScore,
): Promise<void> {
  const model = createAnthropic({ apiKey })(HAIKU_MODEL);
  const program = getSetupProgram();
  const runStart = Date.now();

  let health = initialHealth;
  let previousScore = health.overall;
  let noImprovementCount = 0;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    // Budget gate
    const budget = shouldRunService("setup_loop");
    if (!budget.allowed) {
      completeRun(runId, "paused", budget.reason);
      return;
    }

    // Pause requested
    if (pauseRequested) {
      completeRun(runId, "paused", "Paused by user");
      return;
    }

    // Run timeout
    if (Date.now() - runStart > RUN_TIMEOUT_MS) {
      completeRun(runId, "paused", "15-minute run timeout reached");
      return;
    }

    // Perfect score — done
    if (health.overall === 100) {
      completeRun(runId, "completed");
      return;
    }

    // No improvement limit
    if (noImprovementCount >= NO_IMPROVEMENT_LIMIT) {
      const remaining = health.apps
        .filter((a) => a.score < 100)
        .map((a) => `${a.name}: ${a.issues.join(", ")}`)
        .join("; ");
      completeRun(runId, "paused", `No improvement for ${NO_IMPROVEMENT_LIMIT} iterations. Remaining: ${remaining}`);
      return;
    }

    emitSetupEvent({
      type: "iteration",
      runId,
      iteration,
      message: `Iteration ${iteration}, health: ${health.overall}%`,
      healthScore: health.overall,
    });

    // Build dynamic context
    const healthContext = buildHealthContext(health);
    const failedContext = buildFailedContext();
    const settingsContext = buildSettingsContext();

    const systemPrompt = `${program}\n\n---\n\n${healthContext}\n\n${failedContext}\n\n${settingsContext}`;

    const iterationStart = Date.now();

    try {
      // Collect tool call data via onStepFinish callback
      const stepData: Array<{
        toolName: string;
        input: Record<string, unknown>;
        resultJson: string;
        isError: boolean;
      }> = [];

      const result = await Promise.race([
        generateText({
          model,
          system: systemPrompt,
          prompt: `Iteration ${iteration}. Current health score: ${health.overall}%. Pick the most impactful action to improve the score. Focus on apps with the lowest scores whose dependencies are met.`,
          tools: SETUP_TOOLS,
          stopWhen: stepCountIs(5),
          maxRetries: 1,
          onStepFinish: ({ toolCalls, toolResults }) => {
            if (!toolCalls) return;
            for (let i = 0; i < toolCalls.length; i++) {
              const call = toolCalls[i];
              const tr = toolResults?.[i];
              const resultStr = tr ? JSON.stringify(tr) : "{}";
              const isErr = resultStr.includes('"error"');
              stepData.push({
                toolName: call.toolName,
                input: (call as any).args ?? (call as any).input ?? {},
                resultJson: resultStr.slice(0, 500),
                isError: isErr,
              });
            }
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Iteration timeout")), ITERATION_TIMEOUT_MS),
        ),
      ]);

      // Log AI usage
      logAiUsage({
        model: HAIKU_MODEL,
        tokensIn: result.usage?.inputTokens ?? 0,
        tokensOut: result.usage?.outputTokens ?? 0,
        context: "setup_loop",
      });

      // Log tool call results as attempts
      for (const step of stepData) {
        const duration = Date.now() - iterationStart;
        logAttempt({
          runId,
          appId: (step.input.appId as string) ?? (step.input.app_id as string) ?? "unknown",
          action: step.toolName,
          approach: JSON.stringify(step.input).slice(0, 200),
          status: step.isError ? "failure" : "success",
          result: step.isError ? undefined : step.resultJson,
          error: step.isError ? step.resultJson : undefined,
          durationMs: duration,
          settingsChanged: step.toolName === "set_setting"
            ? [(step.input.key as string)]
            : undefined,
        });

        emitSetupEvent({
          type: "attempt",
          runId,
          appId: (step.input.appId as string) ?? (step.input.app_id as string),
          action: step.toolName,
          approach: JSON.stringify(step.input).slice(0, 100),
          message: step.isError ? "Failed" : "Success",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      logAttempt({
        runId,
        appId: "system",
        action: "generate_text",
        approach: `iteration_${iteration}`,
        status: "failure",
        error: msg,
        durationMs: Date.now() - iterationStart,
      });

      // Don't abort on a single iteration failure — try next
      if (msg === "Iteration timeout") continue;
    }

    // Re-compute health score
    health = await computeHealthScore();

    emitSetupEvent({
      type: "health_update",
      runId,
      healthScore: health.overall,
      appScores: health.apps.map((a) => ({ appId: a.appId, name: a.name, score: a.score })),
    });

    // Track improvement
    if (health.overall > previousScore) {
      noImprovementCount = 0;
    } else {
      noImprovementCount++;
    }
    previousScore = health.overall;
  }

  // Exhausted iterations
  completeRun(runId, "paused", `Reached max iterations (${MAX_ITERATIONS})`);
}

function completeRun(runId: string, status: "completed" | "paused" | "failed", error?: string): void {
  const now = new Date().toISOString();

  // Compute final health score
  computeHealthScore()
    .then((health) => {
      db.run(sql`
        UPDATE setup_runs
        SET status = ${status}, health_score_after = ${health.overall}, completed_at = ${now}, error = ${error ?? null}
        WHERE id = ${runId}
      `);
    })
    .catch(() => {
      db.run(sql`
        UPDATE setup_runs
        SET status = ${status}, completed_at = ${now}, error = ${error ?? null}
        WHERE id = ${runId}
      `);
    });

  currentRunId = null;
  pauseRequested = false;

  emitSetupEvent({
    type: status === "completed" ? "completed" : status === "paused" ? "paused" : "failed",
    runId,
    message: error ?? (status === "completed" ? "All apps configured successfully" : "Setup run ended"),
    error,
  });
}

/** Get a specific run with its attempts. */
export function getSetupRun(runId: string) {
  const run = db.get<{
    id: string;
    status: string;
    trigger: string;
    health_score_before: number | null;
    health_score_after: number | null;
    apps_targeted: string;
    attempts_count: number;
    started_at: string;
    completed_at: string | null;
    error: string | null;
  }>(sql`SELECT * FROM setup_runs WHERE id = ${runId}`);

  if (!run) return null;

  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    healthScoreBefore: run.health_score_before,
    healthScoreAfter: run.health_score_after,
    appsTargeted: JSON.parse(run.apps_targeted) as string[],
    attemptsCount: run.attempts_count,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    error: run.error,
    attempts: getRunAttempts(runId),
  };
}

/** List recent setup runs. */
export function listSetupRuns(limit = 20) {
  return db.all<{
    id: string;
    status: string;
    trigger: string;
    health_score_before: number | null;
    health_score_after: number | null;
    attempts_count: number;
    started_at: string;
    completed_at: string | null;
    error: string | null;
  }>(sql`SELECT * FROM setup_runs ORDER BY started_at DESC LIMIT ${limit}`).map((r) => ({
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    healthScoreBefore: r.health_score_before,
    healthScoreAfter: r.health_score_after,
    attemptsCount: r.attempts_count,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    error: r.error,
  }));
}
