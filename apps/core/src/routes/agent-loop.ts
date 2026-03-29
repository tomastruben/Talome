import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, desc, sql } from "drizzle-orm";
import { DEFAULT_AGENT_LOOP_CONFIG } from "../agent-loop/types.js";
import { getUsageSummary } from "../agent-loop/budget.js";
import { runAgentCycleOnce } from "../agent-loop/index.js";
import { getDedupSnapshot } from "../agent-loop/event-dedup.js";

export const agentLoop = new Hono();

// ── Get agent loop status ─────────────────────────────────────────────────

agentLoop.get("/status", (c) => {
  try {
    let config = { ...DEFAULT_AGENT_LOOP_CONFIG };
    try {
      const raw = db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, "agent_loop_config"))
        .get();
      if (raw?.value) {
        config = { ...config, ...JSON.parse(raw.value) };
      }
    } catch {
      // Use defaults
    }

    const usage = getUsageSummary(30);

    // Recent events (with dedup display messages)
    const recentEvents = db
      .select()
      .from(schema.systemEvents)
      .orderBy(desc(schema.systemEvents.createdAt))
      .limit(20)
      .all()
      .map((e) => {
        const count = e.occurrenceCount ?? 1;
        const lastSeen = e.lastSeen ?? e.createdAt;
        return {
          ...e,
          occurrenceCount: count,
          lastSeen,
          displayMessage: formatDisplayMessage(e.message, count, e.createdAt, lastSeen),
        };
      });

    // Recent remediations
    const recentRemediations = db
      .select()
      .from(schema.remediationLog)
      .orderBy(desc(schema.remediationLog.createdAt))
      .limit(20)
      .all();

    // Evolution settings — batch-load in a single query
    const evoKeys = ["evolution_auto_scan", "evolution_auto_execute", "evolution_execution_mode"] as const;
    const evoRows = db
      .select()
      .from(schema.settings)
      .where(sql`${schema.settings.key} IN (${sql.join(evoKeys.map(k => sql`${k}`), sql`, `)})`)
      .all();
    const evoMap = new Map(evoRows.map(r => [r.key, r.value]));
    const autoScan = evoMap.get("evolution_auto_scan") !== "false";
    const autoExecutePolicy = evoMap.get("evolution_auto_execute") ?? "low";
    const executionMode = evoMap.get("evolution_execution_mode") ?? "headless";

    return c.json({
      config,
      evolutionConfig: { autoScan, autoExecutePolicy, executionMode },
      usage,
      recentEvents,
      recentRemediations,
    });
  } catch (err) {
    console.error("[agent-loop] GET /status error:", err);
    return c.json({
      config: DEFAULT_AGENT_LOOP_CONFIG,
      evolutionConfig: { autoScan: true, autoExecutePolicy: "low", executionMode: "headless" },
      usage: { totalCostUsd: 0, totalRequests: 0 },
      recentEvents: [],
      recentRemediations: [],
    });
  }
});

// ── Update agent loop config ──────────────────────────────────────────────

const configSchema = z.object({
  enabled: z.boolean().optional(),
  checkIntervalMs: z.number().min(10_000).max(3_600_000).optional(),
  maxTriagePerHour: z.number().min(0).max(100).optional(),
  maxRemediationPerHour: z.number().min(0).max(20).optional(),
  autoRemediate: z.boolean().optional(),
  restartLoopThreshold: z.number().min(2).max(10).optional(),
  highCpuThreshold: z.number().min(50).max(100).optional(),
  highMemoryThreshold: z.number().min(50).max(100).optional(),
  imageStalenessDays: z.number().min(1).max(365).optional(),
});

agentLoop.put("/config", async (c) => {
  const body = await c.req.json();
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid config", details: parsed.error.issues }, 400);
  }

  // Merge with existing config
  let existing = { ...DEFAULT_AGENT_LOOP_CONFIG };
  try {
    const raw = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "agent_loop_config"))
      .get();
    if (raw?.value) {
      existing = { ...existing, ...JSON.parse(raw.value) };
    }
  } catch {
    // Use defaults
  }

  const merged = { ...existing, ...parsed.data };

  db.insert(schema.settings)
    .values({ key: "agent_loop_config", value: JSON.stringify(merged) })
    .onConflictDoUpdate({
      target: schema.settings.key,
      set: { value: JSON.stringify(merged) },
    })
    .run();

  return c.json({ config: merged });
});

// ── Update evolution config ──────────────────────────────────────────────

const evoConfigSchema = z.object({
  autoScan: z.boolean().optional(),
  autoExecutePolicy: z.enum(["none", "low", "medium"]).optional(),
  executionMode: z.enum(["headless", "terminal"]).optional(),
});

agentLoop.put("/evolution-config", async (c) => {
  const body = await c.req.json();
  const parsed = evoConfigSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid config", details: parsed.error.issues }, 400);
  }

  if (parsed.data.autoScan !== undefined) {
    db.insert(schema.settings)
      .values({ key: "evolution_auto_scan", value: String(parsed.data.autoScan) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: String(parsed.data.autoScan) } })
      .run();
  }
  if (parsed.data.autoExecutePolicy !== undefined) {
    db.insert(schema.settings)
      .values({ key: "evolution_auto_execute", value: parsed.data.autoExecutePolicy })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: parsed.data.autoExecutePolicy } })
      .run();
  }
  if (parsed.data.executionMode !== undefined) {
    db.insert(schema.settings)
      .values({ key: "evolution_execution_mode", value: parsed.data.executionMode })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: parsed.data.executionMode } })
      .run();
  }

  return c.json({ ok: true });
});

// ── Get AI usage summary ──────────────────────────────────────────────────

agentLoop.get("/usage", (c) => {
  const days = Number(c.req.query("days") ?? 30);
  const usage = getUsageSummary(days);
  return c.json(usage);
});

// ── List system events ────────────────────────────────────────────────────

function formatDisplayMessage(
  message: string,
  count: number,
  createdAt: string | null,
  lastSeen: string | null,
): string {
  if (count <= 1) return message;
  if (!createdAt || !lastSeen) return `${message} (${count} occurrences)`;
  const windowMs = new Date(lastSeen).getTime() - new Date(createdAt).getTime();
  const windowMin = Math.max(1, Math.round(windowMs / 60_000));
  return `${message} (${count} occurrences in last ${windowMin} min)`;
}

agentLoop.get("/events", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const severity = c.req.query("severity");

  const rows = db
    .select()
    .from(schema.systemEvents)
    .orderBy(desc(schema.systemEvents.createdAt))
    .limit(limit)
    .all()
    .filter((e) => {
      if (severity && e.severity !== severity) return false;
      return true;
    });

  const events = rows.map((e) => {
    const count = e.occurrenceCount ?? 1;
    const lastSeen = e.lastSeen ?? e.createdAt;
    return {
      ...e,
      occurrenceCount: count,
      lastSeen,
      displayMessage: formatDisplayMessage(e.message, count, e.createdAt, lastSeen),
    };
  });

  return c.json({ events });
});

// ── Live dedup snapshot ──────────────────────────────────────────────────
// Returns the in-memory dedup cache state so the frontend can show real-time
// aggregation counts for ongoing alerts (e.g. "high_memory: 5 occurrences").

agentLoop.get("/events/dedup", (c) => {
  return c.json({ entries: getDedupSnapshot() });
});

// ── Trigger a manual cycle ────────────────────────────────────────────────

agentLoop.post("/run", async (c) => {
  await runAgentCycleOnce();
  return c.json({ ok: true, message: "Agent cycle completed" });
});
