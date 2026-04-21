// ── Tier 2: Remediation (API or local Claude Code) ─────────────────────────

import { generateText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { db, schema } from "../db/index.js";
import { eq, and } from "drizzle-orm";
import { checkBudget, logAiUsage, shouldRunService } from "./budget.js";
import { writeNotification } from "../db/notifications.js";
import { writeAuditEntry } from "../db/audit.js";
import { isClaudeCodeAvailable, spawnClaudeStreaming } from "../ai/claude-process.js";
import { resolve } from "node:path";
import type { SystemEvent, TriageResult, RemediationResult } from "./types.js";

// Import tool definitions for the remediation agent to use
import { listContainersTool, getContainerLogsTool, restartContainerTool, checkServiceHealthTool } from "../ai/tools/docker-tools.js";
import { getSystemStatsTool, getDiskUsageTool, getSystemHealthTool } from "../ai/tools/system-tools.js";
import { diagnoseAppTool } from "../ai/tools/diagnose-tool.js";
import { arrGetStatusTool, arrGetQueueDetailsTool, arrListDownloadClientsTool } from "../ai/tools/arr-tools.js";
import { qbtListTorrentsTool } from "../ai/tools/qbittorrent-tools.js";
import { jellyfinGetStatusTool, jellyfinScanLibraryTool } from "../ai/tools/jellyfin-tools.js";
import { cleanupDockerTool } from "../ai/tools/storage-tools.js";
import { searchContainerLogsTool } from "../ai/tools/log-tools.js";
import { rollbackUpdateTool, checkDependenciesTool } from "../ai/tools/app-tools.js";

function getApiKey(): string | undefined {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "anthropic_key"))
      .get();
    return row?.value || process.env.ANTHROPIC_API_KEY;
  } catch {
    return process.env.ANTHROPIC_API_KEY;
  }
}

function getModel(): string {
  return process.env.DEFAULT_MODEL || "claude-haiku-4-5-20251001";
}

/** Project root for Claude Code — two levels up from apps/core */
const PROJECT_ROOT = resolve(import.meta.dirname ?? process.cwd(), "..", "..", "..", "..");

const WRITE_TOOLS = new Set(["restart_container", "cleanup_docker", "jellyfin_scan_library", "rollback_update"]);

/** Tools available to the remediation agent — read-heavy, limited writes */
const REMEDIATION_TOOLS = {
  // Core diagnostic (read)
  list_containers: listContainersTool,
  get_container_logs: getContainerLogsTool,
  search_container_logs: searchContainerLogsTool,
  check_service_health: checkServiceHealthTool,
  get_system_stats: getSystemStatsTool,
  get_disk_usage: getDiskUsageTool,
  get_system_health: getSystemHealthTool,
  diagnose_app: diagnoseAppTool,

  // App-level diagnosis (read)
  arr_get_status: arrGetStatusTool,
  arr_get_queue_details: arrGetQueueDetailsTool,
  arr_list_download_clients: arrListDownloadClientsTool,
  qbt_list_torrents: qbtListTorrentsTool,
  jellyfin_get_status: jellyfinGetStatusTool,

  // Dependency graph (read)
  check_dependencies: checkDependenciesTool,

  // Safe remediation actions (write)
  restart_container: restartContainerTool,
  cleanup_docker: cleanupDockerTool,
  jellyfin_scan_library: jellyfinScanLibraryTool,
  rollback_update: rollbackUpdateTool,
};

/** Build the system prompt for both API and Claude Code paths */
function buildSystemPrompt(autoRemediate: boolean, eventType?: string): string {
  const isPostUpdateCrash = eventType === "post_update_crash_loop";

  const writeRules = autoRemediate
    ? `You MAY take corrective action:
  - Restart containers if investigation suggests it will help
  - Clean up Docker resources (prune) if disk is critically full
  - Trigger Jellyfin library rescans if scan appears stuck
  ${isPostUpdateCrash ? "- Use rollback_update to revert an app to its previous version if the crash loop started after an update" : ""}
  - Use check_dependencies before restarting — if a service depends on another that is also down, restart the dependency FIRST
  - You MUST NOT modify app configurations, delete user data, or uninstall apps
  - Never restart more than 2 containers per remediation (the failing one + at most one dependency)`
    : "Do NOT take corrective action — only diagnose and report";

  return `You are Talome's autonomous background agent. You've been triggered by an event that requires investigation and possible remediation.

Rules:
- Investigate the issue using available tools (read logs, check app health, check queue status, etc.)
- ${writeRules}
- Use app-specific tools when available (arr_get_status, qbt_list_torrents, jellyfin_get_status) for deeper diagnosis
- Be concise — output a brief diagnosis and what you did (or recommend)
- Format: 1) Diagnosis  2) Action taken (or recommended)  3) Confidence (low/medium/high)`;
}

/** Build the event prompt for both paths */
function buildEventPrompt(event: SystemEvent, triage: TriageResult, autoRemediate: boolean): string {
  return `System event detected:
Type: ${event.type}
Severity: ${event.severity}
Source: ${event.source}
Message: ${event.message}
Data: ${JSON.stringify(event.data)}

Triage assessment: ${triage.reason}
${triage.suggestedAction ? `Suggested action: ${triage.suggestedAction}` : ""}

Investigate this issue and ${autoRemediate ? "take corrective action if appropriate" : "report your findings"}.`;
}

/** Parse confidence level from response text */
function parseConfidence(text: string): number {
  if (/confidence:\s*high/i.test(text)) return 0.9;
  if (/confidence:\s*medium/i.test(text)) return 0.6;
  if (/confidence:\s*low/i.test(text)) return 0.3;
  return 0.5;
}

/** Common post-processing: notifications, audit, DB persistence */
function finalizeRemediation(
  event: SystemEvent,
  responseText: string,
  toolsUsed: string[],
  model: string,
): RemediationResult {
  const confidence = parseConfidence(responseText);
  const tookAction = toolsUsed.some((t) => WRITE_TOOLS.has(t));

  writeNotification(
    tookAction ? "warning" : "info",
    `Agent ${tookAction ? "fixed" : "diagnosed"}: ${event.source}`,
    responseText.slice(0, 1200),
    "agent-loop",
  );

  writeAuditEntry(
    `Agent loop: ${tookAction ? "remediated" : "diagnosed"} ${event.type} on ${event.source}`,
    tookAction ? "modify" : "read",
    JSON.stringify({ eventId: event.id, toolsUsed }),
  );

  const rolledBack = toolsUsed.includes("rollback_update");
  const actionLabel = rolledBack
    ? "Rolled back + diagnosed"
    : tookAction ? "Restarted + diagnosed" : "Diagnosis only";

  const result: RemediationResult = {
    eventId: event.id,
    action: actionLabel,
    model,
    confidence,
    outcome: "pending",
    details: responseText.slice(0, 500),
  };

  try {
    db.insert(schema.remediationLog)
      .values({
        id: crypto.randomUUID(),
        eventId: event.id,
        action: result.action,
        model,
        confidence,
        outcome: "pending",
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch {
    // Non-fatal
  }

  return result;
}

// ── Smart abort: stop retrying after repeated failures ──────────────────────

const MAX_REMEDIATION_ATTEMPTS = 2;

/**
 * Check if remediation for this source has failed too many times recently.
 * Looks at all failed remediations for events from the same source (container)
 * within the last 4 hours to avoid infinite retry loops.
 */
function hasExceededRetries(eventSource: string): boolean {
  try {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    // Find recent events from the same source
    const recentEvents = db
      .select({ id: schema.systemEvents.id })
      .from(schema.systemEvents)
      .where(eq(schema.systemEvents.source, eventSource))
      .all();

    if (recentEvents.length === 0) return false;

    const eventIds = new Set(recentEvents.map((e) => e.id));

    // Count failed remediations for those events within the window
    const recentFailed = db
      .select()
      .from(schema.remediationLog)
      .where(eq(schema.remediationLog.outcome, "failure"))
      .all()
      .filter((r) => eventIds.has(r.eventId) && r.createdAt && r.createdAt >= fourHoursAgo);

    return recentFailed.length >= MAX_REMEDIATION_ATTEMPTS;
  } catch {
    return false;
  }
}

// ── Shared gate checks (budget zone + rate limit) ──────────────────────────

function checkGates(
  event: SystemEvent,
  triage: TriageResult,
  maxPerHour: number,
): RemediationResult | null {
  const zoneCheck = shouldRunService("remediation", event.severity as import("./types.js").EventSeverity);
  if (!zoneCheck.allowed) {
    console.log(`[agent-loop] ${zoneCheck.reason}`);
    writeNotification(
      "warning",
      `Agent: ${event.message}`,
      `Remediation deferred: ${zoneCheck.reason}. Triage: ${triage.reason}`,
      "agent-loop",
    );
    return {
      eventId: event.id,
      action: "zone_restricted",
      model: "none",
      confidence: 0,
      outcome: "failure",
      details: zoneCheck.reason ?? "Budget zone restriction",
    };
  }

  if (!checkBudget("remediation", maxPerHour)) {
    console.log("[agent-loop] Remediation rate limit reached — notifying instead");
    writeNotification(
      "warning",
      `Agent: ${event.message}`,
      `Automated remediation skipped (rate limit). Triage: ${triage.reason}`,
      "agent-loop",
    );
    return {
      eventId: event.id,
      action: "rate_limited",
      model: "none",
      confidence: 0,
      outcome: "failure",
      details: "Remediation rate limit reached",
    };
  }

  return null; // All gates passed
}

// ── Tier 2a: API remediation (current path) ─────────────────────────────────

async function remediateViaApi(
  event: SystemEvent,
  triage: TriageResult,
  autoRemediate: boolean,
): Promise<RemediationResult> {
  const apiKey = getApiKey();
  if (!apiKey) {
    writeNotification("warning", `Agent: ${event.message}`, triage.reason, "agent-loop");
    return {
      eventId: event.id,
      action: "no_api_key",
      model: "none",
      confidence: 0,
      outcome: "failure",
      details: "No API key available",
    };
  }

  const model = getModel();
  const anthropic = createAnthropic({ apiKey });

  const result = await generateText({
    model: anthropic(model),
    system: buildSystemPrompt(autoRemediate, event.type),
    prompt: buildEventPrompt(event, triage, autoRemediate),
    tools: REMEDIATION_TOOLS,
    stopWhen: stepCountIs(8),
    maxRetries: 1,
  });

  logAiUsage({
    model,
    tokensIn: result.usage?.inputTokens ?? 0,
    tokensOut: result.usage?.outputTokens ?? 0,
    context: "agent_loop_remediation",
  });

  const toolsUsed = result.steps
    ?.flatMap((s) => s.toolCalls ?? [])
    .map((tc) => tc.toolName) ?? [];

  return finalizeRemediation(event, result.text.trim(), toolsUsed, model);
}

// ── Tier 2b: Claude Code local remediation (subscription-included) ──────────

async function remediateViaClaudeCode(
  event: SystemEvent,
  triage: TriageResult,
  autoRemediate: boolean,
): Promise<RemediationResult> {
  const prompt = `${buildSystemPrompt(autoRemediate, event.type)}

IMPORTANT: You have access to Talome's MCP tools. Use ONLY these tools for investigation:
- list_containers, get_container_logs, search_container_logs, check_service_health
- get_system_stats, get_disk_usage, get_system_health, diagnose_app
- arr_get_status, arr_get_queue_details, qbt_list_torrents, jellyfin_get_status
- check_dependencies (to understand service dependencies before restarting)
${autoRemediate ? `For remediation, you may ONLY use: restart_container, cleanup_docker, jellyfin_scan_library${event.type === "post_update_crash_loop" ? ", rollback_update" : ""}` : "Do NOT use any write tools — diagnosis only."}
Do NOT use Read, Edit, Write, Bash, or any file-modification tools. Do NOT modify code.

${buildEventPrompt(event, triage, autoRemediate)}`;

  const toolsUsed: string[] = [];

  const { code, stdout } = await spawnClaudeStreaming(
    prompt,
    PROJECT_ROOT,
    (chunk) => {
      // Capture MCP tool calls from stream output: [tool_name] ...
      const match = chunk.match(/^\[(\w+)\]/);
      if (match) toolsUsed.push(match[1]);
    },
  );

  if (code !== 0 || !stdout.trim()) {
    return {
      eventId: event.id,
      action: "claude_code_error",
      model: "claude-code",
      confidence: 0,
      outcome: "failure",
      details: `Claude Code exited with code ${code}`,
    };
  }

  // Log as zero-cost usage (included in subscription)
  logAiUsage({
    model: "claude-code-local",
    tokensIn: 0,
    tokensOut: 0,
    context: "agent_loop_remediation",
  });

  return finalizeRemediation(event, stdout.trim(), toolsUsed, "claude-code");
}

// ── Public entry point: auto-selects API or Claude Code ─────────────────────

/**
 * Run Tier 2 remediation for a single event that triage classified as "act".
 * Prefers Claude Code (subscription-included, $0 cost) when available,
 * falls back to API calls.
 */
export async function remediateEvent(
  event: SystemEvent,
  triage: TriageResult,
  maxPerHour: number,
  autoRemediate: boolean,
): Promise<RemediationResult> {
  // Smart abort: stop retrying after repeated failures for the same source
  if (hasExceededRetries(event.source)) {
    console.log(`[agent-loop] Skipping remediation for ${event.source} — ${MAX_REMEDIATION_ATTEMPTS} prior attempts failed`);
    writeNotification(
      "critical",
      `Agent gave up: ${event.source}`,
      `Automated remediation failed ${MAX_REMEDIATION_ATTEMPTS} times. Manual intervention required.`,
      "agent-loop",
    );
    return {
      eventId: event.id,
      action: "exhausted",
      model: "none",
      confidence: 0,
      outcome: "failure",
      details: `Remediation abandoned after ${MAX_REMEDIATION_ATTEMPTS} failed attempts`,
    };
  }

  const gateResult = checkGates(event, triage, maxPerHour);
  if (gateResult) return gateResult;

  try {
    // Prefer Claude Code — uses subscription auth, no per-token cost
    if (await isClaudeCodeAvailable()) {
      console.log("[agent-loop] Remediating via Claude Code (subscription)");
      try {
        return await remediateViaClaudeCode(event, triage, autoRemediate);
      } catch (err) {
        console.warn("[agent-loop] Claude Code remediation failed, falling back to API:", err);
        // Fall through to API
      }
    }

    // Fallback: API call (pay-per-token)
    console.log("[agent-loop] Remediating via API");
    return await remediateViaApi(event, triage, autoRemediate);
  } catch (err) {
    console.error("[agent-loop] Remediation failed:", err);
    writeNotification(
      "warning",
      `Agent: ${event.message}`,
      `Automated investigation failed: ${err instanceof Error ? err.message : String(err)}`,
      "agent-loop",
    );
    return {
      eventId: event.id,
      action: "error",
      model: "unknown",
      confidence: 0,
      outcome: "failure",
      details: err instanceof Error ? err.message : String(err),
    };
  }
}
