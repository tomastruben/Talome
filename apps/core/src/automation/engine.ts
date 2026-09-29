import { randomUUID } from "node:crypto";
import type { Tool } from "ai";
import { db, schema } from "../db/index.js";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { writeAuditEntry } from "../db/audit.js";
import { writeNotification } from "../db/notifications.js";
import { requiresApproval } from "../approval/engine.js";
import { getApproval } from "../approval/approvals.js";
import { parseTokenScopes, type TokenScopes } from "../approval/grants.js";
import { runAutomationPrompt } from "../ai/agent.js";
import { getAutomationSafeToolNames } from "../ai/automation-safe-tools.js";
import { getAllRegisteredTools } from "../ai/tool-registry.js";
import {
  automationActor,
  executeTool,
  withExecutionContext,
  type Actor,
  type ApprovalRequired,
  type ExecuteToolResult,
} from "../ai/execution.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("automation-engine");

// ── Execution path ────────────────────────────────────────────────────────────
//
// Every tool an automation runs — tool_action steps, v1 restart_container /
// run_shell actions, and the tools an ai_prompt step's model calls — goes
// through executeTool() as actor { kind: "automation", id, label }, source
// "automation": the security mode, server-issued approvals and the audit log
// apply exactly as for chat and MCP.
//
// Approvals in an unattended run: a call that needs the owner's approval (a
// step with approvalPolicy "require_approval", or a destructive tool in
// cautious mode) does not wait. The step ends "blocked_approval", the run ends
// "blocked_approval", and the execution service notifies the owner with a link
// to the approval (/dashboard/settings/approvals?id=…). Once the owner
// approves, the next run of the automation with the same step arguments —
// typically "Run now", or the next scheduled run — consumes that approval
// (single-use; automation approvals stay open, and once approved usable, for
// 24 hours) and the step executes. ai_prompt steps with "require_approval" are
// gated as the pseudo-tool "automation_ai_prompt"; when such a step last
// stopped at a tool call its model made and the owner approved that call, the
// re-run resumes without asking for the prompt approval again.
//
// Grants: an automation written by an MCP token runs under that token's grants,
// checked on every step and every tool its model calls. The token is re-read
// on every run (automations.actor_token_id): revoked or expired → the run is
// blocked and the automation disabled; narrowed → the current grants apply.
// Rows with only a stored snapshot (automations.actor_scopes) use it.
// Owner-written automations are owner-level.

/** Approval-gated pseudo-tool name for ai_prompt / ask_ai steps. */
export const AUTOMATION_AI_PROMPT_TOOL = "automation_ai_prompt";

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
  /** Set when the step is blocked waiting for the owner's approval. */
  approvalRequired?: StepApprovalRef;
  durationMs: number;
}

export interface StepApprovalRef {
  approvalId: string;
  approvalStatus: "pending" | "approved";
  approveUrl: string;
  expiresAt: string;
}

interface RunResult {
  success: boolean;
  error: string | null;
  actionsRun: number;
  results: StepRunResult[];
  /** The run stopped at a step waiting for the owner's approval. */
  approvalRequired?: StepApprovalRef;
}

interface ExecutionContext {
  automationId: string;
  automationName: string;
  /** Grants the automation runs under (MCP-token-written); undefined = owner-level. */
  actorScopes?: TokenScopes;
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

// ── executeTool adapters ──────────────────────────────────────────────────────

type AutomationRef = { automationId: string; automationName: string; actorScopes?: TokenScopes };

function actorFor(ctx: AutomationRef): Actor {
  return automationActor(ctx.automationId, ctx.automationName, ctx.actorScopes);
}

/** Stored actor_scopes → grants. Malformed JSON falls back to read-only (never widens). */
export function parseAutomationScopes(raw: string | null | undefined): TokenScopes | undefined {
  return raw ? parseTokenScopes(raw) : undefined;
}

export type AutomationGrant =
  | { ok: true; scopes?: TokenScopes }
  | { ok: false; reason: string };

/**
 * The grants an automation runs under right now. An automation written by an
 * MCP token (actor_token_id) follows that token's CURRENT state: revoked,
 * expired or deleted → it must not run; otherwise the token's current grants
 * apply (narrowing the token narrows the automation). Automations without a
 * recorded token use the stored snapshot (actor_scopes); owner-written ones
 * are owner-level.
 */
export function resolveAutomationGrant(
  auto: { actorScopes: string | null; actorTokenId?: string | null },
  now: number = Date.now(),
): AutomationGrant {
  if (!auto.actorTokenId) return { ok: true, scopes: parseAutomationScopes(auto.actorScopes) };
  let token: typeof schema.mcpTokens.$inferSelect | undefined;
  try {
    token = db.select().from(schema.mcpTokens).where(eq(schema.mcpTokens.id, auto.actorTokenId)).get();
  } catch {
    return { ok: false, reason: "the MCP token that wrote it could not be verified" };
  }
  if (!token) return { ok: false, reason: "the MCP token that wrote it no longer exists" };
  if (token.revokedAt) return { ok: false, reason: `the MCP token "${token.name}" that wrote it was revoked` };
  if (token.expiresAt) {
    const expires = Date.parse(token.expiresAt);
    if (!Number.isFinite(expires) || expires <= now) {
      return { ok: false, reason: `the MCP token "${token.name}" that wrote it has expired` };
    }
  }
  return { ok: true, scopes: parseTokenScopes(token.scopes) };
}

/**
 * The automation's writer token is gone: disable it (so it stops firing) and
 * tell the owner once. It stays in the list for the owner to review, re-create
 * or delete.
 */
function disableForRevokedWriter(auto: typeof schema.automations.$inferSelect, reason: string): void {
  try {
    db.update(schema.automations).set({ enabled: false }).where(eq(schema.automations.id, auto.id)).run();
  } catch (err) {
    log.error(`Failed to disable automation ${auto.id}`, err);
  }
  writeAuditEntry(`Automation disabled: ${auto.name}`, "modify", `Did not run: ${reason}.`, false);
  writeNotification(
    "warning",
    `Automation "${auto.name}" disabled`,
    `It did not run because ${reason}. Automations an MCP token writes run with that token's access, so they stop when the token is revoked or expires. Review it in Automations: re-create it yourself to keep it, or delete it.`,
    auto.id,
  );
}

function approvalRef(approval: ApprovalRequired): StepApprovalRef {
  return {
    approvalId: approval.approvalId,
    approvalStatus: approval.approvalStatus,
    approveUrl: approval.approveUrl,
    expiresAt: approval.expiresAt,
  };
}

function approvalMessage(approval: ApprovalRequired): string {
  return `Waiting for the owner's approval: ${approval.summary} Approve it at ${approval.approveUrl}, then run the automation again.`;
}

function formatOutput(result: unknown): string {
  if (typeof result === "string") return result.slice(0, 4000);
  try {
    return (JSON.stringify(result, null, 2) ?? "").slice(0, 4000);
  } catch {
    return String(result).slice(0, 4000);
  }
}

interface StepOutcome {
  success: boolean;
  output?: string;
  error?: string;
  blocked?: boolean;
  approvalRequired?: StepApprovalRef;
}

/** Map an execution result to a step outcome (never throws). */
function outcomeFromExecution(r: ExecuteToolResult, successOutput?: (result: unknown) => string): StepOutcome {
  switch (r.outcome) {
    case "success":
      return { success: true, output: successOutput ? successOutput(r.result) : formatOutput(r.result) };
    case "approval_required":
      return r.approval
        ? { success: false, blocked: true, error: approvalMessage(r.approval), approvalRequired: approvalRef(r.approval) }
        : { success: false, blocked: true, error: "Waiting for the owner's approval." };
    case "blocked":
      return { success: false, blocked: true, error: r.error?.hint ? `${r.error.message} ${r.error.hint}` : (r.error?.message ?? "Blocked") };
    case "error":
    default:
      return {
        success: false,
        output: r.result !== undefined ? formatOutput(r.result) : undefined,
        error: r.error?.message ?? "Tool failed",
      };
  }
}

function automationAuditExtras(ctx: AutomationRef) {
  const actor = actorFor(ctx);
  return { actorKind: actor.kind, actorId: actor.id, actorLabel: actor.label, source: "automation" };
}

/** Run a registered tool as the automation. */
async function runToolAsAutomation(
  ctx: AutomationRef,
  toolName: string,
  args: Record<string, unknown>,
  requireApproval: boolean,
): Promise<StepOutcome> {
  const tool = getAllRegisteredTools()[toolName] as Tool | undefined;
  if (!tool || typeof (tool as { execute?: unknown }).execute !== "function") {
    return { success: false, error: `Tool "${toolName}" not found or has no execute function` };
  }
  const r = await executeTool({ actor: actorFor(ctx), source: "automation", toolName, args, tool, requireApproval });
  return outcomeFromExecution(r);
}

/**
 * Run an AI prompt as the automation. With `requireApproval` the prompt itself
 * is approval-gated (pseudo-tool automation_ai_prompt, keyed on the step and
 * its template so a re-run can consume the approval); the tools its model
 * calls are always gated individually by executeTool.
 */
/**
 * True when this step's last run stopped at a tool call its model made and the
 * owner has since approved exactly that call: the re-run resumes it without
 * asking for the (single-use) prompt approval again, so approving the inner
 * call is enough. The model is re-run, so it must make the same call to
 * consume the approval — best effort for model-chosen arguments.
 */
function resumesApprovedInnerCall(automationId: string, stepId: string): boolean {
  try {
    const last = db
      .select({ status: schema.automationRuns.status, resultSummary: schema.automationRuns.resultSummary })
      .from(schema.automationRuns)
      .where(and(eq(schema.automationRuns.automationId, automationId), isNotNull(schema.automationRuns.finishedAt)))
      .orderBy(desc(schema.automationRuns.triggeredAt))
      .limit(1)
      .get();
    if (last?.status !== "blocked_approval" || !last.resultSummary) return false;
    const results = JSON.parse(last.resultSummary) as Array<{ stepId?: unknown; approvalRequired?: { approvalId?: unknown } }>;
    const blocked = Array.isArray(results) ? results.find((r) => r?.stepId === stepId) : undefined;
    const approvalId = blocked?.approvalRequired?.approvalId;
    if (typeof approvalId !== "string") return false;
    const approval = getApproval(approvalId);
    return (
      approval?.status === "approved" &&
      approval.tool !== AUTOMATION_AI_PROMPT_TOOL &&
      approval.actorKind === "automation" &&
      approval.actorId === automationId
    );
  } catch {
    return false;
  }
}

async function runPromptAsAutomation(
  ctx: AutomationRef & { triggerType: string },
  opts: { stepId: string; template: string; prompt: string; allowedTools: string[]; requireApproval: boolean },
): Promise<StepOutcome & { text?: string }> {
  let innerApproval: ApprovalRequired | undefined;
  const run = () =>
    runAutomationPrompt({
      prompt: opts.prompt,
      automationName: ctx.automationName,
      automationId: ctx.automationId,
      triggerType: ctx.triggerType,
      allowedTools: opts.allowedTools,
      // The model's tool calls are checked against the automation's grants.
      actor: actorFor(ctx),
      onApprovalRequired: (approval) => {
        innerApproval ??= approval;
      },
    });

  let text: string;
  if (opts.requireApproval && !resumesApprovedInnerCall(ctx.automationId, opts.stepId)) {
    const pseudoTool = { execute: async () => ({ text: await run() }) } as unknown as Tool;
    const r = await executeTool({
      // The prompt gate is an approval, not a tool: grants apply to the
      // tools the model calls, not to this pseudo-tool.
      actor: automationActor(ctx.automationId, ctx.automationName),
      source: "automation",
      toolName: AUTOMATION_AI_PROMPT_TOOL,
      args: { id: opts.stepId, promptTemplate: opts.template },
      tool: pseudoTool,
      baseTier: "read",
      requireApproval: true,
    });
    if (r.outcome !== "success") return outcomeFromExecution(r);
    const result = r.result as { text?: unknown } | undefined;
    text = typeof result?.text === "string" ? result.text : "";
  } else {
    text = await run();
  }

  if (innerApproval) {
    // The model stopped at a tool that needs approval: the step is not done.
    return {
      success: false,
      blocked: true,
      output: text.slice(0, 4000),
      error: approvalMessage(innerApproval),
      approvalRequired: approvalRef(innerApproval),
      text,
    };
  }
  return { success: true, output: text.slice(0, 4000), text };
}

// ── v1 legacy action runners ───────────────────────────────────────────────────

function actionToToolName(actionType: AutomationAction["type"]): string {
  switch (actionType) {
    case "restart_container": return "restart_container";
    case "send_notification": return "remember";
    case "run_shell": return "run_shell";
    case "ask_ai": return "launch_claude_code";
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
    approvalRequired?: StepApprovalRef,
  ): StepRunResult => ({
    stepId: step.id,
    stepType: step.type,
    success,
    output,
    error,
    blocked,
    ...(approvalRequired ? { approvalRequired } : {}),
    durationMs: Date.now() - startedAt,
  });
  const fromOutcome = (o: StepOutcome): StepRunResult =>
    makeResult(o.success, o.output, o.error, o.blocked, o.approvalRequired);

  try {
    switch (step.type) {
      case "notify": {
        const title = interpolate(step.title, ctx);
        const body = interpolate(step.body ?? "", ctx);
        writeNotification(step.level, title, body);
        return makeResult(true, `Sent ${step.level}: "${title}"`);
      }

      case "tool_action": {
        // Validate tool is in the automation-safe list
        const safeTools = getAutomationSafeToolNames();
        if (!safeTools.has(step.toolName)) {
          return makeResult(false, undefined, `Tool "${step.toolName}" is not allowed in automations`);
        }

        // executeTool applies the security mode, approvals and audit. A step
        // with approvalPolicy "require_approval" (the default) always needs a
        // server-issued approval for this exact call.
        const policy = step.approvalPolicy ?? "require_approval";
        return fromOutcome(await runToolAsAutomation(ctx, step.toolName, step.args ?? {}, policy === "require_approval"));
      }

      case "ai_prompt": {
        const policy = step.approvalPolicy ?? "auto";
        const interpolatedPrompt = interpolate(step.promptTemplate, ctx);
        const safeToolNames = getAutomationSafeToolNames();
        const allowed = step.allowedTools.filter((t) => safeToolNames.has(t));

        const outcome = await runPromptAsAutomation(ctx, {
          stepId: step.id,
          template: step.promptTemplate,
          prompt: interpolatedPrompt,
          allowedTools: allowed,
          requireApproval: policy === "require_approval",
        });
        if (!outcome.success || outcome.text === undefined) return fromOutcome(outcome);
        const aiText = outcome.text;

        writeAuditEntry(`Automation step: ai_prompt`, "read", ctx.automationId, true, automationAuditExtras(ctx));
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
  context: { automationId: string; automationName: string; actorScopes?: TokenScopes; triggerType: string; triggerData?: Record<string, unknown> },
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
      return {
        success: false,
        error: result.error ?? "Step blocked",
        actionsRun,
        results,
        ...(result.approvalRequired ? { approvalRequired: result.approvalRequired } : {}),
      };
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
  context: { automationId: string; automationName: string; actorScopes?: TokenScopes; triggerType: string },
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

    // Actions without the per-action `approved` flag need a server-issued
    // approval for this exact call (blocked_approval until the owner approves).
    const requireApproval = requiresExplicitAutomationApproval(action);

    const start = Date.now();
    let outcome: StepOutcome;
    try {
      switch (action.type) {
        case "restart_container":
          outcome = await runToolAsAutomation(context, "restart_container", { containerId: action.containerId }, requireApproval);
          if (outcome.success) outcome = { ...outcome, output: `Restarted container ${action.containerId}` };
          break;

        case "send_notification":
          writeNotification(action.level, action.title, action.body ?? "");
          outcome = { success: true, output: `Sent ${action.level} notification "${action.title}"` };
          break;

        case "run_shell":
          outcome = await runToolAsAutomation(context, "run_shell", { command: action.command }, requireApproval);
          if (outcome.success) log.info(`run_shell output: ${outcome.output ?? "(empty)"}`);
          break;

        case "ask_ai": {
          const ai = await runPromptAsAutomation(context, {
            stepId,
            template: action.prompt,
            prompt: action.prompt,
            allowedTools: [],
            requireApproval,
          });
          outcome = ai;
          if (ai.success && ai.text !== undefined) {
            writeAuditEntry(`Automation: ask_ai`, "read", action.prompt, true, automationAuditExtras(context));
            writeNotification(
              "info",
              `Automation "${context.automationName}" AI analysis`,
              ai.text.slice(0, 1200),
              context.automationId,
            );
          }
          break;
        }
      }
    } catch (err) {
      log.error(`Action ${action.type} failed`, err);
      outcome = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    record(index, {
      stepId,
      stepType: action.type,
      success: outcome.success,
      output: outcome.output,
      error: outcome.error,
      blocked: outcome.blocked,
      ...(outcome.approvalRequired ? { approvalRequired: outcome.approvalRequired } : {}),
      durationMs: Date.now() - start,
    });

    if (!outcome.success) {
      // Blocks are audited (with actor and outcome) by executeTool.
      const error = outcome.error ?? `Action ${action.type} failed`;
      return {
        success: false,
        error,
        actionsRun,
        results,
        ...(outcome.approvalRequired ? { approvalRequired: outcome.approvalRequired } : {}),
      };
    }
    actionsRun++;
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
  if (result.blocked) return result.approvalRequired ? "blocked_approval" : "blocked";
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
    .where(eq(schema.automationStepRuns.status, "running"))
    .run();
  // Steps that never started were not interrupted — they were skipped.
  db.update(schema.automationStepRuns)
    .set({ status: "skipped", finishedAt: at })
    .where(eq(schema.automationStepRuns.status, "pending"))
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

      // Grants are resolved per run: a revoked or expired writer token stops
      // the automation before any step runs.
      const grant = resolveAutomationGrant(auto);
      if (!grant.ok) {
        const error = `Blocked: ${grant.reason}. The automation was disabled.`;
        try {
          db.insert(schema.automationRuns).values({
            id: runId,
            automationId: auto.id,
            triggeredAt,
            success: false,
            error,
            actionsRun: 0,
            status: "failed",
            finishedAt: new Date().toISOString(),
          }).run();
        } catch (err) {
          log.error(`Failed to write run record for ${auto.id}`, err);
        }
        disableForRevokedWriter(auto, grant.reason);
        runResults.push({ success: false, error, actionsRun: 0, results: [] });
        continue;
      }

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
        // Dispatch to v2 step runner or v1 legacy runner. The whole run —
        // every tool call and any app operation it starts — acts as the
        // automation (audit, approvals, app_operations.actor).
        const actorScopes = grant.scopes;
        result = await withExecutionContext(automationActor(auto.id, auto.name, actorScopes), "automation", () =>
          workflow.kind === "steps"
            ? runSteps(workflow.steps, {
              automationId: auto.id,
              automationName: auto.name,
              actorScopes,
              triggerType: type,
              triggerData: data,
            }, journal)
            : runActions(workflow.actions, {
              automationId: auto.id,
              automationName: auto.name,
              actorScopes,
              triggerType: type,
            }, journal));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        result = { success: false, error, actionsRun: 0, results: [] };
      }
      journal.finalize();

      // A run blocked on an approval is not a failure to report again: the
      // execution service already notified the owner with a link to the
      // approval (once per approval request).
      if (!result.success && result.error && !result.approvalRequired) {
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
            status: result.success ? "succeeded" : result.approvalRequired ? "blocked_approval" : "failed",
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
