import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, desc, inArray, sql } from "drizzle-orm";
import { fireTrigger } from "../automation/engine.js";
import type { AutomationTrigger, AutomationAction, AutomationStep } from "../automation/engine.js";
import { getAutomationSafeTools } from "../ai/automation-safe-tools.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("automations");

const automationTriggerSchema = z.object({
  type: z.string().min(1, "trigger.type is required"),
  webhookSecret: z.string().optional(),
  cron: z.string().optional(),
  event: z.string().optional(),
}).passthrough();

const automationCreateSchema = z.object({
  name: z.string().min(1, "name is required").max(200),
  trigger: automationTriggerSchema,
  conditions: z.array(z.object({
    field: z.string().regex(/^[a-zA-Z0-9_.]+$/, "field must be alphanumeric with dots/underscores only"),
    operator: z.enum(["eq", "gt", "lt", "contains"]),
    value: z.unknown(),
  })).max(20).default([]),
  actions: z.array(z.unknown()).max(50).optional(),
  steps: z.array(z.unknown()).max(50).optional(),
  enabled: z.boolean().default(true),
});

export const automations = new Hono();

// Available tools for automation steps — derived dynamically from tool registry
automations.get("/tools", (c) => {
  try {
    const tools = getAutomationSafeTools();
    return c.json({ tools });
  } catch (err) {
    log.error("GET /tools error", err);
    return c.json({ tools: [] });
  }
});

automations.get("/failures", (c) => {
  try {
    const rows = db
      .select({
        id: schema.automations.id,
        name: schema.automations.name,
        triggeredAt: schema.automationRuns.triggeredAt,
        error: schema.automationRuns.error,
      })
      .from(schema.automationRuns)
      .innerJoin(schema.automations, eq(schema.automationRuns.automationId, schema.automations.id))
      .where(eq(schema.automationRuns.success, false))
      .orderBy(desc(schema.automationRuns.triggeredAt))
      .limit(5)
      .all();
    return c.json({ failures: rows });
  } catch (err) {
    log.error("GET /failures error", err);
    return c.json({ failures: [] });
  }
});

automations.get("/", (c) => {
  try {
    const rows = db
      .select()
      .from(schema.automations)
      .orderBy(schema.automations.createdAt)
      .all();

    // Batch-fetch the most recent run per automation
    const ids = rows.map((r) => r.id);
    const latestRuns = ids.length > 0
      ? db.all<{
          automation_id: string;
          triggered_at: string;
          success: number;
          error: string | null;
        }>(sql`
          SELECT r.automation_id, r.triggered_at, r.success, r.error
          FROM automation_runs r
          INNER JOIN (
            SELECT automation_id, MAX(triggered_at) AS max_t
            FROM automation_runs
            WHERE automation_id IN ${ids}
            GROUP BY automation_id
          ) latest ON r.automation_id = latest.automation_id AND r.triggered_at = latest.max_t
        `)
      : [];
    const runByAutomation = new Map(
      latestRuns.map((r) => [r.automation_id, {
        lastRunSuccess: !!r.success,
        lastRunError: r.error,
        lastRunTriggeredAt: r.triggered_at,
      }]),
    );

    const enriched = rows.map((row) => ({
      ...row,
      ...runByAutomation.get(row.id),
    }));

    return c.json({ automations: enriched });
  } catch (err) {
    log.error("GET / error", err);
    return c.json({ error: "Failed to list automations" }, 500);
  }
});

automations.get("/:id", (c) => {
  const id = c.req.param("id");
  try {
    const row = db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json({ automation: row });
  } catch (err) {
    log.error("GET /:id error", err);
    return c.json({ error: "Failed to fetch automation" }, 500);
  }
});

automations.post("/", async (c) => {
  try {
    const raw = await c.req.json();
    const parsed = automationCreateSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    }
    const body = parsed.data as {
      name: string;
      trigger: AutomationTrigger;
      conditions: unknown[];
      actions?: AutomationAction[];
      steps?: AutomationStep[];
      enabled: boolean;
    };

    const isV2 = Array.isArray(body.steps) && body.steps.length > 0;
    const isV1 = Array.isArray(body.actions) && body.actions.length > 0;
    if (!isV2 && !isV1) {
      return c.json({ error: "Either steps (v2) or actions (v1) must be a non-empty array" }, 400);
    }

    const id = randomUUID();
    db.insert(schema.automations)
      .values({
        id,
        name: body.name.trim(),
        enabled: body.enabled !== false,
        trigger: JSON.stringify(body.trigger),
        conditions: JSON.stringify(body.conditions ?? []),
        actions: isV2 ? "[]" : JSON.stringify(body.actions),
        workflowVersion: isV2 ? 2 : 1,
        steps: isV2 ? JSON.stringify(body.steps) : null,
      })
      .run();

    return c.json({ id }, 201);
  } catch (err) {
    log.error("POST / error", err);
    return c.json({ error: "Failed to create automation" }, 500);
  }
});

automations.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    if (!existing) return c.json({ error: "Not found" }, 404);

    const body = await c.req.json() as Partial<{
      name: string;
      enabled: boolean;
      trigger: AutomationTrigger;
      conditions: unknown[];
      // v1
      actions: AutomationAction[];
      // v2
      steps: AutomationStep[];
    }>;

    const isV2 = Array.isArray(body.steps) && body.steps.length > 0;

    db.update(schema.automations)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.trigger !== undefined ? { trigger: JSON.stringify(body.trigger) } : {}),
        ...(body.conditions !== undefined ? { conditions: JSON.stringify(body.conditions) } : {}),
        ...(isV2
          ? { steps: JSON.stringify(body.steps), actions: "[]", workflowVersion: 2 }
          : body.actions !== undefined
            ? { actions: JSON.stringify(body.actions), workflowVersion: 1 }
            : {}),
      })
      .where(eq(schema.automations.id, id))
      .run();

    return c.json({ ok: true });
  } catch (err) {
    log.error("PUT /:id error", err);
    return c.json({ error: "Failed to update automation" }, 500);
  }
});

automations.delete("/:id", (c) => {
  const id = c.req.param("id");
  try {
    const existing = db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    if (!existing) return c.json({ error: "Not found" }, 404);

    db.delete(schema.automations).where(eq(schema.automations.id, id)).run();
    return c.json({ ok: true });
  } catch (err) {
    log.error("DELETE /:id error", err);
    return c.json({ error: "Failed to delete automation" }, 500);
  }
});

automations.post("/:id/run", async (c) => {
  const id = c.req.param("id");
  try {
    const row = db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);

    const trigger = JSON.parse(row.trigger) as AutomationTrigger;
    const results = await fireTrigger(trigger.type, { automationId: id, manual: true });

    if (results.length === 0) {
      return c.json({ ok: false, error: "Automation did not run — it may be disabled or misconfigured" }, 200);
    }

    const run = results[0];
    if (!run.success) {
      return c.json({ ok: false, error: run.error ?? "Automation failed" }, 200);
    }

    return c.json({ ok: true });
  } catch (err) {
    log.error("POST /:id/run error", err);
    return c.json({ error: "Failed to run automation" }, 500);
  }
});

automations.get("/:id/runs", (c) => {
  const id = c.req.param("id");
  try {
    const runs = db
      .select()
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, id))
      .orderBy(desc(schema.automationRuns.triggeredAt))
      .limit(50)
      .all();

    // Batch-fetch all step runs for the retrieved runs (avoids N+1)
    const runIds = runs.map(r => r.id);
    const allStepRuns = runIds.length > 0
      ? db.select().from(schema.automationStepRuns)
          .where(inArray(schema.automationStepRuns.runId, runIds))
          .orderBy(schema.automationStepRuns.startedAt)
          .all()
      : [];
    const stepsByRun = new Map<string, typeof allStepRuns>();
    for (const step of allStepRuns) {
      const arr = stepsByRun.get(step.runId) ?? [];
      arr.push(step);
      stepsByRun.set(step.runId, arr);
    }
    const runsWithSteps = runs.map(run => ({ ...run, stepRuns: stepsByRun.get(run.id) ?? [] }));

    return c.json({ runs: runsWithSteps });
  } catch (err) {
    log.error("GET /:id/runs error", err);
    return c.json({ error: "Failed to fetch runs" }, 500);
  }
});

// Simulate: dry-run steps to preview tool calls and approval gates
automations.post("/:id/simulate", async (c) => {
  const id = c.req.param("id");
  try {
    const row = db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    if (!row) return c.json({ error: "Not found" }, 404);

    if (row.workflowVersion !== 2 || !row.steps) {
      return c.json({ error: "Simulation is only available for v2 automations" }, 400);
    }

    const steps = JSON.parse(row.steps) as AutomationStep[];

    const preview = steps.map((step) => {
      const requiresApproval =
        (step.type === "tool_action" && (step.approvalPolicy ?? "require_approval") === "require_approval") ||
        (step.type === "ai_prompt" && step.approvalPolicy === "require_approval");

      return {
        id: step.id,
        type: step.type,
        label: stepLabel(step),
        requiresApproval,
        allowedTools: step.type === "ai_prompt" ? step.allowedTools : undefined,
      };
    });

    return c.json({ preview });
  } catch (err) {
    log.error("POST /:id/simulate error", err);
    return c.json({ error: "Failed to simulate automation" }, 500);
  }
});

function stepLabel(step: AutomationStep): string {
  switch (step.type) {
    case "notify": return `Notify: ${step.title}`;
    case "tool_action": return `Tool: ${step.toolName}`;
    case "ai_prompt": return `AI Prompt: ${step.promptTemplate.slice(0, 60)}`;
    case "condition": return `Condition: ${step.field} ${step.operator} ${String(step.value)}`;
  }
}
