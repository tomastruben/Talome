/**
 * Tool execution service — the single choke point for every agent tool call.
 *
 * Dashboard chat (via gateToolExecution), MCP over HTTP and stdio, and — once
 * adopted — automations and the agent loop all call `executeTool()`. It
 * applies, in order:
 *
 *   1. Per-actor grants (MCP tokens: tier, domains, tool allow/deny, apps)
 *   2. The system security mode (permissive / cautious / locked)
 *   3. Server-issued approvals for destructive calls in cautious mode
 *   4. Execution with error normalization ({error} / {success:false} → error)
 *   5. An actor-aware, redacted audit entry
 *
 * Adopting it from another caller (automation engine, agent loop):
 *
 *   const r = await executeTool({
 *     actor: { kind: "automation", id: automation.id, label: automation.name },
 *     source: "automation",
 *     toolName: "restart_app",
 *     args: { appId: "sonarr" },
 *   });
 *   if (r.outcome === "success") use(r.result);
 *   else if (r.outcome === "approval_required") notifyOwner(r.approval);
 *   else handle(r.error);          // "error" | "blocked"
 *
 * executeTool never throws. Actors without `scopes` are owner-level (no
 * per-actor grants), but the security mode and approvals still apply.
 */

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Tool } from "ai";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { getAllDomains, getAllRegisteredTools } from "./tool-registry.js";
import { getCustomTools } from "./custom-tools.js";
import { getSetting } from "../utils/settings.js";
import { writeAuditEntry, type AuditOutcome } from "../db/audit.js";
import { writeNotification } from "../db/notifications.js";
import { checkCallGrant, TIER_RANK, type TokenScopes, type ToolTier } from "../approval/grants.js";
import { APPROVAL_ARG, consumeApproval, hashArgs, requestApproval, type ConsumeFailure } from "../approval/approvals.js";
import { invalidateSecretValueCache, redactedPreview, redactText } from "../approval/redact.js";
import { isApprovalExemptShellCommand } from "../approval/shell-safety.js";
import { isSecretSettingKey } from "../utils/crypto.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type SecurityMode = "permissive" | "cautious" | "locked";

export type ActorKind = "user" | "mcp_token" | "mcp_stdio" | "automation" | "agent_loop";

export type ExecutionSource = "chat" | "mcp" | "automation" | "agent_loop";

export interface Actor {
  kind: ActorKind;
  /** Stable id: user id, token id, automation id, "local" for stdio. */
  id: string;
  /** Human label for audit and approval UI. */
  label: string;
  role?: string;
  /**
   * Per-actor grants. Undefined = owner-level (dashboard user, local stdio).
   * MCP tokens always carry scopes.
   */
  scopes?: TokenScopes;
}

export type ExecutionErrorCode =
  | "forbidden"
  | "locked"
  | "approval_invalid"
  | "not_found"
  | "tool_error";

export interface ExecutionError {
  code: ExecutionErrorCode;
  message: string;
  hint?: string;
}

export interface ApprovalRequired {
  status: "approval_required";
  approvalId: string;
  /** "approved" when the owner already approved but the call omitted approval_id */
  approvalStatus: "pending" | "approved";
  tool: string;
  summary: string;
  expiresAt: string;
  approveUrl: string;
  instructions: string;
}

export interface ExecuteToolResult {
  outcome: AuditOutcome;
  tier: ToolTier;
  durationMs: number;
  /** Raw tool output (success, or a tool that reported {error}/{success:false}). */
  result?: unknown;
  error?: ExecutionError;
  approval?: ApprovalRequired;
  /** The original exception when the tool threw (chat rethrows it). */
  thrown?: unknown;
}

export interface ExecuteToolParams {
  actor: Actor;
  source: ExecutionSource;
  toolName: string;
  args: unknown;
  /** Tool definition; resolved from the registry (then custom tools) when omitted. */
  tool?: Tool;
  /** Registry tier as known to the caller; raised by trust overrides. */
  baseTier?: ToolTier;
  /** Security mode override (chat resolves it once per message). */
  mode?: SecurityMode;
  /** Forwarded to the tool's execute() (AI SDK tool-call options). */
  toolCallOptions?: unknown;
}

// ── Actors ───────────────────────────────────────────────────────────────────

/**
 * Fallback chat actor for callers that run no execution context (e.g. the
 * messaging bots). The dashboard chat route runs as the session user.
 */
export const DASHBOARD_CHAT_ACTOR: Actor = { kind: "user", id: "dashboard", label: "Dashboard chat" };

/** The actor for a dashboard chat request made by a logged-in user. */
export function sessionChatActor(userId: unknown, username: unknown, role: unknown): Actor {
  const id = typeof userId === "string" && userId ? userId : "dashboard";
  const name = typeof username === "string" && username ? username : "Dashboard";
  return { kind: "user", id, label: `${name} (chat)`, role: typeof role === "string" ? role : undefined };
}

/** Automation ai_prompt steps (runAutomationPrompt). */
export function automationActor(automationName: string): Actor {
  return { kind: "automation", id: automationName, label: `Automation: ${automationName}` };
}

// ── Execution context ────────────────────────────────────────────────────────
// Lets a caller (the chat route, runAutomationPrompt) say who is acting without
// threading the actor through every tool-building function. Tool wrappers read
// it when they are built (gateToolExecution), so the actor is bound to the
// wrapped tool even if the model calls it later from another async context.

export interface ExecutionContext {
  actor: Actor;
  source: ExecutionSource;
}

const executionContext = new AsyncLocalStorage<ExecutionContext>();

/** Run `fn` with `actor`/`source` as the default for tools built inside it. */
export function withExecutionContext<T>(actor: Actor, source: ExecutionSource, fn: () => T): T {
  return executionContext.run({ actor, source }, fn);
}

/** The current execution context, or dashboard chat when none is set. */
export function currentExecutionContext(): ExecutionContext {
  return executionContext.getStore() ?? { actor: DASHBOARD_CHAT_ACTOR, source: "chat" };
}

/**
 * The local MCP stdio server (Claude Code via .mcp.json). Owner-level: the
 * process already runs as the owner with direct access to the SQLite file and
 * the Docker socket, so per-token grants would add no protection against it.
 * The security mode and approvals still apply to what it asks the agent to do.
 */
export function localStdioActor(): Actor {
  return { kind: "mcp_stdio", id: "local", label: "Local MCP (stdio)", role: "owner" };
}

// ── Security mode ────────────────────────────────────────────────────────────

const VALID_MODES = new Set<SecurityMode>(["permissive", "cautious", "locked"]);

/** Read the current security mode from settings. Defaults to "cautious". */
export function getSecurityMode(): SecurityMode {
  const raw = getSetting("security_mode");
  if (raw && VALID_MODES.has(raw as SecurityMode)) return raw as SecurityMode;
  return "cautious";
}

// ── Tool metadata and effective tiers ────────────────────────────────────────

/**
 * Tools whose registry tier understates their power. The effective tier is the
 * max of registry and override — it drives grants, locked mode, and audit.
 */
const TIER_OVERRIDES: Record<string, ToolTier> = {
  run_shell: "destructive", // arbitrary host command
  create_tool: "destructive", // writes code the server will load
  bulk_app_action: "modify",
  bulk_update_apps: "modify",
  cleanup_hls_cache: "modify",
};


/** Settings that change the trust boundary itself: writing them is destructive. */
const PROTECTED_SETTING_KEYS = new Set([
  "security_mode",
  "disabled_tools",
  "system_prompt",
  "allowed_paths",
  "file_manager_drives",
  "evolution_auto_execute",
  "evolution_execution_mode",
  "proxy_auth_enabled",
  "proxy_auth_bypass_apps",
]);
const PROTECTED_SETTING_PREFIXES = ["admin_", "session_", "mcp_", "approval", "auth_", "jwt", "proxy_auth_"];

/** Endpoint settings (sonarr_url, jellyfin_host, ...) that stored credentials are sent to. */
const ENDPOINT_SETTING_SUFFIX = /_(url|base_url|host|endpoint)$/;

export function isProtectedSettingKey(key: string): boolean {
  return PROTECTED_SETTING_KEYS.has(key) || PROTECTED_SETTING_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * Re-pointing an endpoint whose service has a stored secret (sonarr_url while
 * sonarr_api_key is set) would make Talome send that secret to the new host —
 * exfiltrating a credential the caller can never read directly. Such writes
 * are treated as destructive (approval-gated, and outside a Modify grant).
 */
export function isCredentialEndpointSettingKey(key: string): boolean {
  const match = ENDPOINT_SETTING_SUFFIX.exec(key);
  if (!match) return false;
  const prefix = key.slice(0, match.index);
  if (!prefix) return false;
  try {
    const rows = db.select({ key: schema.settings.key, value: schema.settings.value }).from(schema.settings).all();
    return rows.some((r) => r.key !== key && r.key.startsWith(`${prefix}_`) && isSecretSettingKey(r.key) && !!r.value);
  } catch {
    // Unknown: be conservative.
    return true;
  }
}

function maxTier(a: ToolTier, b: ToolTier): ToolTier {
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

interface ToolLocation {
  domain: string;
  registryTier: ToolTier;
  category?: string;
}

let locationCache: { size: number; map: Map<string, ToolLocation> } | null = null;

function toolLocations(): Map<string, ToolLocation> {
  const domains = getAllDomains();
  const size = domains.reduce((n, d) => n + Object.keys(d.tools).length, 0);
  if (locationCache && locationCache.size === size) return locationCache.map;
  const map = new Map<string, ToolLocation>();
  for (const d of domains) {
    for (const name of Object.keys(d.tools)) {
      map.set(name, { domain: d.name, registryTier: d.tiers[name] ?? "read", category: d.categories?.[name] });
    }
  }
  locationCache = { size, map };
  return map;
}

export interface ToolMeta {
  name: string;
  domain: string;
  category?: string;
  /** Effective tier independent of arguments (used for listing). */
  tier: ToolTier;
}

/** Domain + args-independent effective tier. Unknown (custom) tools are "custom"/read. */
export function getToolMeta(toolName: string, baseTier?: ToolTier): ToolMeta {
  const loc = toolLocations().get(toolName);
  const registryTier = baseTier ?? loc?.registryTier ?? "read";
  const override = TIER_OVERRIDES[toolName];
  return {
    name: toolName,
    domain: loc?.domain ?? "custom",
    category: loc?.category,
    tier: override ? maxTier(registryTier, override) : registryTier,
  };
}

/** Effective tier for a concrete call (arguments can escalate it). */
export function getEffectiveTier(toolName: string, args: Record<string, unknown>, baseTier?: ToolTier): ToolTier {
  const tier = getToolMeta(toolName, baseTier).tier;
  if (
    (toolName === "set_setting" || toolName === "revert_setting") &&
    typeof args.key === "string" &&
    (isProtectedSettingKey(args.key) || isCredentialEndpointSettingKey(args.key))
  ) {
    return "destructive";
  }
  return tier;
}

/**
 * Destructive calls that go through the approval flow in cautious mode.
 * run_shell is exempt only for a single read-only program invocation with no
 * shell metacharacters (see approval/shell-safety.ts); its own first-word
 * allowlist is not a safety boundary (`ls && rm -rf ~` passes it).
 */
export function requiresApprovalInCautious(toolName: string, tier: ToolTier, args?: Record<string, unknown>): boolean {
  if (tier !== "destructive") return false;
  if (toolName === "run_shell" && args && isApprovalExemptShellCommand(args.command)) return false;
  return true;
}

/** Tools that may need approval → their input schema accepts `approval_id`. */
export function acceptsApprovalArg(toolName: string, baseTier?: ToolTier): boolean {
  if (toolName === "set_setting" || toolName === "revert_setting") return true;
  return requiresApprovalInCautious(toolName, getToolMeta(toolName, baseTier).tier);
}

export const approvalIdArgSchema = z
  .string()
  .max(64)
  .optional()
  .describe(
    "Only when a previous call returned approval_required: the approval id, after the owner approved it in Talome. Leave unset otherwise.",
  );

// ── Helpers ──────────────────────────────────────────────────────────────────

const SOURCE_PREFIX: Record<ExecutionSource, string> = {
  chat: "AI",
  mcp: "MCP",
  automation: "Automation",
  agent_loop: "Agent loop",
};

type ExecuteFn = (args: unknown, options: unknown) => unknown;

function resolveTool(toolName: string): Tool | undefined {
  return getAllRegisteredTools()[toolName] ?? getCustomTools()[toolName];
}

function toArgsObject(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) return { ...(args as Record<string, unknown>) };
  return {};
}

function schemaHasKey(tool: Tool, key: string): boolean {
  const schema = (tool as { inputSchema?: unknown }).inputSchema as { _zod?: { def?: { shape?: unknown } }; shape?: unknown } | undefined;
  const raw = schema?._zod?.def?.shape ?? schema?.shape;
  const shape = typeof raw === "function" ? (raw as () => unknown)() : raw;
  return !!shape && typeof shape === "object" && key in (shape as Record<string, unknown>);
}

/** A tool that returned {error: ...} or {success: false} failed, even without throwing. */
export function detectToolReportedError(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.error === "string" && r.error.trim()) return r.error;
  if (r.error && typeof r.error === "object") {
    const msg = (r.error as { message?: unknown }).message;
    return typeof msg === "string" && msg ? msg : JSON.stringify(r.error);
  }
  if (r.success === false) {
    if (typeof r.message === "string" && r.message) return r.message;
    if (typeof r.error === "string" && r.error) return r.error;
    return "The tool reported failure.";
  }
  return null;
}

function humanToolName(toolName: string): string {
  const s = toolName.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const SUMMARY_TARGET_KEYS = ["appId", "app_id", "appIds", "containerId", "container", "containerName", "name", "path", "key", "id"] as const;

/** A short, redacted "on <target>" phrase for approval summaries, when the args name one. */
function describeTarget(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "run_shell" && typeof args.command === "string") {
    const cmd = redactText(args.command.trim());
    return `: ${cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd}`;
  }
  for (const key of SUMMARY_TARGET_KEYS) {
    const v = args[key];
    const text = Array.isArray(v) ? v.filter((x) => typeof x === "string").join(", ") : typeof v === "string" ? v : "";
    if (text.trim()) {
      const safe = redactText(text.trim());
      return ` on ${safe.length > 80 ? `${safe.slice(0, 80)}…` : safe}`;
    }
  }
  return "";
}

function listInstalledAppIds(): string[] {
  try {
    return db.select({ appId: schema.installedApps.appId }).from(schema.installedApps).all().map((r) => r.appId);
  } catch {
    return [];
  }
}

const TOOL_ERROR_HINT = "Check the arguments and the target's current state (e.g. that the app is installed and running), then retry.";

const CONSUME_MESSAGES: Record<ConsumeFailure, string> = {
  not_found: "This approval id does not exist.",
  actor_mismatch: "This approval was issued to a different agent.",
  tool_mismatch: "This approval was issued for a different tool.",
  args_mismatch: "The arguments differ from the approved request.",
  pending: "This approval has not been approved yet.",
  denied: "The owner denied this request.",
  consumed: "This approval was already used — approvals are single-use.",
  expired: "This approval has expired.",
};

// ── executeTool ──────────────────────────────────────────────────────────────

export async function executeTool(params: ExecuteToolParams): Promise<ExecuteToolResult> {
  const started = Date.now();
  const { actor, source, toolName } = params;
  const args = toArgsObject(params.args);
  const rawApprovalId = args[APPROVAL_ARG];
  delete args[APPROVAL_ARG];
  const approvalId = typeof rawApprovalId === "string" && rawApprovalId.trim() ? rawApprovalId.trim() : undefined;

  const meta = getToolMeta(toolName, params.baseTier);
  const tier = getEffectiveTier(toolName, args, params.baseTier);
  const prefix = SOURCE_PREFIX[source];

  const finish = (partial: Omit<ExecuteToolResult, "tier" | "durationMs">, auditDetails?: string): ExecuteToolResult => {
    const result: ExecuteToolResult = { ...partial, tier, durationMs: Date.now() - started };
    audit(result, auditDetails);
    return result;
  };

  const audit = (r: ExecuteToolResult, details?: string) => {
    // Chat reads are high-volume and were never audited; everything else is.
    if (source === "chat" && r.tier === "read" && r.outcome === "success") return;
    const label =
      r.outcome === "blocked"
        ? `BLOCKED (${r.error?.code ?? "blocked"}): ${toolName}`
        : r.outcome === "approval_required"
          ? `APPROVAL REQUIRED: ${toolName}`
          : `${prefix}: ${toolName}`;
    let preview = details ?? redactedPreview(args);
    if (r.outcome === "error" && r.error) preview = `${preview} → ${redactText(r.error.message).slice(0, 300)}`;
    writeAuditEntry(label, r.tier, preview, r.outcome === "success" || r.outcome === "error", {
      actorKind: actor.kind,
      actorId: actor.id,
      actorLabel: actor.label,
      source,
      toolName,
      outcome: r.outcome,
      durationMs: r.durationMs,
    });
  };

  const tool = params.tool ?? resolveTool(toolName);
  const execute = (tool as { execute?: ExecuteFn } | undefined)?.execute;
  if (!tool || !execute) {
    return finish({
      outcome: "error",
      error: { code: "not_found", message: `Unknown tool '${toolName}'.`, hint: "List the available tools and try again." },
    });
  }

  // 1. Per-actor grants (defense in depth: tools are also filtered at list time)
  if (actor.scopes) {
    const installed = actor.scopes.apps === "all" ? undefined : listInstalledAppIds();
    const decision = checkCallGrant(actor.scopes, { name: toolName, tier, domain: meta.domain }, args, installed);
    if (!decision.ok) {
      return finish({ outcome: "blocked", error: { code: "forbidden", message: decision.message, hint: decision.hint } });
    }
  }

  // 2. Security mode
  const mode = params.mode ?? getSecurityMode();
  if (mode === "locked" && tier !== "read") {
    return finish({
      outcome: "blocked",
      error: {
        code: "locked",
        message: `This action is blocked. Security mode is set to "locked" — only read operations are allowed.`,
        hint: "An admin can change this in Settings -> Security.",
      },
    });
  }

  // 3. Server-issued approvals (cautious mode, destructive tier)
  if (mode === "cautious" && requiresApprovalInCautious(toolName, tier, args)) {
    const argsHash = hashArgs(args);
    if (!approvalId) {
      try {
        const summary = `${actor.label} wants to run "${humanToolName(toolName)}"${describeTarget(toolName, args)} (${tier}).`;
        const argsPreview = redactedPreview(args, 400);
        const { approval, created } = requestApproval({
          actor: { kind: actor.kind, id: actor.id, label: actor.label },
          source,
          tool: toolName,
          argsHash,
          argsPreview,
          summary,
        });
        const approveUrl = `/dashboard/settings/approvals?id=${approval.id}`;
        if (created) {
          writeNotification(
            "warning",
            `Approval needed: ${humanToolName(toolName)}`,
            `${summary}\nReview it in Settings -> Approvals: ${approveUrl}\n${argsPreview}`,
            `approval:${approval.id}`,
          );
        }
        const alreadyApproved = approval.status === "approved";
        return finish(
          {
            outcome: "approval_required",
            approval: {
              status: "approval_required",
              approvalId: approval.id,
              approvalStatus: alreadyApproved ? "approved" : "pending",
              tool: toolName,
              summary: approval.summary,
              expiresAt: approval.expiresAt,
              approveUrl,
              instructions: alreadyApproved
                ? `The owner already approved this exact request. Call ${toolName} again with the same arguments plus approval_id: "${approval.id}".`
                : `This is a destructive action and security mode is "cautious". Ask the user to approve it in Talome Settings -> Approvals (${approveUrl}), then call ${toolName} again with the same arguments plus approval_id: "${approval.id}". The approval expires at ${approval.expiresAt}.`,
            },
          },
          argsPreview,
        );
      } catch (err) {
        return finish({
          outcome: "blocked",
          error: {
            code: "approval_invalid",
            message: `Could not create an approval request: ${err instanceof Error ? err.message : String(err)}`,
            hint: "Retry shortly; if it persists, check that the Talome server has run its migrations.",
          },
        });
      }
    }

    let consumed: ReturnType<typeof consumeApproval>;
    try {
      consumed = consumeApproval({ approvalId, actor: { kind: actor.kind, id: actor.id, label: actor.label }, tool: toolName, argsHash });
    } catch (err) {
      consumed = { ok: false, reason: "not_found" };
      console.error("[execution] approval lookup failed:", err instanceof Error ? err.message : err);
    }
    if (!consumed.ok) {
      return finish({
        outcome: "blocked",
        error: {
          code: "approval_invalid",
          message: CONSUME_MESSAGES[consumed.reason],
          hint:
            consumed.reason === "pending"
              ? "Ask the user to approve it in Talome Settings -> Approvals, then retry."
              : "Call the tool again without approval_id to request a new approval.",
        },
      });
    }
    // The human approved this exact request server-side; satisfy the tool's
    // own legacy confirmation flag if it declares one.
    if (schemaHasKey(tool, "confirmed")) args.confirmed = true;
  }

  // 4. Execute
  let output: unknown;
  try {
    output = await execute(args, params.toolCallOptions ?? { toolCallId: `${source}-${randomUUID()}`, messages: [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finish({ outcome: "error", thrown: err, error: { code: "tool_error", message, hint: TOOL_ERROR_HINT } });
  }

  // A secret setting may just have changed: refresh the redaction list before
  // this call's own audit entry is written.
  if (toolName === "set_setting" || toolName === "revert_setting") invalidateSecretValueCache();

  const reported = detectToolReportedError(output);
  if (reported) {
    return finish({ outcome: "error", result: output, error: { code: "tool_error", message: reported, hint: TOOL_ERROR_HINT } });
  }
  return finish({ outcome: "success", result: output });
}
