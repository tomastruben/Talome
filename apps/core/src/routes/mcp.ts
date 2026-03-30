import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { randomUUID } from "node:crypto";
import { hashToken, verifyBearerToken } from "../middleware/auth.js";
import { writeAuditEntry } from "../db/audit.js";
import { allTools } from "../ai/agent.js";

// ── MCP Server factory ─────────────────────────────────────────────────────────
// Auto-registers every tool from allTools so MCP always stays in sync with the
// agent — same names, same descriptions, same schemas, same execute logic.

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "talome", version: "0.1.0" });

  for (const [toolName, toolDef] of Object.entries(allTools)) {
    const t = toolDef as {
      description?: string;
      inputSchema?: Record<string, unknown>;
      execute?: (args: unknown, ctx: unknown) => unknown;
    };

    if (!t.execute) continue;

    const description = t.description ?? toolName;

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

    server.tool(toolName, description, mcpInputSchema, async (args) => {
      try {
        const result = await (t.execute as (a: unknown, c: unknown) => Promise<unknown>)(args, {});
        writeAuditEntry(`MCP: ${toolName}`, "read", JSON.stringify(args).slice(0, 200));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
      }
    });
  }

  return server;
}

// ── Hono route ────────────────────────────────────────────────────────────────

export const mcp = new Hono();

// Bearer token authentication middleware
mcp.use("/*", async (c, next) => {
  const auth = c.req.header("Authorization");
  const result = verifyBearerToken(auth);
  if (!result.ok) {
    c.header("WWW-Authenticate", 'Bearer realm="Talome MCP"');
    return c.json({ error: "Unauthorized — provide a valid Bearer token" }, 401);
  }
  await next();
});

// Stateless MCP handler — fresh server + transport per request
mcp.all("/", async (c) => {
  const server = createMcpServer();
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
