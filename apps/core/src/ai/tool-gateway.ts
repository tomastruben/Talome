/**
 * Tool Execution Gateway — one authorization path for every tool call.
 *
 * Chat, messaging, MCP, automations and background loops all run tools through
 * here. Policy depends on the system-wide `security_mode` setting and on who is
 * calling (see execution-actor.ts):
 *
 * - "permissive": all tools execute freely (power user)
 * - "cautious" (default): destructive tools need a human approval. In dashboard
 *   chat the person approves in the chat UI (AI SDK tool approval) before the
 *   tool runs; every other caller gets a server-issued approval request that an
 *   admin approves in Settings > Security (or by code over Telegram/Discord).
 *   A model-supplied `confirmed: true` is not treated as approval.
 * - "locked": only read-tier tools execute; modify/destructive return an error
 */

import type { Tool } from "ai";
import { getSetting } from "../utils/settings.js";
import { writeAuditEntry } from "../db/audit.js";
import { redactSecrets } from "../utils/redact.js";
import { consumeApproval, requestApproval, PENDING_TTL_MS } from "../approval/tool-approvals.js";
import { summarizeToolArgs } from "./audit-summary.js";
import { describeActor, type ExecutionActor } from "./execution-actor.js";
import type { ToolTier } from "./token-scope.js";

export type { ToolTier };
export type SecurityMode = "permissive" | "cautious" | "locked";

const VALID_MODES = new Set<SecurityMode>(["permissive", "cautious", "locked"]);

/** Read the current security mode from settings. Defaults to "cautious". */
export function getSecurityMode(): SecurityMode {
  const raw = getSetting("security_mode");
  if (raw && VALID_MODES.has(raw as SecurityMode)) return raw as SecurityMode;
  return "cautious";
}

export type PolicyOutcome = "allow" | "block" | "needs-approval";

/** What the security mode says about a tier, before considering who is calling. */
export function checkToolPolicy(tier: ToolTier, mode: SecurityMode): PolicyOutcome {
  if (mode === "permissive" || tier === "read") return "allow";
  if (mode === "locked") return "block";
  return tier === "destructive" ? "needs-approval" : "allow";
}

export type AuthorizationDecision =
  | { allowed: true; approvalId?: string }
  | { allowed: false; auditAction: string; reason: string; approvalId?: string };

function approvalInstructions(actor: ExecutionActor, code: string): string {
  const minutes = Math.round(PENDING_TTL_MS / 60_000);
  if (actor.kind === "messaging") {
    return `Tell the user to reply "approve ${code}" (or "deny ${code}") within ${minutes} minutes, then call this tool again with the same arguments.`;
  }
  return `An admin must approve request ${code} in Talome under Settings > Security within ${minutes} minutes. After that, call this tool again with exactly the same arguments.`;
}

/**
 * Decide whether one call may run now. May create a pending approval request
 * (non-interactive callers) or consume an approved one.
 */
export function authorizeToolCall(
  toolName: string,
  tier: ToolTier,
  args: Record<string, unknown>,
  actor: ExecutionActor,
  mode: SecurityMode = getSecurityMode(),
): AuthorizationDecision {
  const outcome = checkToolPolicy(tier, mode);
  if (outcome === "allow") return { allowed: true };

  if (outcome === "block") {
    return {
      allowed: false,
      auditAction: `BLOCKED (locked mode): ${toolName}`,
      reason: `This action is blocked. Security mode is set to "locked" — only read operations are allowed. An admin can change this in Settings > Security.`,
    };
  }

  // Dashboard chat: the AI SDK only calls execute after the person approved the
  // call in the chat UI (see gateToolExecution's needsApproval).
  if (actor.kind === "dashboard") return { allowed: true };

  const consumed = consumeApproval(actor, toolName, args);
  if (consumed) return { allowed: true, approvalId: consumed };

  const request = requestApproval(actor, toolName, tier, args);
  return {
    allowed: false,
    approvalId: request.id,
    auditAction: `NEEDS APPROVAL: ${toolName}`,
    reason: `This is a destructive action and needs human approval (request ${request.code}). ${approvalInstructions(actor, request.code)}`,
  };
}

/**
 * Some destructive tools also check their own `confirmed` argument. Once a person
 * approved the call (in chat or through a server-issued approval), that is the
 * confirmation — pass it through so the tool doesn't refuse and waste the approval.
 */
export function withConfirmation(args: Record<string, unknown>, approvedByPerson: boolean): Record<string, unknown> {
  return approvedByPerson ? { ...args, confirmed: true } : args;
}

function auditDetails(actor: ExecutionActor, toolName: string, args: Record<string, unknown>, extra?: string): string {
  const summary = summarizeToolArgs(toolName, redactSecrets(args) as Record<string, unknown>);
  return [describeActor(actor), extra, summary].filter(Boolean).join(" · ");
}

/**
 * Wrap a tool so every call is authorized for `actor` and non-read calls are audited.
 * In dashboard chat, destructive tools in cautious mode are marked `needsApproval`
 * so the chat UI asks the person before the tool runs.
 */
export function gateToolExecution(
  toolDef: Tool,
  toolName: string,
  tier: ToolTier,
  actor: ExecutionActor,
  mode: SecurityMode = getSecurityMode(),
): Tool {
  if (tier === "read") return toolDef;

  const original = toolDef as Tool & { execute?: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> };
  if (!original.execute) return toolDef;
  const execute = original.execute;

  const needsChatApproval = actor.kind === "dashboard" && checkToolPolicy(tier, mode) === "needs-approval";

  return {
    ...toolDef,
    ...(needsChatApproval ? { needsApproval: true } : {}),
    execute: async (args: Record<string, unknown>, ctx?: unknown) => {
      const decision = authorizeToolCall(toolName, tier, args, actor);
      if (!decision.allowed) {
        writeAuditEntry(decision.auditAction, tier, auditDetails(actor, toolName, args), false);
        return { error: decision.reason };
      }
      const approvalNote = decision.approvalId
        ? `approved (request ${decision.approvalId})`
        : needsChatApproval ? "approved in chat" : undefined;
      writeAuditEntry(`AI: ${toolName}`, tier, auditDetails(actor, toolName, args, approvalNote));
      return execute(withConfirmation(args, decision.approvalId !== undefined || needsChatApproval), ctx);
    },
  } as Tool;
}

/** Gate a whole tool set for one caller. `getTier` supplies each tool's tier. */
export function gateTools(
  tools: Record<string, Tool>,
  actor: ExecutionActor,
  getTier: (toolName: string) => ToolTier,
  mode: SecurityMode = getSecurityMode(),
): Record<string, Tool> {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => [name, gateToolExecution(t, name, getTier(name), actor, mode)]),
  );
}
