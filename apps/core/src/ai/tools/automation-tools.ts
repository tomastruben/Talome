import { tool } from "ai";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db, schema } from "../../db/index.js";
import { eq, desc } from "drizzle-orm";
import { writeAuditEntry } from "../../db/audit.js";
import { getAutomationSafeTools } from "../automation-safe-tools.js";

// ── Schema helpers ────────────────────────────────────────────────────────────

const triggerSchema = z.object({
  type: z.enum(["container_stopped", "disk_usage_exceeds", "app_installed", "schedule"]),
  containerId: z.string().optional().describe("Container name or ID for container_stopped trigger"),
  mountPath: z.string().optional().describe("Mount path for disk_usage_exceeds trigger, e.g. /mnt/data"),
  threshold: z.number().min(1).max(100).optional().describe("Disk usage % threshold"),
  appId: z.string().optional().describe("App ID for app_installed trigger"),
  cron: z.string().optional().describe("Cron expression for schedule trigger, e.g. '0 * * * *'"),
});

const stepSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().default(() => randomUUID()),
    type: z.literal("notify"),
    level: z.enum(["info", "warning", "critical"]).default("info"),
    title: z.string(),
    body: z.string().optional(),
  }),
  z.object({
    id: z.string().default(() => randomUUID()),
    type: z.literal("tool_action"),
    toolName: z.string().describe("One of the automation-allowed tool names"),
    args: z.record(z.string(), z.any()).optional(),
    approvalPolicy: z.enum(["auto", "require_approval"]).default("require_approval"),
  }),
  z.object({
    id: z.string().default(() => randomUUID()),
    type: z.literal("ai_prompt"),
    promptTemplate: z.string().describe("Prompt text; use {{fieldName}} for trigger data interpolation"),
    allowedTools: z.array(z.string()).default([]).describe("Subset of automation-safe tools the AI may use"),
    approvalPolicy: z.enum(["auto", "require_approval"]).default("auto"),
    timeoutMs: z.number().optional(),
    outputKey: z.string().optional().describe("Key to store AI output for use in subsequent steps"),
  }),
  z.object({
    id: z.string().default(() => randomUUID()),
    type: z.literal("condition"),
    field: z.string().describe("Field from trigger data to evaluate"),
    operator: z.enum(["eq", "gt", "lt", "contains"]),
    value: z.union([z.string(), z.number(), z.boolean()]),
    onFail: z.enum(["stop", "continue"]).default("stop"),
  }),
]);

// ── Tools ─────────────────────────────────────────────────────────────────────

export const listAutomationsTool = tool({
  description:
    "List all automations with their name, trigger, steps summary, enabled status, and run stats. Use this to see what automations exist before creating or updating.",
  inputSchema: z.object({}),
  execute: async () => {
    const rows = db.select().from(schema.automations).orderBy(schema.automations.createdAt).all();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      triggerType: (() => {
        try { return (JSON.parse(row.trigger) as { type: string }).type; } catch { return "unknown"; }
      })(),
      workflowVersion: row.workflowVersion,
      stepCount: row.workflowVersion === 2 && row.steps
        ? (() => { try { return (JSON.parse(row.steps) as unknown[]).length; } catch { return 0; } })()
        : (() => { try { return (JSON.parse(row.actions) as unknown[]).length; } catch { return 0; } })(),
      runCount: row.runCount,
      lastRunAt: row.lastRunAt,
      createdAt: row.createdAt,
    }));
  },
});

export const createAutomationTool = tool({
  description:
    "Create a new automation with a trigger and step-based workflow (v2). " +
    "Automation-safe tools for ai_prompt steps: list_containers, get_container_logs, check_service_health, get_system_stats, get_disk_usage, get_system_health, get_downloads, get_calendar, diagnose_app, arr_get_status, jellyfin_get_status, qbt_list_torrents, restart_container, jellyfin_scan_library. " +
    "For simple notifications or container restarts use notify/tool_action steps. " +
    "Use ai_prompt when you want the automation to reason about system state before acting.",
  inputSchema: z.object({
    name: z.string().min(2).describe("Short descriptive name for the automation"),
    enabled: z.boolean().default(true),
    trigger: triggerSchema,
    steps: z.array(stepSchema).min(1).describe("Ordered list of steps to execute when trigger fires"),
  }),
  execute: async ({ name, enabled, trigger, steps }) => {
    const id = randomUUID();
    db.insert(schema.automations).values({
      id,
      name: name.trim(),
      enabled,
      trigger: JSON.stringify(trigger),
      conditions: "[]",
      actions: "[]",
      workflowVersion: 2,
      steps: JSON.stringify(steps),
    }).run();
    writeAuditEntry(`AI: create_automation "${name}"`, "modify", id);
    return { ok: true, id, name, stepCount: steps.length };
  },
});

export const updateAutomationTool = tool({
  description: "Update an existing automation — patch name, enabled state, trigger, or steps. Only fields provided are changed.",
  inputSchema: z.object({
    id: z.string().describe("Automation ID from list_automations"),
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    trigger: triggerSchema.optional(),
    steps: z.array(stepSchema).optional(),
  }),
  execute: async ({ id, name, enabled, trigger, steps }) => {
    const existing = db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    if (!existing) return { ok: false, error: "automation_not_found" };

    db.update(schema.automations).set({
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
      ...(trigger !== undefined ? { trigger: JSON.stringify(trigger) } : {}),
      ...(steps !== undefined
        ? { steps: JSON.stringify(steps), actions: "[]", workflowVersion: 2 }
        : {}),
    }).where(eq(schema.automations.id, id)).run();

    writeAuditEntry(`AI: update_automation "${existing.name}"`, "modify", id);
    return { ok: true, id };
  },
});

export const deleteAutomationTool = tool({
  description:
    "Permanently delete an automation by ID. This is irreversible — only delete when the user explicitly confirms. Use list_automations to confirm the ID first.",
  inputSchema: z.object({
    id: z.string().describe("Automation ID to delete"),
    confirmName: z.string().describe("The automation name as shown in list_automations, required as confirmation"),
    confirmed: z.boolean().describe("Must be true — ask user to confirm before calling"),
  }),
  execute: async ({ id, confirmName, confirmed }) => {
    if (!confirmed) {
      return { error: "This is a destructive action. Ask the user to confirm, then call again with confirmed: true." };
    }
    const existing = db.select().from(schema.automations).where(eq(schema.automations.id, id)).get();
    if (!existing) return { ok: false, error: "automation_not_found" };
    if (existing.name !== confirmName) {
      return { ok: false, error: `Name mismatch: expected "${existing.name}", got "${confirmName}"` };
    }

    db.delete(schema.automations).where(eq(schema.automations.id, id)).run();
    writeAuditEntry(`AI: delete_automation "${existing.name}"`, "destructive", id);
    return { ok: true, deleted: existing.name };
  },
});

export const getAutomationRunsTool = tool({
  description:
    "Get run history for an automation, including per-step results. Shows when it ran, whether it succeeded, and what each step did.",
  inputSchema: z.object({
    automationId: z.string().describe("Automation ID to get runs for"),
    limit: z.number().default(10).describe("Maximum runs to return"),
  }),
  execute: async ({ automationId, limit }) => {
    const automation = db
      .select()
      .from(schema.automations)
      .where(eq(schema.automations.id, automationId))
      .get();
    if (!automation) return { error: "Automation not found" };

    const runs = db
      .select()
      .from(schema.automationRuns)
      .where(eq(schema.automationRuns.automationId, automationId))
      .orderBy(desc(schema.automationRuns.triggeredAt))
      .limit(limit)
      .all();

    const runsWithSteps = runs.map((run) => {
      const stepRuns = db
        .select()
        .from(schema.automationStepRuns)
        .where(eq(schema.automationStepRuns.runId, run.id))
        .orderBy(schema.automationStepRuns.startedAt)
        .all();
      return {
        id: run.id,
        triggeredAt: run.triggeredAt,
        success: run.success,
        error: run.error,
        actionsRun: run.actionsRun,
        steps: stepRuns.map((s) => ({
          stepType: s.stepType,
          success: s.success,
          blocked: s.blocked,
          output: s.output,
          error: s.error,
          durationMs: s.durationMs,
        })),
      };
    });

    const successCount = runs.filter((r) => r.success).length;
    const failCount = runs.filter((r) => !r.success).length;

    return {
      automationName: automation.name,
      runs: runsWithSteps,
      summary: `${runs.length} run(s) for "${automation.name}": ${successCount} succeeded, ${failCount} failed.`,
    };
  },
});

export const validateCronTool = tool({
  description:
    "Validate a cron expression and show the next scheduled fire times. Use before creating a schedule-triggered automation.",
  inputSchema: z.object({
    cron: z.string().describe('Cron expression (e.g. "0 */6 * * *" for every 6 hours)'),
  }),
  execute: async ({ cron }) => {
    const parts = cron.trim().split(/\s+/);
    if (parts.length < 5 || parts.length > 6) {
      return {
        valid: false,
        error: `Expected 5-6 fields, got ${parts.length}. Format: minute hour day month weekday`,
        summary: "Invalid cron expression.",
      };
    }

    // Basic field validation
    const ranges = [
      { name: "minute", min: 0, max: 59 },
      { name: "hour", min: 0, max: 23 },
      { name: "day", min: 1, max: 31 },
      { name: "month", min: 1, max: 12 },
      { name: "weekday", min: 0, max: 7 },
    ];

    for (let i = 0; i < Math.min(parts.length, 5); i++) {
      const field = parts[i];
      if (field === "*" || field.includes("/") || field.includes(",") || field.includes("-")) continue;
      const num = parseInt(field, 10);
      if (isNaN(num) || num < ranges[i].min || num > ranges[i].max) {
        return {
          valid: false,
          error: `Field "${ranges[i].name}" value "${field}" is out of range (${ranges[i].min}–${ranges[i].max})`,
          summary: `Invalid ${ranges[i].name} field.`,
        };
      }
    }

    // Compute next 5 fire times using simple forward iteration
    const nextTimes = computeNextCronTimes(parts, 5);

    return {
      valid: true,
      cron,
      nextFireTimes: nextTimes,
      summary: `Valid cron. Next: ${nextTimes[0] ?? "unknown"}`,
    };
  },
});

function computeNextCronTimes(parts: string[], count: number): string[] {
  const times: string[] = [];
  const now = new Date();
  const check = new Date(now);
  check.setSeconds(0, 0);
  check.setMinutes(check.getMinutes() + 1);

  for (let i = 0; i < 1440 * 30 && times.length < count; i++) {
    if (cronMatches(parts, check)) {
      times.push(check.toISOString());
    }
    check.setMinutes(check.getMinutes() + 1);
  }
  return times;
}

function cronMatches(parts: string[], date: Date): boolean {
  const fields = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay(),
  ];
  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(parts[i], fields[i])) return false;
  }
  return true;
}

function fieldMatches(pattern: string, value: number): boolean {
  if (pattern === "*") return true;
  for (const part of pattern.split(",")) {
    if (part.includes("/")) {
      const [base, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      const start = base === "*" ? 0 : parseInt(base, 10);
      if (value >= start && (value - start) % step === 0) return true;
    } else if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      if (value >= lo && value <= hi) return true;
    } else {
      if (parseInt(part, 10) === value) return true;
    }
  }
  return false;
}

export const listAutomationSafeToolsTool = tool({
  description:
    "List all tools that are available for use in automation steps (tool_action and ai_prompt). Shows tool names and their tiers.",
  inputSchema: z.object({}),
  execute: async () => {
    const tools = getAutomationSafeTools();
    return {
      tools,
      count: tools.length,
      summary: `${tools.length} tools available for automations.`,
    };
  },
});
