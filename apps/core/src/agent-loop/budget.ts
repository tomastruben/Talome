// ── AI Budget Tracking & Rate Limiting ──────────────────────────────────────

import { db, schema } from "../db/index.js";
import { sql } from "drizzle-orm";
import type { EventSeverity } from "./types.js";

// ── Default daily cap (USD) ────────────────────────────────────────────────

const DEFAULT_DAILY_CAP_USD = 0.50;

// ── SQLite-persisted rate limiting (survives restarts) ─────────────────────

/**
 * Rate-limit AI calls per tier.
 * Supports fractional rates: 0.5/hr → 1 call per 2-hour window, 0.25/hr → 1 per 4 hours.
 * A value of 0 disables the tier entirely.
 */
export function checkBudget(tier: "triage" | "remediation", maxPerHour: number): boolean {
  if (maxPerHour <= 0) return false;

  // For sub-hourly rates, widen the window so we can check for at least 1 call
  const windowMs = maxPerHour >= 1
    ? 60 * 60 * 1000
    : (1 / maxPerHour) * 60 * 60 * 1000;
  const effectiveMax = maxPerHour >= 1 ? Math.floor(maxPerHour) : 1;

  const since = new Date(Date.now() - windowMs).toISOString();

  try {
    const rows = db
      .select()
      .from(schema.aiUsageLog)
      .where(sql`${schema.aiUsageLog.context} = ${"agent_loop_" + tier} AND ${schema.aiUsageLog.createdAt} >= ${since}`)
      .all();

    if (rows.length >= effectiveMax) return false;
  } catch {
    // If table doesn't exist yet, allow
  }
  return true;
}

export function getBudgetUsage(tier: "triage" | "remediation"): { used: number; windowMs: number } {
  const windowMs = 60 * 60 * 1000;
  const since = new Date(Date.now() - windowMs).toISOString();

  try {
    const rows = db
      .select()
      .from(schema.aiUsageLog)
      .where(sql`${schema.aiUsageLog.context} = ${"agent_loop_" + tier} AND ${schema.aiUsageLog.createdAt} >= ${since}`)
      .all();
    return { used: rows.length, windowMs };
  } catch {
    return { used: 0, windowMs };
  }
}

// ── Daily cost cap ─────────────────────────────────────────────────────────

/** Returns true if today's API spend is below the daily cap. */
export function checkDailyCap(): boolean {
  const cap = getDailyCapUsd();
  if (cap <= 0) return true; // 0 = unlimited
  return getTodayCostUsd() < cap;
}

export function getDailyCapUsd(): number {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(sql`${schema.settings.key} = 'ai_daily_cap_usd'`)
      .get();
    if (row?.value) return parseFloat(row.value);
  } catch { /* ignore */ }
  return DEFAULT_DAILY_CAP_USD;
}

export function getTodayCostUsd(): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const since = todayStart.toISOString();

  try {
    const row = db.get(sql`
      SELECT COALESCE(SUM(cost_usd), 0) as total
      FROM ai_usage_log
      WHERE created_at >= ${since}
    `) as { total: number } | undefined;
    return row?.total ?? 0;
  } catch {
    return 0;
  }
}

// ── Startup grace period ───────────────────────────────────────────────────

const startupTime = Date.now();
const STARTUP_GRACE_MS = 60_000; // 60s after boot

/** Returns true if within the startup grace period (background AI should wait). */
export function isInStartupGrace(): boolean {
  return Date.now() - startupTime < STARTUP_GRACE_MS;
}

// ── Budget Zone — graduated degradation ──────────────────────────────────────

export type BudgetZone = "green" | "yellow" | "orange" | "red" | "exhausted";

export type ServiceType = "triage" | "remediation" | "evolution_scan" | "activity_summary" | "self_healing";

/** Compute the current budget zone based on today's spend vs. daily cap. */
export function getBudgetZone(): BudgetZone {
  const cap = getDailyCapUsd();
  if (cap <= 0) return "green"; // unlimited
  const pct = getTodayCostUsd() / cap;
  if (pct >= 1.0) return "exhausted";
  if (pct >= 0.92) return "red";
  if (pct >= 0.80) return "orange";
  if (pct >= 0.60) return "yellow";
  return "green";
}

/**
 * Zone-aware service gate. Returns whether a service should run in the current
 * budget zone, plus a reason string when blocked.
 *
 * Priority order (highest value/cost → last to reduce):
 *   1. Triage (Haiku, ~$0.001)        — last to reduce
 *   2. Remediation for critical events — reduce late
 *   3. Activity summaries              — reduce early
 *   4. Remediation for non-critical    — reduce early
 *   5. Evolution scan                  — reduce first
 */
export function shouldRunService(
  service: ServiceType,
  eventSeverity?: EventSeverity,
): { allowed: boolean; reason?: string } {
  const zone = getBudgetZone();

  switch (zone) {
    case "green":
      return { allowed: true };

    case "yellow":
      if (service === "evolution_scan")
        return { allowed: false, reason: "Budget conserving — evolution scans deferred" };
      if (service === "activity_summary")
        return { allowed: false, reason: "Budget conserving — activity summaries paused" };
      return { allowed: true };

    case "orange":
      if (service === "evolution_scan" || service === "activity_summary")
        return { allowed: false, reason: "Budget reduced — non-essential services paused" };
      if (service === "remediation" && eventSeverity !== "critical")
        return { allowed: false, reason: "Budget reduced — non-critical remediation deferred" };
      return { allowed: true };

    case "red":
      if (service === "triage") {
        if (eventSeverity && eventSeverity !== "critical")
          return { allowed: false, reason: "Budget critical — non-critical triage skipped" };
        return { allowed: true };
      }
      if (service === "remediation") {
        if (eventSeverity === "critical") return { allowed: true };
        return { allowed: false, reason: "Budget critical — non-critical remediation skipped" };
      }
      return { allowed: false, reason: "Budget critical — only critical services active" };

    case "exhausted":
      return { allowed: false, reason: "Daily budget exhausted" };
  }
}

/** Returns a reduced rate for triage/remediation in higher budget zones. */
export function getEffectiveRate(
  baseRate: number,
  service: "triage" | "remediation",
): number {
  const zone = getBudgetZone();
  if (zone === "orange" && service === "triage") return Math.max(baseRate / 2, 0.125);
  if (zone === "red" && service === "triage") return Math.max(baseRate / 4, 0.125);
  return baseRate;
}

// ── Persistent AI usage logging ────────────────────────────────────────────

// Cost per 1K tokens (approximate, as of early 2026)
// Cost per 1K tokens — derived from litellm/model_prices_and_context_window.json
// cacheWrite = same as input (OpenAI doesn't charge extra for cache writes)
const MODEL_COSTS: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  // Anthropic
  "claude-haiku-4-5-20251001": { input: 0.0008, output: 0.004, cacheRead: 0.00008, cacheWrite: 0.001 },
  "claude-haiku-4-20250514":   { input: 0.0008, output: 0.004, cacheRead: 0.00008, cacheWrite: 0.001 },
  "claude-sonnet-4-20250514":  { input: 0.003,  output: 0.015, cacheRead: 0.0003,  cacheWrite: 0.00375 },
  // OpenAI — GPT
  "gpt-4o":                    { input: 0.0025,  output: 0.01,   cacheRead: 0.00125,  cacheWrite: 0.0025 },
  "gpt-4o-mini":               { input: 0.00015, output: 0.0006, cacheRead: 0.000075, cacheWrite: 0.00015 },
  "gpt-4.1":                   { input: 0.002,   output: 0.008,  cacheRead: 0.0005,   cacheWrite: 0.002 },
  "gpt-4.1-mini":              { input: 0.0004,  output: 0.0016, cacheRead: 0.0001,   cacheWrite: 0.0004 },
  "gpt-4.1-nano":              { input: 0.0001,  output: 0.0004, cacheRead: 0.000025, cacheWrite: 0.0001 },
  // OpenAI — reasoning
  "o1":                        { input: 0.015,  output: 0.06,  cacheRead: 0.0075, cacheWrite: 0.015 },
  "o3":                        { input: 0.002,  output: 0.008, cacheRead: 0.0005, cacheWrite: 0.002 },
  "o3-mini":                   { input: 0.0011, output: 0.0044, cacheRead: 0.00055, cacheWrite: 0.0011 },
  "o4-mini":                   { input: 0.0011, output: 0.0044, cacheRead: 0.000275, cacheWrite: 0.0011 },
};

export function logAiUsage(params: {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  context: string;
}): void {
  const costs = MODEL_COSTS[params.model] ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cacheRead = params.cacheReadTokens ?? 0;
  const cacheWrite = params.cacheWriteTokens ?? 0;
  const regularInput = Math.max(0, params.tokensIn - cacheRead - cacheWrite);
  const costUsd =
    (regularInput / 1000) * costs.input +
    (cacheRead / 1000) * costs.cacheRead +
    (cacheWrite / 1000) * costs.cacheWrite +
    (params.tokensOut / 1000) * costs.output;

  try {
    db.insert(schema.aiUsageLog)
      .values({
        id: crypto.randomUUID(),
        model: params.model,
        tokensIn: params.tokensIn,
        tokensOut: params.tokensOut,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        costUsd,
        context: params.context,
        createdAt: new Date().toISOString(),
      })
      .run();
  } catch {
    // Non-fatal — best-effort logging
  }
}

export function getUsageSummary(sinceDaysAgo = 30): {
  totalCostUsd: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  byContext: Record<string, { costUsd: number; count: number }>;
} {
  const since = new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Aggregate totals in SQL instead of fetching all rows
    const totals = db.get(sql`
      SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(tokens_in), 0) as total_in,
        COALESCE(SUM(tokens_out), 0) as total_out,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COALESCE(SUM(cache_write_tokens), 0) as total_cache_write
      FROM ai_usage_log
      WHERE created_at >= ${since}
    `) as { total_cost: number; total_in: number; total_out: number; total_cache_read: number; total_cache_write: number } | undefined;

    // Group by context in SQL
    const contextRows = db.all(sql`
      SELECT context, COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as cnt
      FROM ai_usage_log
      WHERE created_at >= ${since}
      GROUP BY context
    `) as Array<{ context: string; cost: number; cnt: number }>;

    const byContext: Record<string, { costUsd: number; count: number }> = {};
    for (const row of contextRows) {
      byContext[row.context ?? "unknown"] = { costUsd: row.cost, count: row.cnt };
    }

    return {
      totalCostUsd: totals?.total_cost ?? 0,
      totalTokensIn: totals?.total_in ?? 0,
      totalTokensOut: totals?.total_out ?? 0,
      totalCacheReadTokens: totals?.total_cache_read ?? 0,
      totalCacheWriteTokens: totals?.total_cache_write ?? 0,
      byContext,
    };
  } catch {
    return { totalCostUsd: 0, totalTokensIn: 0, totalTokensOut: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, byContext: {} };
  }
}
