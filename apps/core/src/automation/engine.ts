import { exec } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { db, schema } from "../db/index.js";
import { and, eq, inArray } from "drizzle-orm";
import { writeAuditEntry } from "../db/audit.js";
import { writeNotification } from "../db/notifications.js";
import { restartContainer } from "../docker/client.js";
import { requiresApproval } from "../approval/engine.js";
import { runAutomationPrompt } from "../ai/agent.js";
import { getAutomationSafeToolNames } from "../ai/automation-safe-tools.js";
import { getAllRegisteredTools } from "../ai/tool-registry.js";
import { createLogger } from "../utils/logger.js";
import { runWithActor } from "../ops/operations.js";

const log = createLogger("automation-engine");
const execAsync = promisify(exec);

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AutomationTrigger {
  type: string;
  containerId?: string;
  mountPath?: string;
  threshold?: number;
  appId?: string;
  cron?: string;
}

export interface AutomationCondition {
  field: string;
  operator: "eq" | "gt" | "lt" | "contains";
  value: string | number;
}

// ── Legacy v1 actions ─────────────────────────────────────────────────────────

export type AutomationAction =
  | { type: "restart_container"; containerId: string; approved?: boolean }
  | { type: "send_notification"; level: "info" | "warning" | "critical"; title: string; body?: string; approved?: boolean }
  | { type: "run_shell"; command: string; approved?: boolean }
  | { type: "ask_ai"; prompt: string; approved?: boolean };

// ── v2 Steps ──────────────────────────────────────────────────────────────────

export type AutomationStep =
  | { id: string; type: "notify"; level: "info" | "warning" | "critical"; title: string; body?: string }
  | { id: string; type: "tool_action"; toolName: string; args?: Record<string, unknown>; approvalPolicy?: "auto" | "require_approval" }
  | { id: string; type: "ai_prompt"; promptTemplate: string; allowedTools: string[]; approvalPolicy?: "auto" | "require_approval"; timeoutMs?: number; outputKey?: string }
  | { id: string; type: "condition"; field: string; operator: "eq" | "gt" | "lt" | "contains"; value: unknown; onFail?: "stop" | "continue" };

export interface StepRunResult {
  stepId: string;
  stepType: string;
  success: boolean;
  output?: string;
  error?: string;
  blocked?: boolean;
  durationMs: number;
}

interface RunResult {
  success: boolean;
  error: string | null;
  actionsRun: number;
  results: StepRunResult[];
}

interface ExecutionContext {
  automationId: string;
  automationName: string;
  triggerType: string;
  triggerData: Record<string, unknown>;
  stepOutputs: Record<string, string>;
}

// ── Trigger matching ──────────────────────────────────────────────────────────

function matchesTrigger(
  trigger: AutomationTrigger,
  data: Record<string, unknown>,
): boolean {
  if (trigger.containerId) {
    const containerIds = [data.containerId, data.containerName].filter(
      (v): v is string => typeof v === "string" && v.length > 0,
    );
    if (!containerIds.includes(trigger.containerId)) return false;
  }
  if (trigger.mountPath && data.mountPath !== trigger.mountPath) return false;
  if (trigger.appId && data.appId !== trigger.appId) return false;
  if (
    trigger.threshold !== undefined &&
    typeof data.pct === "number" &&
    data.pct < trigger.threshold
  )
    return false;
  return true;
}

// ── Prompt template interpolation ─────────────────────────────────────────────

function interpolate(template: string, ctx: ExecutionContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (key in ctx.triggerData) return String(ctx.triggerData[key] ?? "");
    if (key in ctx.stepOutputs) return ctx.stepOutputs[key];
    return `{{${key}}}`;
  });
}

// ── Automation-safe tool registry (derived from tool-registry tiers) ──────────

/** @deprecated Use getAutomationSafeToolNames() instead — kept for type compat */
export const AUTOMATION_ALLOWED_TOOLS = [] as readonly string[];
export type AllowedAutomationTool = string;

// ── v1 legacy action runners ───────────────────────────────────────────────────

function actionToToolName(actionType: AutomationAction["type"]): string {
  switch (actionType) {
    case "restart_container": return "restart_container";
    case "send_notification": return "remember";
    case "run_shell": return "run_shell";
    case "ask_ai": return "launch_claude_code";
  }
}

function actionTier(actionType: AutomationAction["type"]): "read" | "modify" | "destructive" {
  switch (actionType) {
    case "restart_container": return "modify";
    case "send_notification": return "modify";
    case "run_shell": return "destructive";
    case "ask_ai": return "modify";
  }
}

const AUTO_ALLOWED_ACTIONS = new Set<AutomationAction["type"]>([
  "restart_container",
  "send_notification",
]);

function requiresExplicitAutomationApproval(action: AutomationAction): boolean {
  if (AUTO_ALLOWED_ACTIONS.has(action.type)) return false;
  if (action.approved === true) return false;
  return requiresApproval(actionToToolName(action.type));
}

// ── v2 Step runner ─────────────────────────────────────────────────────────────

async function runStep(
  step: AutomationStep,
  ctx: ExecutionContext,
): Promise<StepRunResult> {
  const startedAt = Date.now();

  const makeResult = (
    success: boolean,
    output?: string,
    error?: string,
    blocked?: boolean,
  ): StepRunResult => ({
    stepId: step.id,
    stepType: step.type,
    success,
    output,
    error,
    blocked,
    durationMs: Date.now() - startedAt,
  });

  try {
    switch (step.type) {
      case "notify": {
        const title = interpolate(step.title, ctx);
        const body = interpolate(step.body ?? "", ctx);
        writeNotification(step.level, title, body);
        return makeResult(true, `Sent ${step.level}: "${title}"`);
      }

      case "tool_action": {
        const policy = step.approvalPolicy ?? "require_approval";
        if (policy === "require_approval") {
          const msg = `Step "${step.toolName}" requires approval before running`;
          writeAuditEntry(`Automation step blocked: ${step.toolName}`, "destructive", ctx.automationId, false);
          return makeResult(false, undefined, msg, true);
        }

        // Validate tool is in the automation-safe list
        const safeTools = getAutomationSafeToolNames();
        if (!safeTools.has(step.toolName)) {
          return makeResult(false, undefined, `Tool "${step.toolName}" is not allowed in automations`);
        }

        // Look up and execute the tool dynamically
        const allTools = getAllRegisteredTools();
        const toolDef = allTools[step.toolName] as { execute?: (args: unknown, ctx: unknown) => Promise<unknown> } | undefined;
        if (!toolDef?.execute) {
          return makeResult(false, undefined, `Tool "${step.toolName}" not found or has no execute function`);
        }

        const result = await toolDef.execute(step.args ?? {}, {});
        const output = typeof result === "string" ? result : JSON.stringify(result, null, 2).slice(0, 4000);
        writeAuditEntry(`Automation step: ${step.toolName}`, "modify", ctx.automationId);
        return makeResult(true, output);
      }

      case "ai_prompt": {
        const policy = step.approvalPolicy ?? "auto";
        if (policy === "require_approval") {
          const msg = `AI Prompt step requires approval before running`;
          writeAuditEntry(`Automation step blocked: ai_prompt`, "modify", ctx.automationId, false);
          return makeResult(false, undefined, msg, true);
        }

        const interpolatedPrompt = interpolate(step.promptTemplate, ctx);
        const safeToolNames = getAutomationSafeToolNames();
        const allowed = step.allowedTools.filter((t) => safeToolNames.has(t));

        const aiText = await runAutomationPrompt({
          prompt: interpolatedPrompt,
          automationName: ctx.automationName,
          triggerType: ctx.triggerType,
          allowedTools: allowed,
        });

        writeAuditEntry(`Automation step: ai_prompt`, "read", ctx.automationId);
        writeNotification(
          "info",
          `"${ctx.automationName}" AI analysis`,
          aiText.slice(0, 1200),
          ctx.automationId,
        );

        if (step.outputKey) {
          ctx.stepOutputs[step.outputKey] = aiText;
        }

        return makeResult(true, aiText.slice(0, 4000));
      }

      case "condition": {
        const rawFieldValue = ctx.triggerData[step.field] ?? ctx.stepOutputs[step.field];
        let pass = false;
        switch (step.operator) {
          case "eq": pass = rawFieldValue === step.value; break;
          case "gt": pass = typeof rawFieldValue === "number" && rawFieldValue > (step.value as number); break;
          case "lt": pass = typeof rawFieldValue === "number" && rawFieldValue < (step.value as number); break;
          case "contains":
            pass = typeof rawFieldValue === "string" && rawFieldValue.includes(String(step.value));
            break;
        }
        return makeResult(pass, pass ? "Condition passed" : "Condition failed");
      }
    }
  } catch (err) {
    return makeResult(false, undefined, err instanceof Error ? err.message : String(err));
  }
}

// ── v2 Step-based runner ───────────────────────────────────────────────────────

export async function runSteps(
  steps: AutomationStep[],
  context: { automationId: string; automationName: string; triggerType: string; triggerData?: Record<string, unknown> },
  journal?: StepJournal,
): Promise<RunResult> {
  const ctx: ExecutionContext = {
    ...context,
    triggerData: context.triggerData ?? {},
    stepOutputs: {},
  };

  const results: StepRunResult[] = [];
  let actionsRun = 0;

  for (const [index, step] of steps.entries()) {
    if (journal && !journal.beforeStep(index, step.id, step.type)) {
      // Already executed under this idempotency key — never run a step twice.
      const skipped: StepRunResult = { stepId: step.id, stepType: step.type, success: true, output: "Skipped: step already executed (idempotency key)", durationMs: 0 };
      results.push(skipped);
      actionsRun++;
      continue;
    }
    const result = await runStep(step, ctx);
    journal?.afterStep(index, result);
    results.push(result);

    if (result.blocked) {
      return { success: false, error: result.error ?? "Step blocked", actionsRun, results };
    }

    if (!result.success) {
      if (step.type === "condition") {
        const onFail = step.onFail ?? "stop";
        if (onFail === "stop") {
          return { success: false, error: "Condition failed — automation stopped", actionsRun, results };
        }
        continue;
      }
      return { success: false, error: result.error ?? `Step ${step.type} failed`, actionsRun, results };
    }

    actionsRun++;
  }

  return { success: true, error: null, actionsRun, results };
}

// ── v1 Legacy action runner ────────────────────────────────────────────────────

export async function runActions(
  actions: AutomationAction[],
  context: { automationId: string; automationName: string; triggerType: string },
  journal?: StepJournal,
): Promise<RunResult> {
  let actionsRun = 0;
  const results: StepRunResult[] = [];
  const record = (index: number, result: StepRunResult) => {
    journal?.afterStep(index, result);
    results.push(result);
  };

  for (const [index, action] of actions.entries()) {
    const stepId = `v1-${action.type}-${actionsRun}`;

    if (journal && !journal.beforeStep(index, stepId, action.type)) {
      results.push({ stepId, stepType: action.type, success: true, output: "Skipped: step already executed (idempotency key)", durationMs: 0 });
      actionsRun++;
      continue;
    }

    if (requiresExplicitAutomationApproval(action)) {
      const message = `Action "${action.type}" requires explicit approval before automatic execution`;
      writeAuditEntry(
        `Automation blocked: ${action.type}`,
        actionTier(action.type),
        `${context.automationId}`,
        false,
      );
      record(index, { stepId, stepType: action.type, success: false, error: message, blocked: true, durationMs: 0 });
      return { success: false, error: message, actionsRun, results };
    }

    const start = Date.now();
    try {
      switch (action.type) {
        case "restart_container":
          await restartContainer(action.containerId);
          writeAuditEntry(`Automation: restart_container ${action.containerId}`, "modify", action.containerId);
          record(index, { stepId, stepType: action.type, success: true, output: `Restarted container ${action.containerId}`, durationMs: Date.now() - start });
          break;

        case "send_notification":
          writeNotification(action.level, action.title, action.body ?? "");
          record(index, { stepId, stepType: action.type, success: true, output: `Sent ${action.level} notification "${action.title}"`, durationMs: Date.now() - start });
          break;

        case "run_shell": {
          const { stdout, stderr } = await execAsync(action.command, { timeout: 30_000 });
          writeAuditEntry(`Automation: run_shell`, "destructive", action.command);
          log.info(`run_shell output: ${stdout || stderr || "(empty)"}`);
          record(index, { stepId, stepType: action.type, success: true, output: `Executed: ${action.command}`, durationMs: Date.now() - start });
          break;
        }

        case "ask_ai": {
          const aiText = await runAutomationPrompt({
            prompt: action.prompt,
            automationName: context.automationName,
            triggerType: context.triggerType,
            allowedTools: [],
          });
          writeAuditEntry(`Automation: ask_ai`, "read", action.prompt);
          writeNotification(
            "info",
            `Automation "${context.automationName}" AI analysis`,
            aiText.slice(0, 1200),
            context.automationId,
          );
          record(index, { stepId, stepType: action.type, success: true, output: aiText.slice(0, 4000), durationMs: Date.now() - start });
          break;
        }
      }
      actionsRun++;
    } catch (err) {
      log.error(`Action ${action.type} failed`, err);
      const error = err instanceof Error ? err.message : String(err);
      record(index, { stepId, stepType: action.type, success: false, error, durationMs: Date.now() - start });
      return { success: false, error, actionsRun, results };
    }
  }

  return { success: true, error: null, actionsRun, results };
}

// ── Durable run journal ───────────────────────────────────────────────────────
//
// The run row and every step row are written BEFORE execution and updated at
// every transition (pending → running → succeeded/failed/blocked, or skipped),
// so a crash mid-run leaves an accurate record. Each step carries the
// idempotency key `${runId}:${stepIndex}`; a step already recorded as
// succeeded under its key is never executed again.

export interface StepJournal {
  /** Persist the pending → running transition. Returns false if the step already ran (skip it). */
  beforeStep(index: number, stepId: string, stepType: string): boolean;
  /** Persist the running → terminal transition. */
  afterStep(index: number, result: StepRunResult): void;
}

interface PlannedStep {
  stepId: string;
  stepType: string;
}

export function stepIdempotencyKey(runId: string, stepIndex: number): string {
  return `${runId}:${stepIndex}`;
}

function stepStatus(result: StepRunResult): string {
  if (result.blocked) return "blocked";
  return result.success ? "succeeded" : "failed";
}

export function createRunJournal(
  runId: string,
  automationId: string,
  planned: PlannedStep[],
): StepJournal & { finalize(): void } {
  const rowIds = new Map<number, string>();
  const createdAt = new Date().toISOString();

  planned.forEach((p, index) => {
    const id = randomUUID();
    try {
      db.insert(schema.automationStepRuns).values({
        id,
        runId,
        automationId,
        stepId: p.stepId,
        stepType: p.stepType,
        startedAt: createdAt,
        durationMs: null,
        success: false,
        output: null,
        error: null,
        blocked: false,
        status: "pending",
        stepIndex: index,
        idempotencyKey: stepIdempotencyKey(runId, index),
        finishedAt: null,
      }).run();
      rowIds.set(index, id);
    } catch (err) {
      log.error(`Failed to persist pending step ${p.stepId} for run ${runId}`, err);
    }
  });

  return {
    beforeStep(index, stepId, stepType) {
      const key = stepIdempotencyKey(runId, index);
      const startedAt = new Date().toISOString();
      try {
        const existing = db
          .select({ id: schema.automationStepRuns.id, status: schema.automationStepRuns.status })
          .from(schema.automationStepRuns)
          .where(eq(schema.automationStepRuns.idempotencyKey, key))
          .get();
        if (existing?.status === "succeeded") return false;
        if (existing) {
          rowIds.set(index, existing.id);
          db.update(schema.automationStepRuns)
            .set({ status: "running", startedAt })
            .where(eq(schema.automationStepRuns.id, existing.id))
            .run();
        } else {
          const id = randomUUID();
          db.insert(schema.automationStepRuns).values({
            id,
            runId,
            automationId,
            stepId,
            stepType,
            startedAt,
            success: false,
            blocked: false,
            status: "running",
            stepIndex: index,
            idempotencyKey: key,
          }).run();
          rowIds.set(index, id);
        }
      } catch (err) {
        log.error(`Failed to persist running state for step ${stepId} (run ${runId})`, err);
      }
      return true;
    },
    afterStep(index, result) {
      const id = rowIds.get(index);
      if (!id) return;
      try {
        db.update(schema.automationStepRuns)
          .set({
            status: stepStatus(result),
            success: result.success,
            durationMs: result.durationMs,
            output: result.output ?? null,
            error: result.error ?? null,
            blocked: result.blocked ?? false,
            finishedAt: new Date().toISOString(),
          })
          .where(eq(schema.automationStepRuns.id, id))
          .run();
      } catch (err) {
        log.error(`Failed to persist result for step ${result.stepId} (run ${runId})`, err);
      }
    },
    finalize() {
      try {
        db.update(schema.automationStepRuns)
          .set({ status: "skipped", finishedAt: new Date().toISOString() })
          .where(and(eq(schema.automationStepRuns.runId, runId), eq(schema.automationStepRuns.status, "pending")))
          .run();
      } catch (err) {
        log.error(`Failed to mark skipped steps for run ${runId}`, err);
      }
    },
  };
}

/**
 * Boot recovery: runs (and steps) left "running"/"pending" by a previous
 * process are marked interrupted. They are NOT re-run.
 */
export function markInterruptedAutomationRuns(): number {
  const at = new Date().toISOString();
  const runs = db
    .update(schema.automationRuns)
    .set({ status: "interrupted", success: false, error: "Interrupted by server restart", finishedAt: at })
    .where(eq(schema.automationRuns.status, "running"))
    .run();
  db.update(schema.automationStepRuns)
    .set({ status: "interrupted", success: false, error: "Interrupted by server restart", finishedAt: at })
    .where(inArray(schema.automationStepRuns.status, ["running", "pending"]))
    .run();
  return runs.changes;
}

// ── Trigger entrypoint ────────────────────────────────────────────────────────

type ParsedWorkflow =
  | { kind: "steps"; steps: AutomationStep[] }
  | { kind: "actions"; actions: AutomationAction[] };

function parseWorkflow(auto: typeof schema.automations.$inferSelect): ParsedWorkflow | null {
  if (auto.workflowVersion === 2 && auto.steps) {
    try {
      return { kind: "steps", steps: JSON.parse(auto.steps) as AutomationStep[] };
    } catch {
      log.error(`Invalid steps JSON in automation ${auto.id}`);
      return null;
    }
  }
  try {
    return { kind: "actions", actions: JSON.parse(auto.actions) as AutomationAction[] };
  } catch {
    log.error(`Invalid actions JSON in automation ${auto.id}`);
    return null;
  }
}

function plannedSteps(workflow: ParsedWorkflow): PlannedStep[] {
  if (workflow.kind === "steps") {
    return workflow.steps.map((s) => ({ stepId: s.id, stepType: s.type }));
  }
  // v1 ids are assigned by position in runActions (`v1-<type>-<n>`)
  return workflow.actions.map((a, i) => ({ stepId: `v1-${a.type}-${i}`, stepType: a.type }));
}

export async function fireTrigger(
  type: string,
  data: Record<string, unknown> = {},
): Promise<RunResult[]> {
  const runResults: RunResult[] = [];
  try {
    const all = db
      .select()
      .from(schema.automations)
      .where(eq(schema.automations.enabled, true))
      .all();

    for (const auto of all) {
      if (typeof data.automationId === "string" && auto.id !== data.automationId) continue;

      let trigger: AutomationTrigger;

      try {
        trigger = JSON.parse(auto.trigger) as AutomationTrigger;
      } catch {
        log.error(`Invalid trigger JSON in automation ${auto.id}`);
        continue;
      }

      if (trigger.type !== type) continue;
      if (!data.manual && !matchesTrigger(trigger, data)) continue;

      const workflow = parseWorkflow(auto);
      if (!workflow) continue;

      const runId = randomUUID();
      const triggeredAt = new Date().toISOString();

      // Run row first — before any step executes.
      try {
        db.insert(schema.automationRuns).values({
          id: runId,
          automationId: auto.id,
          triggeredAt,
          success: true,
          error: null,
          actionsRun: 0,
          status: "running",
        }).run();
      } catch (err) {
        log.error(`Failed to write run record for ${auto.id}`, err);
      }

      const journal = createRunJournal(runId, auto.id, plannedSteps(workflow));
      let result: RunResult;

      try {
        // Dispatch to v2 step runner or v1 legacy runner
        // Attribute any app operations started by this run to the automation.
        result = await runWithActor(`automation:${auto.id}`, () =>
          workflow.kind === "steps"
            ? runSteps(workflow.steps, {
              automationId: auto.id,
              automationName: auto.name,
              triggerType: type,
              triggerData: data,
            }, journal)
            : runActions(workflow.actions, {
              automationId: auto.id,
              automationName: auto.name,
              triggerType: type,
            }, journal));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result = { success: false, error, actionsRun: 0, results: [] };
      }
      journal.finalize();

      if (!result.success && result.error) {
        writeNotification(
          "warning",
          `Automation "${auto.name}" failed`,
          result.error,
          auto.id,
        );
      }

      try {
        db.update(schema.automationRuns)
          .set({
            success: result.success,
            status: result.success ? "succeeded" : "failed",
            error: result.error,
            actionsRun: result.actionsRun,
            resultSummary: JSON.stringify(result.results),
            finishedAt: new Date().toISOString(),
          })
          .where(eq(schema.automationRuns.id, runId))
          .run();
      } catch (err) {
        log.error(`Failed to finalize run record for ${auto.id}`, err);
      }

      try {
        db.update(schema.automations)
          .set({
            lastRunAt: triggeredAt,
            runCount: auto.runCount + 1,
          })
          .where(eq(schema.automations.id, auto.id))
          .run();
        writeAuditEntry(`Automation fired: ${auto.name}`, "modify", auto.id);
      } catch (err) {
        log.error(`Failed to update runCount for ${auto.id}`, err);
      }
      runResults.push(result);
    }
  } catch (err) {
    log.error("fireTrigger error", err);
  }
  return runResults;
}
