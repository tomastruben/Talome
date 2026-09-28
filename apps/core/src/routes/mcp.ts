import { Hono } from "hono";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { Tool } from "ai";
import { hashToken, verifyBearerToken } from "../middleware/auth.js";
import { getActiveDomainTools } from "../ai/agent.js";
import {
  acceptsApprovalArg,
  approvalIdArgSchema,
  executeTool,
  getToolMeta,
  type Actor,
  type ExecuteToolResult,
  type ToolMeta,
} from "../ai/execution.js";
import { checkToolGrant } from "../approval/grants.js";
import { getSetting } from "../utils/settings.js";

// ── Tool view ────────────────────────────────────────────────────────────────
// The MCP tool list is derived per actor, per evaluation: tools from domains
// configured right now, minus tools disabled in Settings, minus tools the
// actor's grants do not cover. Every call is re-checked by executeTool().

interface ToolView {
  name: string;
  tool: Tool;
  meta: ToolMeta;
}

function getDisabledTools(): Set<string> {
  const raw = getSetting("disabled_tools");
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/** Tools this actor may see right now. */
export function getMcpToolView(actor: Actor): ToolView[] {
  const disabled = getDisabledTools();
  const view: ToolView[] = [];
  for (const [name, tool] of Object.entries(getActiveDomainTools())) {
    if (disabled.has(name)) continue;
    if (typeof (tool as { execute?: unknown }).execute !== "function") continue;
    const meta = getToolMeta(name);
    if (actor.scopes && !checkToolGrant(actor.scopes, { name, tier: meta.tier, domain: meta.domain }).ok) continue;
    view.push({ name, tool, meta });
  }
  return view;
}

// ── Annotations ──────────────────────────────────────────────────────────────

const TITLE_WORDS: Record<string, string> = {
  qbt: "qBittorrent",
  hass: "Home Assistant",
  mdns: "mDNS",
  api: "API",
  hls: "HLS",
  tls: "TLS",
  gpu: "GPU",
  smart: "SMART",
  arr: "Arr",
  pihole: "Pi-hole",
  ollama: "Ollama",
  plex: "Plex",
  jellyfin: "Jellyfin",
  overseerr: "Overseerr",
  prowlarr: "Prowlarr",
  audiobookshelf: "Audiobookshelf",
  vaultwarden: "Vaultwarden",
  tailscale: "Tailscale",
};

/** "qbt_set_speed_limits" → "qBittorrent set speed limits" */
export function humanTitle(toolName: string): string {
  const words = toolName.split("_").map((w) => TITLE_WORDS[w] ?? w);
  const first = words[0] ?? toolName;
  words[0] = TITLE_WORDS[toolName.split("_")[0] ?? ""] ? first : first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

/** Calling these again with the same arguments has no additional effect. */
const IDEMPOTENT_TOOLS = new Set([
  "start_container",
  "stop_container",
  "start_app",
  "stop_app",
  "set_setting",
  "set_app_env",
  "set_update_policy",
  "set_resource_limits",
  "create_directory",
  "plex_mark_watched",
  "plex_mark_unwatched",
  "pihole_enable",
  "pihole_disable",
  "pihole_whitelist",
  "pihole_blacklist",
  "mdns_enable",
  "mdns_disable",
  "tailscale_stop",
  "vaultwarden_toggle_signups",
  "qbt_set_preferences",
  "qbt_set_download_path",
  "qbt_set_speed_limits",
  "arr_set_monitoring",
  "arr_set_naming_convention",
  "proxy_reload",
  "reload_tools",
  "delete_file",
  "uninstall_app",
  "remove_network",
]);

/** Domains whose tools talk to services outside Talome itself. */
const OPEN_WORLD_DOMAINS = new Set([
  "media",
  "optimization",
  "arr",
  "qbittorrent",
  "jellyfin",
  "audiobookshelf",
  "overseerr",
  "plex",
  "homeassistant",
  "pihole",
  "vaultwarden",
  "ollama",
  "tailscale",
]);

/** Core tools that reach external registries, APIs, or notification channels. */
const OPEN_WORLD_TOOLS = new Set([
  "install_app",
  "update_app",
  "update_all_apps",
  "add_store",
  "search_apps",
  "check_updates",
  "upgrade_app_image",
  "app_api_call",
  "discover_app_api",
  "send_notification",
  "test_notification_channel",
  "apply_change",
  "proxy_add_route",
  "proxy_configure_tls",
]);

export function toolAnnotations(meta: ToolMeta): ToolAnnotations {
  const readOnly = meta.tier === "read";
  return {
    title: humanTitle(meta.name),
    readOnlyHint: readOnly,
    destructiveHint: meta.tier === "destructive",
    ...(readOnly ? {} : { idempotentHint: IDEMPOTENT_TOOLS.has(meta.name) }),
    openWorldHint: OPEN_WORLD_DOMAINS.has(meta.domain) || OPEN_WORLD_TOOLS.has(meta.name),
  };
}

// ── Results ──────────────────────────────────────────────────────────────────

function text(value: string): CallToolResult["content"][number] {
  return { type: "text" as const, text: value };
}

/** Map an execution result to an MCP CallToolResult (errors → isError with a [code]). */
export function toMcpCallResult(r: ExecuteToolResult): CallToolResult {
  switch (r.outcome) {
    case "success":
      return { content: [text(JSON.stringify(r.result ?? null, null, 2))] };
    case "approval_required":
      return {
        content: [text(`[approval_required] ${r.approval?.instructions ?? "Approval required."}`), text(JSON.stringify(r.approval, null, 2))],
        isError: true,
      };
    case "error": {
      const content = [text(`[${r.error?.code ?? "tool_error"}] ${r.error?.message ?? "Tool failed"}${r.error?.hint ? ` ${r.error.hint}` : ""}`)];
      if (r.result !== undefined) content.push(text(JSON.stringify(r.result, null, 2)));
      return { content, isError: true };
    }
    case "blocked":
    default:
      return {
        content: [text(`[${r.error?.code ?? "forbidden"}] ${r.error?.message ?? "Blocked"}${r.error?.hint ? ` ${r.error.hint}` : ""}`)],
        isError: true,
      };
  }
}

// ── MCP Server factory ───────────────────────────────────────────────────────

/** Extract a Zod raw shape from a tool's input schema (Zod v4 object or shape). */
function inputShape(tool: Tool): Record<string, unknown> {
  const rawSchema = (tool as { inputSchema?: unknown }).inputSchema as Record<string, unknown> | undefined;
  if (rawSchema && typeof rawSchema === "object" && "_zod" in rawSchema) {
    const shapeProp = (rawSchema as { _zod?: { def?: { shape?: unknown } } })._zod?.def?.shape;
    const shape = typeof shapeProp === "function" ? (shapeProp as () => unknown)() : shapeProp;
    return { ...((shape as Record<string, unknown> | undefined) ?? {}) };
  }
  return { ...(rawSchema ?? {}) };
}

export interface McpSession {
  server: McpServer;
  /** Re-evaluate the tool view; registers/removes tools (emits tools/list_changed). */
  sync: () => { added: string[]; removed: string[] };
}

/**
 * Build an MCP server for one actor. Only tools the actor is authorized for
 * are registered; each handler routes through executeTool(), so grants,
 * security mode, approvals, and audit apply to every call.
 */
export function createMcpSession(actor: Actor): McpSession {
  const server = new McpServer({ name: "talome", version: "0.1.0" });
  const registered = new Map<string, RegisteredTool>();

  const register = (entry: ToolView) => {
    const shape = inputShape(entry.tool);
    if (acceptsApprovalArg(entry.name) && !("approval_id" in shape)) shape.approval_id = approvalIdArgSchema;
    const handle = server.registerTool(
      entry.name,
      {
        title: humanTitle(entry.name),
        description: (entry.tool as { description?: string }).description ?? entry.name,
        // Raw Zod shape — the SDK wraps it in an object schema.
        inputSchema: shape as never,
        annotations: toolAnnotations(entry.meta),
      },
      (async (args: unknown) => {
        const result = await executeTool({ actor, source: "mcp", toolName: entry.name, args, tool: entry.tool });
        return toMcpCallResult(result);
      }) as never,
    );
    registered.set(entry.name, handle);
  };

  const sync = () => {
    const view = getMcpToolView(actor);
    const wanted = new Set(view.map((v) => v.name));
    const added: string[] = [];
    const removed: string[] = [];
    for (const [name, handle] of registered) {
      if (!wanted.has(name)) {
        handle.remove();
        registered.delete(name);
        removed.push(name);
      }
    }
    for (const entry of view) {
      if (registered.has(entry.name)) continue;
      register(entry);
      added.push(entry.name);
    }
    return { added, removed };
  };

  sync();
  return { server, sync };
}

export function createMcpServer(actor: Actor): McpServer {
  return createMcpSession(actor).server;
}

// ── Hono route ────────────────────────────────────────────────────────────────

type McpEnv = { Variables: { mcpActor: Actor } };

export const mcp = new Hono<McpEnv>();

// Bearer token authentication: unknown, revoked and expired tokens → 401.
// The verified token becomes the actor for every tool call in this request.
mcp.use("/*", async (c, next) => {
  const result = verifyBearerToken(c.req.header("Authorization"));
  if (!result.ok) {
    c.header("WWW-Authenticate", 'Bearer realm="Talome MCP"');
    const reason =
      result.reason === "revoked"
        ? "token revoked"
        : result.reason === "expired"
          ? "token expired"
          : "provide a valid Bearer token";
    return c.json({ error: `Unauthorized — ${reason}` }, 401);
  }
  c.set("mcpActor", {
    kind: "mcp_token",
    id: result.token.id,
    label: `MCP token "${result.token.name}"`,
    scopes: result.token.scopes,
  });
  await next();
});

// Stateless MCP handler — fresh server + transport per request, built for the
// requesting token (tool view evaluated now, not at process start).
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
