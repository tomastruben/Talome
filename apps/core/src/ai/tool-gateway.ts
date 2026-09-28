/**
 * Tool Execution Gateway — adapts AI SDK tools to the execution service.
 *
 * Every tool handed to the chat model is wrapped so its execute() goes through
 * `executeTool()` (ai/execution.ts), which applies the system-wide
 * `security_mode`, server-issued approvals, and audit:
 *
 * - "permissive": all tools execute freely (power user)
 * - "cautious": destructive tools require a server-issued approval (default).
 *   The model can no longer approve itself with `confirmed: true`; it receives
 *   an `approval_required` result and retries with `approval_id` once the
 *   owner approved in Settings -> Approvals.
 * - "locked": only read-tier tools execute; modify/destructive return error
 */

import type { Tool } from "ai";
import {
  acceptsApprovalArg,
  currentExecutionContext,
  approvalIdArgSchema,
  executeTool,
  getSecurityMode,
  type Actor,
  type ExecuteToolResult,
  type ExecutionSource,
  type SecurityMode,
} from "./execution.js";

export { getSecurityMode, type SecurityMode };

type ToolTier = "read" | "modify" | "destructive";

/**
 * Add the reserved `approval_id` argument to a Zod object input schema so it
 * survives validation. Non-Zod schemas are returned unchanged.
 */
export function withApprovalArg(inputSchema: unknown): unknown {
  const schema = inputSchema as { extend?: (shape: Record<string, unknown>) => unknown; _zod?: unknown } | undefined;
  if (!schema || typeof schema.extend !== "function" || !("_zod" in schema)) return inputSchema;
  try {
    return schema.extend({ approval_id: approvalIdArgSchema });
  } catch {
    return inputSchema;
  }
}

/**
 * Map an execution result back to what the chat model and UI already expect:
 * the raw tool output, `{ error }` for blocks, a structured approval request,
 * and a rethrow when the tool itself threw (AI SDK turns it into a tool error).
 */
export function toChatToolResult(r: ExecuteToolResult): unknown {
  switch (r.outcome) {
    case "success":
      return r.result;
    case "error":
      if (r.thrown !== undefined) throw r.thrown;
      return r.result ?? { error: r.error?.message ?? "Tool failed" };
    case "approval_required":
      return { ...r.approval, error: r.approval?.instructions };
    case "blocked":
    default:
      return { error: r.error?.hint ? `${r.error.message} ${r.error.hint}` : (r.error?.message ?? "Blocked") };
  }
}

/**
 * Wrap a tool so every call runs through the execution service.
 * Returns a new tool with the same schema (plus `approval_id` where an
 * approval may be required) and a guarded execute function.
 *
 * `actor`/`source` default to the execution context active when the tool is
 * wrapped (withExecutionContext — the chat route sets the session user,
 * runAutomationPrompt the automation), else dashboard chat.
 */
export function gateToolExecution(
  toolDef: Tool,
  toolName: string,
  tier: ToolTier,
  mode: SecurityMode,
  actor: Actor = currentExecutionContext().actor,
  source: ExecutionSource = currentExecutionContext().source,
): Tool {
  const original = (toolDef as { execute?: unknown }).execute;
  if (typeof original !== "function") return toolDef;

  const inputSchema = acceptsApprovalArg(toolName, tier)
    ? withApprovalArg((toolDef as { inputSchema?: unknown }).inputSchema)
    : (toolDef as { inputSchema?: unknown }).inputSchema;

  return {
    ...toolDef,
    inputSchema,
    execute: async (args: unknown, options: unknown) => {
      const result = await executeTool({
        actor,
        source,
        toolName,
        args,
        tool: toolDef,
        baseTier: tier,
        mode,
        toolCallOptions: options,
      });
      return toChatToolResult(result);
    },
  } as Tool;
}
