/**
 * Tool Execution Gateway — enforces security mode on tool calls.
 *
 * Wraps each tool's execute function with security checks based on the
 * system-wide `security_mode` setting:
 *
 * - "permissive": all tools execute freely (power user)
 * - "cautious": destructive tools require `confirmed: true` in params (default)
 * - "locked": only read-tier tools execute; modify/destructive return error
 */

import type { Tool } from "ai";
import { getSetting } from "../utils/settings.js";
import { writeAuditEntry } from "../db/audit.js";
import { redactSecrets } from "../utils/redact.js";

export type SecurityMode = "permissive" | "cautious" | "locked";

const VALID_MODES = new Set<SecurityMode>(["permissive", "cautious", "locked"]);

/** Read the current security mode from settings. Defaults to "cautious". */
export function getSecurityMode(): SecurityMode {
  const raw = getSetting("security_mode");
  if (raw && VALID_MODES.has(raw as SecurityMode)) return raw as SecurityMode;
  return "cautious";
}

export type ToolTier = "read" | "modify" | "destructive";

export type ToolPolicyDecision =
  | { allowed: true }
  | { allowed: false; auditAction: string; reason: string };

/**
 * Decide whether a tool call may run under the given security mode.
 * Shared by every execution path (chat, MCP) so they enforce the same policy.
 */
export function checkToolPolicy(
  toolName: string,
  tier: ToolTier,
  mode: SecurityMode,
  args: Record<string, unknown>,
): ToolPolicyDecision {
  if (mode === "permissive" || tier === "read") return { allowed: true };

  if (mode === "locked") {
    return {
      allowed: false,
      auditAction: `BLOCKED (locked mode): ${toolName}`,
      reason: `This action is blocked. Security mode is set to "locked" — only read operations are allowed. An admin can change this in Settings > Security.`,
    };
  }

  if (mode === "cautious" && tier === "destructive" && !args.confirmed) {
    return {
      allowed: false,
      auditAction: `NEEDS CONFIRMATION: ${toolName}`,
      reason: `This is a destructive action. Please confirm by calling this tool again with confirmed: true. Security mode is "cautious" — destructive operations require explicit confirmation.`,
    };
  }

  return { allowed: true };
}

/**
 * Wrap a tool with security gateway checks.
 * Returns a new tool with the same schema but a guarded execute function.
 */
export function gateToolExecution(
  toolDef: Tool,
  toolName: string,
  tier: ToolTier,
  mode: SecurityMode,
): Tool {
  // Permissive mode and read-tier tools pass through unchanged
  if (mode === "permissive" || tier === "read") return toolDef;

  const original = toolDef as Tool & { execute?: (args: Record<string, unknown>, ctx?: unknown) => Promise<unknown> };
  if (!original.execute) return toolDef;
  const execute = original.execute;

  return {
    ...toolDef,
    execute: async (args: Record<string, unknown>, ctx?: unknown) => {
      const decision = checkToolPolicy(toolName, tier, mode, args);
      if (!decision.allowed) {
        const details = mode === "locked"
          ? "Security mode is set to locked — only read operations are allowed."
          : JSON.stringify(redactSecrets(args)).slice(0, 500);
        writeAuditEntry(decision.auditAction, tier, details, false);
        return { error: decision.reason };
      }
      return execute(args, ctx);
    },
  } as Tool;
}
