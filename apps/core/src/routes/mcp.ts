import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import { hashToken, verifyBearerToken } from "../middleware/auth.js";
import { writeAuditEntry } from "../db/audit.js";
import { getEnabledRegisteredTools, getToolTier, getDisabledToolNames } from "../ai/agent.js";
import { authorizeToolCall, withConfirmation } from "../ai/tool-gateway.js";
import { getToolDomain } from "../ai/tool-registry.js";
import { checkTokenScope, isToolInScope, type ContainerResolver } from "../ai/token-scope.js";
import { db, schema } from "../db/index.js";
import { describeActor, type ExecutionActor } from "../ai/execution-actor.js";
import { summarizeForAudit } from "../utils/redact.js";

// ── MCP Server factory ─────────────────────────────────────────────────────────
// Auto-registers tools from active domains so MCP stays in sync with the agent
// and only exposes tools for configured apps (same filtering as dashboard chat).
// Every call is checked against the calling token's own scope, then runs through
// the same authorization as chat (security mode + server-issued approvals), and
// is audited with the caller's identity, the tool's real tier and redacted arguments.

/** Who is calling over MCP — a bearer token (HTTP) or the local stdio process. */
export type McpActor = Extract<ExecutionActor, { kind: "token" } | { kind: "stdio" }>;

/** Tools report failure by returning `{ error }`, `{ success: false }` or `{ ok: false }` rather than throwing. */
export function isToolErrorResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const r = result as Record<string, unknown>;
  return (typeof r.error === "string" && r.error.length > 0) || r.success === false || r.ok === false;
}

/**
 * Resolve a container name or id to the installed app that owns it: the app id
 * itself, "<appId>-…"/"<appId>_…" compose names, or one of its recorded container ids.
 */
export function installedAppContainerResolver(): ContainerResolver {
  const apps = db.select({ appId: schema.installedApps.appId, containerIds: schema.installedApps.containerIds }).from(schema.installedApps).all();
  return (ref) => {
    const needle = ref.toLowerCase().replace(/^\//, "");
    for (const app of apps) {
      const id = app.appId.toLowerCase();
      if (needle === id || needle.startsWith(`${id}-`) || needle.startsWith(`${id}_`)) return app.appId;
      let containerIds: unknown = [];
      try {
        containerIds = JSON.parse(app.containerIds);
      } catch {
        /* malformed — no ids */
      }
      if (Array.isArray(containerIds) && needle.length >= 12 && containerIds.some((cid) => typeof cid === "string" && (cid.startsWith(needle) || needle.startsWith(cid)))) {
        return app.appId;
      }
    }
    return null;
  };
}

type McpToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

/**
 * Run one MCP tool call: re-check that the tool is still enabled and inside the
 * token's scope, authorize it for the current security mode, execute, and audit.
 */
export async function executeMcpToolCall(
  toolName: string,
  execute: (args: unknown, ctx: unknown) => unknown,
  args: Record<string, unknown>,
  actor: McpActor,
): Promise<McpToolResult> {
  const tier = getToolTier(toolName);
  const who = describeActor(actor);
  const argSummary = summarizeForAudit(args);

  if (getDisabledToolNames().has(toolName)) {
    writeAuditEntry(`MCP BLOCKED (disabled): ${toolName}`, tier, `${who} · ${argSummary}`, false);
    return errorResult(`${toolName} is disabled in Talome settings.`);
  }

  if (actor.kind === "token") {
    const scopeDecision = checkTokenScope(
      actor.scope,
      toolName,
      tier,
      getToolDomain(toolName),
      args,
      actor.scope.apps === "*" ? undefined : installedAppContainerResolver(),
    );
    if (!scopeDecision.allowed) {
      writeAuditEntry(`MCP BLOCKED (token scope): ${toolName}`, tier, `${who} · ${argSummary}`, false);
      return errorResult(scopeDecision.reason);
    }
  }

  const decision = authorizeToolCall(toolName, tier, args, actor);
  if (!decision.allowed) {
    writeAuditEntry(`MCP ${decision.auditAction}`, tier, `${who} · ${argSummary}`, false);
    return errorResult(decision.reason);
  }
  const approvalNote = decision.approvalId ? ` · approved (request ${decision.approvalId})` : "";

  try {
    const result = await execute(withConfirmation(args, decision.approvalId !== undefined), {});
    const failed = isToolErrorResult(result);
    writeAuditEntry(`MCP: ${toolName}`, tier, `${who} · ${failed ? "failed" : "ok"}${approvalNote} · ${argSummary}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) ?? "null" }],
      ...(failed ? { isError: true } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeAuditEntry(`MCP: ${toolName}`, tier, `${who} · threw${approvalNote} · ${argSummary}`);
    return errorResult(message);
  }
}

export function createMcpServer(actor: McpActor = { kind: "stdio" }): McpServer {
  const server = new McpServer({ name: "talome", version: "0.1.0" });

  for (const [toolName, toolDef] of Object.entries(getEnabledRegisteredTools())) {
    // Tokens only see the tools their scope grants
    if (actor.kind === "token" && !isToolInScope(actor.scope, getToolTier(toolName), getToolDomain(toolName))) continue;

    const t = toolDef as {
      description?: string;
      inputSchema?: Record<string, unknown>;
      execute?: (args: unknown, ctx: unknown) => unknown;
    };

    if (!t.execute) continue;
    const execute = t.execute;

    const description = t.description ?? toolName;
    const tier = getToolTier(toolName);

    // MCP SDK v1.27's server.tool() only accepts ZodRawShape (plain object of Zod fields),
    // not a ZodObject. Zod v4 Classic schemas have _zod internally; extract .shape so the
    // SDK recognises the parameter list correctly.
    const rawSchema = t.inputSchema as Record<string, unknown> | undefined;
    let mcpInputSchema: Record<string, unknown>;
    if (rawSchema && typeof rawSchema === "object" && "_zod" in rawSchema) {
      const shapeProp = (rawSchema as { _zod?: { def?: { shape?: unknown } } })._zod?.def?.shape;
      mcpInputSchema = (typeof shapeProp === "function" ? shapeProp() : shapeProp) ?? {};
    } else {
      mcpInputSchema = (rawSchema ?? {}) as Record<string, unknown>;
    }

    // Tier-derived hints let MCP clients distinguish safe reads from destructive calls.
    const annotations = { readOnlyHint: tier === "read", destructiveHint: tier === "destructive" };

    server.tool(toolName, description, mcpInputSchema as ZodRawShapeCompat, annotations, async (args) =>
      executeMcpToolCall(toolName, execute, args as Record<string, unknown>, actor),
    );
  }

  return server;
}

// ── Hono route ────────────────────────────────────────────────────────────────

export const mcp = new Hono<{ Variables: { mcpActor: McpActor } }>();

// Bearer token authentication middleware — records which token is calling
mcp.use("/*", async (c, next) => {
  const auth = c.req.header("Authorization");
  const result = verifyBearerToken(auth);
  if (!result.ok) {
    c.header("WWW-Authenticate", 'Bearer realm="Talome MCP"');
    return c.json({ error: "Unauthorized — provide a valid Bearer token" }, 401);
  }
  c.set("mcpActor", { kind: "token", tokenId: result.tokenId, tokenName: result.tokenName, scope: result.scope });
  await next();
});

// Stateless MCP handler — fresh server + transport per request
mcp.all("/", async (c) => {
  const server = createMcpServer(c.get("mcpActor"));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  return response;
});

export { hashToken, verifyBearerToken };

// Generate a new MCP token — returns the plaintext token (shown once) and its hash
export function generateMcpToken(name: string): { id: string; plaintext: string; hash: string } {
  const id = randomUUID();
  const plaintext = `talome_${randomUUID().replace(/-/g, "")}`;
  const hash = hashToken(plaintext);
  return { id, plaintext, hash };
}
