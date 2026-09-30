import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import { hashToken, verifyBearerToken } from "../middleware/auth.js";
import { writeAuditEntry } from "../db/audit.js";
import { getEnabledRegisteredTools, getToolTier, getDisabledToolNames } from "../ai/agent.js";
import { checkToolPolicy, getSecurityMode } from "../ai/tool-gateway.js";
import { summarizeForAudit } from "../utils/redact.js";

// ── MCP Server factory ─────────────────────────────────────────────────────────
// Auto-registers tools from active domains so MCP stays in sync with the agent
// and only exposes tools for configured apps (same filtering as dashboard chat).
// Every call runs through the same security policy as chat and is audited with
// the caller's identity, the tool's real tier and redacted arguments.

/** Who is calling over MCP — a bearer token (HTTP) or the local stdio process. */
export type McpActor =
  | { kind: "token"; tokenId: string; tokenName: string }
  | { kind: "stdio" };

function describeActor(actor: McpActor): string {
  return actor.kind === "token" ? `token "${actor.tokenName}" (${actor.tokenId})` : "stdio (local Claude Code)";
}

/** Tools report failure by returning `{ error }`, `{ success: false }` or `{ ok: false }` rather than throwing. */
export function isToolErrorResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const r = result as Record<string, unknown>;
  return (typeof r.error === "string" && r.error.length > 0) || r.success === false || r.ok === false;
}

type McpToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/**
 * Run one MCP tool call: re-check that the tool is still enabled, apply the
 * security policy for the current mode, execute, and audit the outcome.
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
    return { content: [{ type: "text", text: `Error: ${toolName} is disabled in Talome settings.` }], isError: true };
  }

  const decision = checkToolPolicy(toolName, tier, getSecurityMode(), args);
  if (!decision.allowed) {
    writeAuditEntry(`MCP ${decision.auditAction}`, tier, `${who} · ${argSummary}`, false);
    return { content: [{ type: "text", text: `Error: ${decision.reason}` }], isError: true };
  }

  try {
    const result = await execute(args, {});
    const failed = isToolErrorResult(result);
    writeAuditEntry(`MCP: ${toolName}`, tier, `${who} · ${failed ? "failed" : "ok"} · ${argSummary}`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) ?? "null" }],
      ...(failed ? { isError: true } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeAuditEntry(`MCP: ${toolName}`, tier, `${who} · threw · ${argSummary}`);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
}

export function createMcpServer(actor: McpActor = { kind: "stdio" }): McpServer {
  const server = new McpServer({ name: "talome", version: "0.1.0" });

  for (const [toolName, toolDef] of Object.entries(getEnabledRegisteredTools())) {
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
  c.set("mcpActor", { kind: "token", tokenId: result.tokenId, tokenName: result.tokenName });
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
