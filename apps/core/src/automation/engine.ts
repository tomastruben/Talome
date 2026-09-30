import { exec } from "node:child_process";
import { promisify } from "node:util";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { writeAuditEntry } from "../db/audit.js";
import { writeNotification } from "../db/notifications.js";
import { restartContainer } from "../docker/client.js";
import { requiresApproval } from "../approval/engine.js";
import { runAutomationPrompt, getToolTier } from "../ai/agent.js";
import { getAutomationSafeToolNames } from "../ai/automation-safe-tools.js";
import { getAllRegisteredTools } from "../ai/tool-registry.js";
import { createLogger } from "../utils/logger.js";
import * as runStore from "./run-store.js";
import { authorizeToolCall, checkToolPolicy, getSecurityMode, withConfirmation } from "../ai/tool-gateway.js";
import { consumeApproval, expireStaleApprovals, requestApproval } from "../approval/tool-approvals.js";

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
  /** Approval request this step is waiting on (require_approval steps) */
  approvalId?: string;
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
    approvalId?: string,
  ): StepRunResult => ({
    stepId: step.id,
    stepType: step.type,
    success,
    output,
    error,
    blocked,
    approvalId,
    durationMs: Date.now() - startedAt,
  });

  const actor = { kind: "automation", name: ctx.automationName, id: ctx.automationId } as const;

  /**
   * "require_approval" steps wait for a person: the first attempt files an approval
   * request and blocks; once an admin approves it, the resumed run consumes the
   * approval (bound to this automation, tool and arguments) and proceeds.
   */
  const waitForApproval = (toolName: string, tier: "read" | "modify" | "destructive", args: Record<string, unknown>) => {
    if (consumeApproval(actor, toolName, args)) return null;
    const request = requestApproval(actor, toolName, tier, args);
    writeAuditEntry(`Automation step waiting for approval: ${toolName}`, tier, ctx.automationId, false);
    return makeResult(
      false,
      undefined,
      `Step "${toolName}" is waiting for approval (request ${request.code}) in Settings > Security`,
      true,
      request.id,
    );
  };

  try {
    switch (step.type) {
      case "notify": {
        const title = interpolate(step.title, ctx);
        const body = interpolate(step.body ?? "", ctx);
        writeNotification(step.level, title, body);
        return makeResult(true, `Sent ${step.level}: "${title}"`);
      }

      case "tool_action": {
        // Everything that could refuse the step is checked before a person is
        // asked to approve it, so an approval is never spent on a step that can't run.
        const safeTools = getAutomationSafeToolNames();
        if (!safeTools.has(step.toolName)) {
          return makeResult(false, undefined, `Tool "${step.toolName}" is not allowed in automations`);
        }

        const allTools = getAllRegisteredTools();
        const toolDef = allTools[step.toolName] as { execute?: (args: unknown, ctx: unknown) => Promise<unknown> } | undefined;
        if (!toolDef?.execute) {
          return makeResult(false, undefined, `Tool "${step.toolName}" not found or has no execute function`);
        }

        const stepArgs = (step.args ?? {}) as Record<string, unknown>;
        const tier = getToolTier(step.toolName);
        if (checkToolPolicy(tier, getSecurityMode()) === "block") {
          writeAuditEntry(`Automation BLOCKED (locked mode): ${step.toolName}`, tier, ctx.automationId, false);
          return makeResult(false, undefined, `Step "${step.toolName}" is blocked — security mode is locked`);
        }

        const policy = step.approvalPolicy ?? "require_approval";
        let approvedByPerson = false;
        if (policy === "require_approval") {
          const waiting = waitForApproval(step.toolName, tier, stepArgs);
          if (waiting) return waiting;
          approvedByPerson = true;
        }

        // Same authorization as every other caller
        const decision = authorizeToolCall(step.toolName, tier, stepArgs, actor);
        if (!decision.allowed) {
          writeAuditEntry(`Automation ${decision.auditAction}`, tier, ctx.automationId, false);
          return makeResult(false, undefined, decision.reason);
        }

        const result = await toolDef.execute(withConfirmation(stepArgs, approvedByPerson || decision.approvalId !== undefined), {});
        const output = typeof result === "string" ? result : JSON.stringify(result, null, 2).slice(0, 4000);
        writeAuditEntry(`Automation step: ${step.toolName}`, tier, ctx.automationId);
        return makeResult(true, output);
      }

      case "ai_prompt": {
        const policy = step.approvalPolicy ?? "auto";
        const interpolatedPrompt = interpolate(step.promptTemplate, ctx);
        if (policy === "require_approval") {
          const waiting = waitForApproval("automation_ai_prompt", "modify", { prompt: interpolatedPrompt, allowedTools: step.allowedTools });
          if (waiting) return waiting;
        }

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
): Promise<RunResult> {
  const ctx: ExecutionContext = {
    ...context,
    triggerData: context.triggerData ?? {},
    stepOutputs: {},
  };

  const results: StepRunResult[] = [];
  let actionsRun = 0;

  for (const step of steps) {
    const result = await runStep(step, ctx);
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
): Promise<RunResult> {
  let actionsRun = 0;
  const results: StepRunResult[] = [];

  for (const action of actions) {
    const stepId = `v1-${action.type}-${actionsRun}`;

    if (requiresExplicitAutomationApproval(action)) {
      const message = `Action "${action.type}" requires explicit approval before automatic execution`;
      writeAuditEntry(
        `Automation blocked: ${action.type}`,
        actionTier(action.type),
        `${context.automationId}`,
        false,
      );
      results.push({ stepId, stepType: action.type, success: false, error: message, blocked: true, durationMs: 0 });
      return { success: false, error: message, actionsRun, results };
    }

    // Locked mode blocks every non-read action, whatever the automation says
    if (checkToolPolicy(actionTier(action.type), getSecurityMode()) === "block") {
      const message = `Action "${action.type}" is blocked — security mode is locked`;
      writeAuditEntry(`Automation blocked (locked mode): ${action.type}`, actionTier(action.type), context.automationId, false);
      results.push({ stepId, stepType: action.type, success: false, error: message, blocked: true, durationMs: 0 });
      return { success: false, error: message, actionsRun, results };
    }

    const start = Date.now();
    try {
      switch (action.type) {
        case "restart_container":
          await restartContainer(action.containerId);
          writeAuditEntry(`Automation: restart_container ${action.containerId}`, "modify", action.containerId);
          results.push({ stepId, stepType: action.type, success: true, output: `Restarted container ${action.containerId}`, durationMs: Date.now() - start });
          break;

        case "send_notification":
          writeNotification(action.level, action.title, action.body ?? "");
          results.push({ stepId, stepType: action.type, success: true, output: `Sent ${action.level} notification "${action.title}"`, durationMs: Date.now() - start });
          break;

        case "run_shell": {
          const { stdout, stderr } = await execAsync(action.command, { timeout: 30_000 });
          writeAuditEntry(`Automation: run_shell`, "destructive", action.command);
          log.info(`run_shell output: ${stdout || stderr || "(empty)"}`);
          results.push({ stepId, stepType: action.type, success: true, output: `Executed: ${action.command}`, durationMs: Date.now() - start });
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
          results.push({ stepId, stepType: action.type, success: true, output: aiText.slice(0, 4000), durationMs: Date.now() - start });
          break;
        }
      }
      actionsRun++;
    } catch (err) {
      log.error(`Action ${action.type} failed`, err);
      const error = err instanceof Error ? err.message : String(err);
      results.push({ stepId, stepType: action.type, success: false, error, durationMs: Date.now() - start });
      return { success: false, error, actionsRun, results };
    }
  }

  return { success: true, error: null, actionsRun, results };
}

// ── Durable execution ──────────────────────────────────────────────────────────

type AutomationRow = typeof schema.automations.$inferSelect;

/** Steps that can safely run twice: no side effects, or harmless ones (deduplicated notifications). */
function isRetrySafe(step: AutomationStep): boolean {
  switch (step.type) {
    case "condition":
    case "notify":
      return true;
    case "tool_action":
      return getToolTier(step.toolName) === "read";
    case "ai_prompt": {
      // Mirrors runStep: unsafe names are dropped, and an empty list means the
      // prompt may use every automation-safe tool (which includes modify tools).
      const safe = getAutomationSafeToolNames();
      const effective = step.allowedTools.filter((name) => safe.has(name));
      const tools = effective.length > 0 ? effective : [...safe];
      return tools.every((name) => getToolTier(name) === "read");
    }
  }
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Heartbeat that keeps this process's lease alive while a long step runs. */
function startHeartbeat(runId: string): () => void {
  const timer = setInterval(() => {
    try {
      runStore.renewLease(runId);
    } catch (err) {
      log.error(`Lease renewal failed for run ${runId}`, err);
    }
  }, runStore.HEARTBEAT_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

function completedRunResult(stepRows: runStore.StepRunRow[]): StepRunResult[] {
  return stepRows
    .filter((r) => r.status !== "retried")
    .map((r) => ({
      stepId: r.stepId,
      stepType: r.stepType,
      success: r.success,
      output: r.output ?? undefined,
      error: r.error ?? undefined,
      blocked: r.blocked,
      approvalId: r.approvalId ?? undefined,
      durationMs: r.durationMs ?? 0,
    }));
}

function onRunFinished(runId: string, automationName: string, automationId: string, result: RunResult, status: runStore.RunStatus): void {
  if (status === "failed" && result.error) {
    writeNotification("warning", `Automation "${automationName}" failed`, result.error, automationId);
  }
  if (status === "waiting_approval") {
    // Not finished yet: counted once, when the run reaches its final state
    writeNotification("info", `Automation "${automationName}" is waiting for approval`, result.error ?? "", automationId);
    writeAuditEntry(`Automation waiting_approval: ${automationName}`, "modify", `${automationId} · run ${runId}`);
    return;
  }
  const auto = db.select().from(schema.automations).where(eq(schema.automations.id, automationId)).get();
  if (auto) {
    db.update(schema.automations)
      .set({ lastRunAt: new Date().toISOString(), runCount: auto.runCount + 1 })
      .where(eq(schema.automations.id, automationId))
      .run();
  }
  writeAuditEntry(`Automation ${status}: ${automationName}`, "modify", `${automationId} · run ${runId}`);
}

/**
 * Execute a v2 run from its persisted state. The caller must hold the run's lease
 * (createRun or acquireRun). Completed steps are skipped; each remaining step is
 * recorded as running before it executes and finished after.
 */
export async function executeDurableRun(runId: string): Promise<RunResult> {
  const run = runStore.getRun(runId);
  if (!run) return { success: false, error: "Run not found", actionsRun: 0, results: [] };
  const auto = db.select().from(schema.automations).where(eq(schema.automations.id, run.automationId)).get();
  const automationName = auto?.name ?? run.automationId;
  const steps = parseJson<AutomationStep[]>(run.stepsSnapshot, []);

  const ctx: ExecutionContext = {
    automationId: run.automationId,
    automationName,
    triggerType: run.triggerType ?? "manual",
    triggerData: parseJson<Record<string, unknown>>(run.triggerData, {}),
    stepOutputs: parseJson<Record<string, string>>(run.context, {}),
  };

  const done = runStore.getStepRuns(runId).filter((r) => r.status === "succeeded" || r.status === "failed");
  const nextIndex = done.length > 0 ? Math.max(...done.map((r) => r.stepIndex ?? -1)) + 1 : 0;
  let actionsRun = run.actionsRun;

  const finish = (status: Exclude<runStore.RunStatus, "running">, error: string | null): RunResult => {
    const results = completedRunResult(runStore.getStepRuns(runId));
    const result: RunResult = { success: status === "succeeded", error, actionsRun, results };
    runStore.finishRun(runId, status, { error, actionsRun, resultSummary: results });
    onRunFinished(runId, automationName, run.automationId, result, status);
    return result;
  };

  const stopHeartbeat = startHeartbeat(runId);
  try {
    for (let index = nextIndex; index < steps.length; index++) {
      const step = steps[index];
      const stepRunId = runStore.beginStep(runId, run.automationId, index, step.id, step.type);
      const result = await runStep(step, ctx);
      runStore.finishStep(stepRunId, result);

      if (result.blocked) {
        return finish(result.approvalId ? "waiting_approval" : "failed", result.error ?? "Step blocked");
      }
      if (!result.success) {
        if (step.type === "condition" && (step.onFail ?? "stop") === "continue") {
          runStore.saveContext(runId, ctx.stepOutputs, actionsRun);
          continue;
        }
        const error = step.type === "condition" ? "Condition failed — automation stopped" : result.error ?? `Step ${step.type} failed`;
        return finish("failed", error);
      }
      actionsRun++;
      runStore.saveContext(runId, ctx.stepOutputs, actionsRun);
    }
    return finish("succeeded", null);
  } finally {
    stopHeartbeat();
  }
}

/** Run one automation now, durably. Skips if a run of it is already in progress. */
async function startAutomationRun(auto: AutomationRow, type: string, data: Record<string, unknown>): Promise<RunResult | null> {
  if (runStore.hasActiveRun(auto.id)) {
    // Includes a run waiting for approval: new triggers would otherwise pile up
    // runs that all wait on (and then race for) the same approval.
    log.warn(`Automation "${auto.name}" already has a run in progress or waiting for approval — skipping trigger`);
    return null;
  }

  if (auto.workflowVersion === 2 && auto.steps) {
    let steps: AutomationStep[];
    try {
      steps = JSON.parse(auto.steps) as AutomationStep[];
    } catch {
      log.error(`Invalid steps JSON in automation ${auto.id}`);
      return null;
    }
    const runId = runStore.createRun({ automationId: auto.id, workflowVersion: 2, triggerType: type, triggerData: data, steps });
    return executeDurableRun(runId);
  }

  // Legacy v1 actions: the run is recorded before it starts so an interruption is
  // visible, but v1 runs are never resumed (their actions are not step-recorded).
  let actions: AutomationAction[];
  try {
    actions = JSON.parse(auto.actions) as AutomationAction[];
  } catch {
    log.error(`Invalid actions JSON in automation ${auto.id}`);
    return null;
  }
  const runId = runStore.createRun({ automationId: auto.id, workflowVersion: 1, triggerType: type, triggerData: data });
  const stopHeartbeat = startHeartbeat(runId);
  let result: RunResult;
  try {
    result = await runActions(actions, { automationId: auto.id, automationName: auto.name, triggerType: type });
  } finally {
    stopHeartbeat();
  }
  const startedAt = runStore.getRun(runId)?.triggeredAt ?? new Date().toISOString();
  result.results.forEach((r, index) => {
    const stepRunId = runStore.beginStep(runId, auto.id, index, r.stepId, r.stepType);
    db.update(schema.automationStepRuns).set({ startedAt }).where(eq(schema.automationStepRuns.id, stepRunId)).run();
    runStore.finishStep(stepRunId, r);
  });
  const status = result.success ? "succeeded" : "failed";
  runStore.finishRun(runId, status, { error: result.error, actionsRun: result.actionsRun, resultSummary: result.results });
  onRunFinished(runId, auto.name, auto.id, result, status);
  return result;
}

// ── Trigger entrypoint ────────────────────────────────────────────────────────

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

      try {
        const result = await startAutomationRun(auto, type, data);
        if (result) runResults.push(result);
      } catch (err) {
        log.error(`Automation ${auto.id} run failed`, err);
      }
    }
  } catch (err) {
    log.error("fireTrigger error", err);
  }
  return runResults;
}

// ── Recovery ──────────────────────────────────────────────────────────────────

export interface ReconcileReport {
  resumed: string[];
  interrupted: string[];
  cancelled: string[];
}

/**
 * Find runs whose process stopped (lease expired) or whose approval was decided,
 * and bring each to a coherent state:
 * - interrupted between steps, or during a step that is safe to repeat → resume
 * - interrupted during a step with side effects → mark "interrupted", never repeat it
 * - waiting on an approval that was approved → resume; denied/expired → failed
 */
export async function reconcileAutomationRuns(): Promise<ReconcileReport> {
  const report: ReconcileReport = { resumed: [], interrupted: [], cancelled: [] };

  const notifyInterrupted = (run: runStore.RunRow, reason: string) => {
    const auto = db.select().from(schema.automations).where(eq(schema.automations.id, run.automationId)).get();
    const name = auto?.name ?? run.automationId;
    runStore.finishRun(run.id, "interrupted", { error: reason, actionsRun: run.actionsRun, resultSummary: completedRunResult(runStore.getStepRuns(run.id)) });
    writeNotification("warning", `Automation "${name}" was interrupted`, reason, run.automationId);
    writeAuditEntry(`Automation interrupted: ${name}`, "modify", `${run.automationId} · run ${run.id} · ${reason}`, false);
    report.interrupted.push(run.id);
  };

  for (const run of runStore.listAbandonedRuns()) {
    if (!runStore.acquireRun(run.id, ["running"])) continue; // another process got it

    if (run.workflowVersion !== 2 || !run.stepsSnapshot) {
      notifyInterrupted(run, "Talome stopped while this automation was running. Legacy automations are not resumed; check its actions and run it again if needed.");
      continue;
    }
    if (runStore.incrementResumeCount(run.id) > runStore.MAX_RESUMES) {
      notifyInterrupted(run, `Interrupted ${runStore.MAX_RESUMES} times — stopped retrying.`);
      continue;
    }

    const steps = parseJson<AutomationStep[]>(run.stepsSnapshot, []);
    const inFlight = runStore.getStepRuns(run.id).find((r) => r.status === "running");
    if (inFlight) {
      const step = steps[inFlight.stepIndex ?? -1];
      if (!step || !isRetrySafe(step)) {
        runStore.markStep(inFlight.id, "unknown", "Talome stopped during this step; it was not repeated because it may already have taken effect.");
        notifyInterrupted(
          run,
          `Talome stopped while step ${(inFlight.stepIndex ?? 0) + 1} (${inFlight.stepType}${step?.type === "tool_action" ? `: ${step.toolName}` : ""}) was running. It was not repeated because it may already have taken effect — check the result and run the automation again if needed.`,
        );
        continue;
      }
      runStore.markStep(inFlight.id, "retried", "Interrupted; safe to repeat, so it ran again.");
    }

    report.resumed.push(run.id);
    await executeDurableRun(run.id);
  }

  expireStaleApprovals();
  for (const run of runStore.listRunsWaitingForApproval()) {
    const blockedStep = runStore.getStepRuns(run.id).filter((r) => r.status === "blocked").at(-1);
    const approval = blockedStep?.approvalId
      ? db.select().from(schema.toolApprovals).where(eq(schema.toolApprovals.id, blockedStep.approvalId)).get()
      : undefined;
    const status = approval?.status;
    if (status === "pending") continue;
    if (status === "approved") {
      if (!runStore.acquireRun(run.id, ["waiting_approval"])) continue;
      // The blocked step re-runs and consumes the approval
      db.update(schema.automationStepRuns).set({ status: "retried" }).where(eq(schema.automationStepRuns.id, blockedStep!.id)).run();
      report.resumed.push(run.id);
      await executeDurableRun(run.id);
      continue;
    }
    // Denied, expired, used elsewhere, or missing
    if (!runStore.acquireRun(run.id, ["waiting_approval"])) continue;
    const error = `Approval ${status ?? "missing"} — the step did not run`;
    const results = completedRunResult(runStore.getStepRuns(run.id));
    runStore.finishRun(run.id, "failed", { error, actionsRun: run.actionsRun, resultSummary: results });
    const auto = db.select().from(schema.automations).where(eq(schema.automations.id, run.automationId)).get();
    onRunFinished(run.id, auto?.name ?? run.automationId, run.automationId, { success: false, error, actionsRun: run.actionsRun, results }, "failed");
    report.cancelled.push(run.id);
  }

  return report;
}

let recoveryTimer: ReturnType<typeof setInterval> | null = null;
let reconciling = false;

async function reconcileSafely(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const report = await reconcileAutomationRuns();
    if (report.resumed.length || report.interrupted.length || report.cancelled.length) {
      log.info(`Automation recovery: resumed ${report.resumed.length}, interrupted ${report.interrupted.length}, cancelled ${report.cancelled.length}`);
    }
  } catch (err) {
    log.error("Automation recovery failed", err);
  } finally {
    reconciling = false;
  }
}

/** Resume runs as soon as their approval is granted (called after an admin decides). */
export function resumeAfterApproval(): void {
  void reconcileSafely();
}

/**
 * Periodically recover interrupted runs and runs whose approval was decided.
 * Only runs whose lease has expired are touched, so a run left by a previous
 * process is picked up within one lease period (2 min) of it stopping.
 */
export function startAutomationRecovery(): void {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => void reconcileSafely(), 60_000);
  recoveryTimer.unref?.();
  setTimeout(() => void reconcileSafely(), 5_000).unref?.();
}
