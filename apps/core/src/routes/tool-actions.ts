/**
 * POST /api/chat/actions — buttons on the Assistant's tool cards (Restart,
 * Stop, Start, Request, Download, Undo) run the same tool the model would
 * call, through executeTool(): the security mode, server-issued approvals and
 * an actor-aware audit entry all apply, exactly as for a chat tool call. The
 * cards never call feature REST routes directly any more.
 *
 * Only a short allow-list of card actions is accepted, each with the feature
 * permission a member needs for it (admins need none).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { asSchema, type Tool } from "ai";
import type { FeaturePermission } from "@talome/types";
import { executeTool, sessionChatActor, withExecutionContext, type ExecuteToolResult } from "../ai/execution.js";
import { getActiveRegisteredTools } from "../ai/tool-registry.js";
import type { ToolTier } from "../approval/grants.js";
import { requireAnyPermission } from "../middleware/require-permission.js";
import { getSetting } from "../utils/settings.js";

interface CardAction {
  tier: ToolTier;
  /** Feature permission a member needs; "admin" means admins only. */
  permission: FeaturePermission | "admin";
  /** Human label for errors: "restart the container". */
  label: string;
}

export const CARD_ACTIONS: Record<string, CardAction> = {
  start_container: { tier: "modify", permission: "apps", label: "start the container" },
  stop_container: { tier: "modify", permission: "apps", label: "stop the container" },
  restart_container: { tier: "modify", permission: "apps", label: "restart the container" },
  request_media: { tier: "modify", permission: "media", label: "request this title" },
  audiobook_download: { tier: "modify", permission: "audiobooks", label: "send this download" },
  revert_setting: { tier: "modify", permission: "admin", label: "undo the setting change" },
};

const bodySchema = z.object({
  tool: z.string().refine((name) => Object.hasOwn(CARD_ACTIONS, name), "Unknown card action"),
  args: z.record(z.string(), z.unknown()).default({}),
  approvalId: z.string().min(1).max(200).optional(),
});

function disabledTools(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(getSetting("disabled_tools") ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

async function permitted(c: Context, permission: CardAction["permission"]): Promise<Response | null> {
  const role = c.get("sessionRole" as never) as string | undefined;
  if (permission === "admin") {
    return role === "admin" ? null : c.json({ error: "Only an admin can do this." }, 403);
  }
  let allowed = false;
  const response = await requireAnyPermission(permission)(c, async () => {
    allowed = true;
  });
  return allowed ? null : (response ?? c.json({ error: "You don't have access to this feature." }, 403));
}

/**
 * Card args come from the browser, not from a model call the AI SDK already
 * validated: parse them with the tool's own input schema (types, defaults,
 * unknown keys dropped) before anything runs.
 */
export async function parseToolArgs(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<{ ok: true; args: Record<string, unknown> } | { ok: false; message: string }> {
  const schema = (tool as { inputSchema?: unknown }).inputSchema;
  if (!schema) return { ok: true, args };
  const zodLike = schema as { safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: { issues?: Array<{ path?: PropertyKey[]; message?: string }> } } };
  if (typeof zodLike.safeParse === "function") {
    const parsed = zodLike.safeParse(args);
    if (parsed.success) return { ok: true, args: (parsed.data ?? {}) as Record<string, unknown> };
    const issue = parsed.error?.issues?.[0];
    const field = issue?.path?.length ? issue.path.map(String).join(".") : "";
    return { ok: false, message: field ? `${field}: ${issue?.message ?? "invalid value"}` : (issue?.message ?? "invalid value") };
  }
  const validate = asSchema(schema as Parameters<typeof asSchema>[0]).validate;
  if (!validate) return { ok: true, args };
  const result = await validate(args);
  return result.success
    ? { ok: true, args: result.value as Record<string, unknown> }
    : { ok: false, message: result.error.message };
}

/** What the card needs: the outcome, the tool's result, or why it didn't run. */
function toResponse(result: ExecuteToolResult) {
  return {
    outcome: result.outcome,
    tier: result.tier,
    ...(result.result !== undefined ? { result: result.result } : {}),
    ...(result.error ? { error: { code: result.error.code, message: result.error.message, hint: result.error.hint } } : {}),
    ...(result.approval ? { approval: result.approval } : {}),
  };
}

const toolActions = new Hono();

toolActions.post("/", async (c) => {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "This card action isn't supported." }, 400);
  const { tool: toolName, args, approvalId } = parsed.data;
  const action = CARD_ACTIONS[toolName];

  const denied = await permitted(c, action.permission);
  if (denied) return denied;

  const tool = getActiveRegisteredTools()[toolName];
  if (!tool || disabledTools().has(toolName)) {
    return c.json({ error: `Talome can't ${action.label} right now: the tool is turned off or its app isn't set up.` }, 404);
  }

  const checked = await parseToolArgs(tool, args);
  if (!checked.ok) {
    return c.json({ error: `Talome can't ${action.label}: the card sent an invalid value (${checked.message}).` }, 400);
  }

  // The session user acts, exactly as in chat: same audit actor, approvals and mode.
  const actor = sessionChatActor(c.get("sessionUser" as never), c.get("sessionUsername" as never), c.get("sessionRole" as never));
  const result = await withExecutionContext(actor, "chat", () =>
    executeTool({
      actor,
      source: "chat",
      toolName,
      args: approvalId ? { ...checked.args, approval_id: approvalId } : checked.args,
      tool,
      baseTier: action.tier,
      // Pressing the card again after the owner approved this user's exact
      // request runs it: the approval is bound to this actor, tool and args.
      autoConsumeApproved: true,
    }),
  );
  return c.json(toResponse(result));
});

export { toolActions };
