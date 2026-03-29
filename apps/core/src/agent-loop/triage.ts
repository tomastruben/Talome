// ── Tier 1: Haiku Triage (cheap AI classification) ─────────────────────────

import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { checkBudget, logAiUsage, shouldRunService, getEffectiveRate } from "./budget.js";
import type { SystemEvent, TriageResult, TriageVerdict } from "./types.js";

const TRIAGE_MODEL = "claude-haiku-4-5-20251001";

const triageResultSchema = z.object({
  assessments: z.array(
    z.object({
      eventId: z.string(),
      verdict: z.enum(["dismiss", "notify", "act"]),
      reason: z.string().max(200),
      suggestedAction: z.string().max(200).optional(),
    }),
  ),
});

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

/**
 * Tier 1 triage: batch-classify system events using Haiku.
 * Returns triage results for each event, or empty array if budget exceeded / no API key.
 */
export async function triageEvents(
  events: SystemEvent[],
  maxPerHour: number,
): Promise<TriageResult[]> {
  if (events.length === 0) return [];

  const zoneCheck = shouldRunService("triage");
  if (!zoneCheck.allowed) {
    console.log(`[agent-loop] ${zoneCheck.reason} — skipping triage`);
    return events.map((e) => ({
      eventId: e.id,
      verdict: e.severity === "critical" ? "notify" : "dismiss" as TriageVerdict,
      reason: zoneCheck.reason ?? "Budget zone restriction",
    }));
  }

  const effectiveRate = getEffectiveRate(maxPerHour, "triage");
  if (!checkBudget("triage", effectiveRate)) {
    console.log("[agent-loop] Triage rate limit reached — skipping AI classification");
    return events.map((e) => ({
      eventId: e.id,
      verdict: e.severity === "critical" ? "notify" : "dismiss" as TriageVerdict,
      reason: "Rate limit reached — defaulting based on severity",
    }));
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[agent-loop] No API key — falling back to severity-based triage");
    return events.map((e) => ({
      eventId: e.id,
      verdict: e.severity === "critical" ? "act" : e.severity === "warning" ? "notify" : "dismiss" as TriageVerdict,
      reason: "No API key — rule-based fallback",
    }));
  }

  try {
    const anthropic = createAnthropic({ apiKey });
    const eventSummaries = events.map((e) => ({
      id: e.id,
      type: e.type,
      severity: e.severity,
      source: e.source,
      message: e.message,
    }));

    const result = await generateObject({
      model: anthropic(TRIAGE_MODEL),
      schema: triageResultSchema,
      prompt: `You are Talome's background agent triage system. Classify each system event.

Rules:
- "dismiss" = false alarm, transient, or already handled (e.g. a container restarting once is normal)
- "notify" = user should know but no automated action needed (e.g. disk approaching 80%)
- "act" = requires automated investigation/remediation (e.g. container restart loop, critical resource exhaustion)

Be conservative: prefer "notify" over "act" unless the issue clearly needs automated intervention.
Only use "act" for patterns that indicate an ongoing problem, not one-off events.

Events:
${JSON.stringify(eventSummaries, null, 2)}`,
      maxRetries: 1,
    });

    // Log AI usage
    logAiUsage({
      model: TRIAGE_MODEL,
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
      context: "agent_loop_triage",
    });

    return result.object.assessments.map((a) => ({
      eventId: a.eventId,
      verdict: a.verdict,
      reason: a.reason,
      suggestedAction: a.suggestedAction,
    }));
  } catch (err: unknown) {
    // Reduce noise for known API errors
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("credit balance") || msg.includes("rate limit")) {
      console.warn(`[agent-loop] Triage skipped: ${msg.split("\n")[0]}`);
    } else {
      console.error("[agent-loop] Triage AI call failed:", err);
    }
    // Fallback to severity-based
    return events.map((e) => ({
      eventId: e.id,
      verdict: e.severity === "critical" ? "notify" : "dismiss" as TriageVerdict,
      reason: "AI triage failed — severity fallback",
    }));
  }
}
