/**
 * Evolution Suggestion Engine
 *
 * Gathers signals from across the system (health events, memories, automation
 * failures, past rollbacks) and synthesizes improvement suggestions via Haiku.
 */

import { generateObject } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logAiUsage, shouldRunService } from "../agent-loop/budget.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface Signal {
  source: string;
  summary: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSetting(key: string): string | undefined {
  try {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row?.value || undefined;
  } catch {
    return undefined;
  }
}

function getApiKey(): string | undefined {
  return getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
}

// Bigram similarity for deduplication
function bigrams(s: string): Map<string, number> {
  const map = new Map<string, number>();
  const lower = s.toLowerCase();
  for (let i = 0; i < lower.length - 1; i++) {
    const bg = lower.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

function similarity(a: string, b: string): number {
  const aMap = bigrams(a);
  const bMap = bigrams(b);
  let intersection = 0;
  for (const [bg, count] of aMap) {
    intersection += Math.min(count, bMap.get(bg) ?? 0);
  }
  const total = (a.length - 1) + (b.length - 1);
  return total === 0 ? 1 : (2 * intersection) / total;
}

// ── Signal Deduplication ─────────────────────────────────────────────────────

/** Collapse repeated signals into counted summaries so Haiku sees themes, not noise */
function deduplicateSignals(signals: Signal[]): Signal[] {
  const groups = new Map<string, { signal: Signal; count: number }>();

  for (const s of signals) {
    // Group by source + first 60 chars of summary (catches repeated events)
    const key = `${s.source}:${s.summary.slice(0, 60).toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
    } else {
      groups.set(key, { signal: s, count: 1 });
    }
  }

  return Array.from(groups.values()).map(({ signal, count }) => ({
    source: signal.source,
    summary: count > 1 ? `(${count}x) ${signal.summary}` : signal.summary,
  }));
}

// ── Signal Gathering ─────────────────────────────────────────────────────────

export async function gatherSignals(): Promise<Signal[]> {
  const signals: Signal[] = [];
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // 1. System events (warnings + critical, last 7 days)
  try {
    const events = db
      .select({ type: schema.systemEvents.type, severity: schema.systemEvents.severity, message: schema.systemEvents.message })
      .from(schema.systemEvents)
      .where(sql`${schema.systemEvents.createdAt} > ${sevenDaysAgo} AND ${schema.systemEvents.severity} IN ('warning', 'critical')`)
      .orderBy(desc(schema.systemEvents.createdAt))
      .limit(20)
      .all();

    for (const e of events) {
      signals.push({ source: "system_event", summary: `[${e.severity}] ${e.type}: ${e.message}` });
    }
  } catch {
    // Table may not exist yet
  }

  // 2. Memories (all types — corrections, preferences, facts, context)
  try {
    const mems = db
      .select({ type: schema.memories.type, content: schema.memories.content })
      .from(schema.memories)
      .where(sql`${schema.memories.enabled} = 1`)
      .orderBy(desc(schema.memories.createdAt))
      .limit(20)
      .all();

    for (const m of mems) {
      signals.push({ source: "memory", summary: `[${m.type}] ${m.content}` });
    }
  } catch {
    // Ignore
  }

  // 3. Failed automation runs (last 7 days)
  try {
    const failedRuns = db
      .select({
        automationId: schema.automationRuns.automationId,
        error: schema.automationRuns.error,
      })
      .from(schema.automationRuns)
      .where(sql`${schema.automationRuns.success} = 0 AND ${schema.automationRuns.triggeredAt} > ${sevenDaysAgo}`)
      .orderBy(desc(schema.automationRuns.triggeredAt))
      .limit(10)
      .all();

    for (const r of failedRuns) {
      signals.push({ source: "automation_failure", summary: `Automation ${r.automationId} failed: ${r.error ?? "unknown error"}` });
    }
  } catch {
    // Ignore
  }

  // 4. Past rollbacks (evolution failures — what didn't work)
  try {
    const rollbacks = db
      .select({ task: schema.evolutionLog.task, typeErrors: schema.evolutionLog.typeErrors })
      .from(schema.evolutionLog)
      .where(sql`${schema.evolutionLog.rolledBack} = 1`)
      .orderBy(desc(schema.evolutionLog.timestamp))
      .limit(5)
      .all();

    for (const r of rollbacks) {
      signals.push({
        source: "evolution_rollback",
        summary: `Previous improvement failed: "${r.task}" — ${r.typeErrors.slice(0, 200)}`,
      });
    }
  } catch {
    // Ignore
  }

  // 5. Remediation log (repeated issues)
  try {
    const remediations = db
      .select({ action: schema.remediationLog.action, outcome: schema.remediationLog.outcome })
      .from(schema.remediationLog)
      .where(sql`${schema.remediationLog.createdAt} > ${sevenDaysAgo}`)
      .orderBy(desc(schema.remediationLog.createdAt))
      .limit(10)
      .all();

    for (const r of remediations) {
      signals.push({ source: "remediation", summary: `Remediation: ${r.action} → ${r.outcome}` });
    }
  } catch {
    // Ignore
  }

  // 6. Tool errors from audit log (rejected or failed operations)
  try {
    const toolErrors = db
      .select({ action: schema.auditLog.action, details: schema.auditLog.details, tier: schema.auditLog.tier })
      .from(schema.auditLog)
      .where(sql`${schema.auditLog.timestamp} > ${sevenDaysAgo} AND (${schema.auditLog.approved} = 0 OR ${schema.auditLog.details} LIKE '%error%' OR ${schema.auditLog.details} LIKE '%failed%')`)
      .orderBy(desc(schema.auditLog.timestamp))
      .limit(10)
      .all();

    for (const e of toolErrors) {
      signals.push({
        source: "tool_error",
        summary: `[${e.tier}] ${e.action}: ${e.details.slice(0, 200)}`,
      });
    }
  } catch {
    // Ignore
  }

  // 7. Failed agent remediations with event context (the agent tried but couldn't fix it)
  try {
    const failedRemediations = db
      .select({
        action: schema.remediationLog.action,
        outcome: schema.remediationLog.outcome,
        eventId: schema.remediationLog.eventId,
      })
      .from(schema.remediationLog)
      .where(sql`${schema.remediationLog.createdAt} > ${sevenDaysAgo} AND ${schema.remediationLog.outcome} IN ('failure', 'partial')`)
      .orderBy(desc(schema.remediationLog.createdAt))
      .limit(10)
      .all();

    for (const r of failedRemediations) {
      // Get the original event for context
      let eventMessage = "unknown event";
      try {
        const event = db
          .select({ type: schema.systemEvents.type, message: schema.systemEvents.message })
          .from(schema.systemEvents)
          .where(eq(schema.systemEvents.id, r.eventId))
          .get();
        if (event) eventMessage = `${event.type}: ${event.message}`;
      } catch { /* ignore */ }

      signals.push({
        source: "agent_failure",
        summary: `Agent remediation ${r.outcome}: "${r.action}" for ${eventMessage}`,
      });
    }
  } catch {
    // Ignore
  }

  // 8. Unresolved "act" events (agent was told to act but no successful remediation exists)
  try {
    const unresolvedActs = db
      .select({
        type: schema.systemEvents.type,
        message: schema.systemEvents.message,
        source: schema.systemEvents.source,
        remediationId: schema.systemEvents.remediationId,
      })
      .from(schema.systemEvents)
      .where(sql`${schema.systemEvents.createdAt} > ${sevenDaysAgo} AND ${schema.systemEvents.triageVerdict} = 'act' AND (${schema.systemEvents.remediationId} IS NULL)`)
      .orderBy(desc(schema.systemEvents.createdAt))
      .limit(10)
      .all();

    for (const e of unresolvedActs) {
      signals.push({
        source: "unresolved_event",
        summary: `Unresolved: ${e.type} from ${e.source} — ${e.message}`,
      });
    }
  } catch {
    // Ignore
  }

  return deduplicateSignals(signals);
}

// ── Suggestion Synthesis ─────────────────────────────────────────────────────

const suggestionSchema = z.object({
  suggestions: z.array(z.object({
    title: z.string().describe("Short title for the improvement (under 80 chars)"),
    description: z.string().describe("2-3 sentence explanation of what to improve and why"),
    category: z.enum(["performance", "reliability", "ux", "feature", "maintenance"]),
    priority: z.enum(["low", "medium", "high"]),
    scope: z.enum(["backend", "frontend", "full"]),
    risk: z.enum(["low", "medium", "high"]).describe("Risk level: low = cosmetic/logging/comment changes, medium = logic changes in existing files, high = new files, schema changes, or cross-cutting modifications"),
    taskPrompt: z.string().describe("Detailed prompt to give to Claude Code to implement this improvement. Be specific about files, patterns, and expected behavior."),
    relevantSignals: z.array(z.string()).describe("Which signals informed this suggestion"),
  })),
});

export async function synthesizeSuggestions(signals: Signal[]): Promise<number> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[evolution/suggest] No API key — skipping suggestion generation");
    return 0;
  }

  if (signals.length === 0) {
    return 0;
  }

  const zoneCheck = shouldRunService("evolution_scan");
  if (!zoneCheck.allowed) {
    console.log(`[evolution/suggest] ${zoneCheck.reason} — skipping`);
    return 0;
  }

  const signalText = signals
    .map((s, i) => `${i + 1}. [${s.source}] ${s.summary}`)
    .join("\n");

  // Gather existing pending suggestions for context
  const existing = db
    .select({
      title: schema.evolutionSuggestions.title,
      description: schema.evolutionSuggestions.description,
      taskPrompt: schema.evolutionSuggestions.taskPrompt,
    })
    .from(schema.evolutionSuggestions)
    .where(eq(schema.evolutionSuggestions.status, "pending"))
    .all();

  // Also gather dismissed and recently completed items for dedup
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rejected = db
    .select({
      title: schema.evolutionSuggestions.title,
      description: schema.evolutionSuggestions.description,
      taskPrompt: schema.evolutionSuggestions.taskPrompt,
      dismissReason: schema.evolutionSuggestions.dismissReason,
      status: schema.evolutionSuggestions.status,
    })
    .from(schema.evolutionSuggestions)
    .where(
      sql`${schema.evolutionSuggestions.status} IN ('dismissed', 'completed') AND ${schema.evolutionSuggestions.updatedAt} > ${thirtyDaysAgo}`,
    )
    .all();

  // Cap new suggestions based on how many are already pending
  const pendingCount = existing.length;
  if (pendingCount >= 15) {
    console.log(`[evolution/suggest] ${pendingCount} suggestions already pending — skipping generation`);
    return 0;
  }
  const maxNew = pendingCount >= 10 ? 1 : pendingCount >= 5 ? 2 : 5;

  const existingContext = existing.length > 0
    ? `\n\nAlready pending suggestions (${pendingCount} items — do NOT duplicate or overlap with these. Each new suggestion must address a genuinely different problem, not a variation of an existing one):\n${existing.map((e, i) => `${i + 1}. ${e.title}: ${e.description}`).join("\n")}`
    : "";

  const rejectedContext = rejected.length > 0
    ? `\n\nRecently dismissed or completed items (do NOT re-suggest these or similar variants):\n${rejected.map((r, i) => `${i + 1}. [${r.status}] ${r.title}: ${r.description}${r.dismissReason ? ` (dismissed because: ${r.dismissReason})` : ""}`).join("\n")}`
    : "";

  // C5: Outcome-informed learning — inject recent evolution outcomes
  let outcomeContext = "";
  try {
    const recentRuns = db
      .select({
        task: schema.evolutionRuns.task,
        status: schema.evolutionRuns.status,
        rolledBack: schema.evolutionRuns.rolledBack,
        typeErrors: schema.evolutionRuns.typeErrors,
      })
      .from(schema.evolutionRuns)
      .orderBy(desc(schema.evolutionRuns.startedAt))
      .limit(10)
      .all();

    const successes = recentRuns.filter((r) => r.status === "applied" && !r.rolledBack);
    const failures = recentRuns.filter((r) => r.status === "failed" || r.rolledBack);

    if (successes.length > 0 || failures.length > 0) {
      outcomeContext = "\n\nRecent evolution outcomes (learn from these):";
      if (successes.length > 0) {
        outcomeContext += `\nSuccessful changes (repeat these patterns):\n${successes.map((r) => `- ✓ ${r.task}`).join("\n")}`;
      }
      if (failures.length > 0) {
        outcomeContext += `\nFailed/rolled-back changes (avoid these patterns):\n${failures.map((r) => `- ✗ ${r.task}${r.typeErrors ? ` (errors: ${r.typeErrors.slice(0, 100)})` : ""}`).join("\n")}`;
      }
    }
  } catch {
    // Ignore — table may not exist
  }

  const SUGGEST_MODEL = "claude-haiku-4-5-20251001";
  const { object, usage } = await generateObject({
    model: createAnthropic({ apiKey })(SUGGEST_MODEL),
    schema: suggestionSchema,
    system: `You are an expert software engineer analyzing signals from a self-hosted home server platform called Talome.

Talome is a TypeScript monorepo (Hono backend + Next.js frontend) that manages Docker containers, media services, automations, and more.

Based on the system signals provided, suggest 0-${maxNew} concrete improvements to the Talome codebase itself. Each suggestion should be:
- Actionable (specific enough for Claude Code to implement)
- Relevant (directly addresses a signal)
- Safe (no destructive changes, no breaking changes)
- Valuable (improves reliability, performance, UX, or adds useful features)
- Distinct (must NOT overlap with pending, dismissed, or completed suggestions listed below)

CRITICAL DEDUPLICATION RULES:
- Multiple signals about the same root cause (e.g. repeated memory pressure events, multiple Caddy errors) should produce ONE suggestion, not several
- If a pending suggestion already addresses a problem area, do NOT suggest variations of it
- Merge related signals into a single comprehensive suggestion rather than creating separate narrow ones
- Fewer high-quality suggestions are always better than many overlapping ones

If the signals don't warrant any NEW improvements beyond what's already pending, return an empty array. Quality over quantity.

The taskPrompt should be detailed enough for Claude Code to implement the change without further context. Include specific file paths if you can infer them, expected behavior, and any constraints.`,
    prompt: `Here are recent signals from the Talome system:\n\n${signalText}${existingContext}${rejectedContext}${outcomeContext}\n\nAnalyze these signals and suggest up to ${maxNew} improvements. If there are already many pending suggestions, be very selective — only suggest something if it addresses a genuinely new problem not covered by existing items. Classify risk carefully: low = safe changes like better logging, error messages, comments; medium = logic changes within existing files; high = new files, schema changes, or changes that span multiple modules.`,
  });

  logAiUsage({
    model: SUGGEST_MODEL,
    tokensIn: usage?.inputTokens ?? 0,
    tokensOut: usage?.outputTokens ?? 0,
    context: "evolution_scan",
  });

  let inserted = 0;
  const now = new Date().toISOString();
  const acceptedInBatch: Array<{ title: string; taskPrompt: string }> = [];

  for (const s of object.suggestions.slice(0, maxNew)) {
    // Check similarity against existing pending + dismissed/completed (taskPrompt AND title)
    const allKnown = [...existing, ...rejected];
    const isDupeByPrompt = allKnown.some((e) => similarity(e.taskPrompt, s.taskPrompt) > 0.8);
    const isDupeByTitle = allKnown.some((e) => similarity(e.title, s.title) > 0.7);
    if (isDupeByPrompt || isDupeByTitle) continue;

    // Intra-batch dedup: check against suggestions already accepted in this batch
    const isDupeInBatch = acceptedInBatch.some(
      (b) => similarity(b.taskPrompt, s.taskPrompt) > 0.8 || similarity(b.title, s.title) > 0.7,
    );
    if (isDupeInBatch) continue;

    db.insert(schema.evolutionSuggestions).values({
      id: `sug_${Date.now()}_${inserted}`,
      title: s.title,
      description: s.description,
      category: s.category,
      priority: s.priority,
      risk: s.risk,
      sourceSignals: JSON.stringify(s.relevantSignals),
      taskPrompt: s.taskPrompt,
      scope: s.scope,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }).run();

    acceptedInBatch.push({ title: s.title, taskPrompt: s.taskPrompt });
    inserted++;
  }

  return inserted;
}

// ── Public: Generate suggestions ─────────────────────────────────────────────

export async function generateSuggestions(): Promise<{ signalsFound: number; suggestionsCreated: number }> {
  const signals = await gatherSignals();
  const created = await synthesizeSuggestions(signals);
  return { signalsFound: signals.length, suggestionsCreated: created };
}
