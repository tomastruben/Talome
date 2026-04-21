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

export type SecurityMode = "permissive" | "cautious" | "locked";

const VALID_MODES = new Set<SecurityMode>(["permissive", "cautious", "locked"]);

/** Read the current security mode from settings. Defaults to "cautious". */
export function getSecurityMode(): SecurityMode {
  const raw = getSetting("security_mode");
  if (raw && VALID_MODES.has(raw as SecurityMode)) return raw as SecurityMode;
  return "cautious";
}

/**
 * Wrap a tool with security gateway checks.
 * Returns a new tool with the same schema but a guarded execute function.
 */
export function gateToolExecution(
  toolDef: Tool,
  toolName: string,
  tier: "read" | "modify" | "destructive",
  mode: SecurityMode,
): Tool {
  // Permissive mode: pass through unchanged
  if (mode === "permissive") return toolDef;

  // Read-tier tools always pass in all modes
  if (tier === "read") return toolDef;

  // Locked mode: block all modify/destructive tools
  if (mode === "locked") {
    return {
      ...toolDef,
      execute: async () => {
        writeAuditEntry(
          `BLOCKED (locked mode): ${toolName}`,
          tier,
          "Security mode is set to locked — only read operations are allowed.",
          false,
        );
        return {
          error: `This action is blocked. Security mode is set to "locked" — only read operations are allowed. An admin can change this in Settings > Security.`,
        };
      },
    } as Tool;
  }

  // Cautious mode: destructive tools require confirmed:true
  if (mode === "cautious" && tier === "destructive") {
    const original = toolDef as Tool & { execute: (args: Record<string, unknown>) => Promise<unknown> };
    return {
      ...toolDef,
      execute: async (args: Record<string, unknown>) => {
        if (!args.confirmed) {
          writeAuditEntry(
            `NEEDS CONFIRMATION: ${toolName}`,
            tier,
            JSON.stringify(args).slice(0, 500),
            false,
          );
          return {
            error: `This is a destructive action. Please confirm by calling this tool again with confirmed: true. Security mode is "cautious" — destructive operations require explicit confirmation.`,
          };
        }
        return original.execute(args);
      },
    } as Tool;
  }

  return toolDef;
}
