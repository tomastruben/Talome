import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { getSetting, setSetting } from "../utils/settings.js";
import { eq } from "drizzle-orm";
import { startTelegramBot, stopTelegramBot, getTelegramBotStatus } from "../messaging/telegram.js";
import { startDiscordBot, stopDiscordBot, getDiscordBotStatus } from "../messaging/discord-bot.js";
import { serverError } from "../middleware/request-logger.js";
import { generateMcpToken } from "./mcp.js";
import { DEFAULT_TOKEN_SCOPE, mcpTokenScopeSchema, parseTokenScope } from "../ai/token-scope.js";
import { listDomains } from "../ai/tool-registry.js";

const integrations = new Hono();

/* ── Request schemas ─────────────────────────────────────────────────────── */

const botTokenSchema = z.object({
  token: z.string().max(500).optional(),
});

const mcpTokenSchema = z.object({
  name: z.string().min(1).max(100).transform((s) => s.trim()),
  /** Omitted → read-only access to everything (DEFAULT_TOKEN_SCOPE) */
  scope: mcpTokenScopeSchema.optional(),
  /** Omitted or null → never expires */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
});

const mcpTokenUpdateSchema = z.object({
  name: z.string().min(1).max(100).transform((s) => s.trim()).optional(),
  scope: mcpTokenScopeSchema.optional(),
});

function expiryFromDays(days: number | null | undefined): string | null {
  return days ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() : null;
}

// ── Telegram ─────────────────────────────────────────────────────────────────

integrations.get("/telegram/status", (c) => {
  return c.json(getTelegramBotStatus());
});

integrations.post("/telegram/restart", async (c) => {
  try {
    const parsed = botTokenSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);

    const resolvedToken =
      parsed.data.token?.trim() || getSetting("telegram_bot_token");

    if (!resolvedToken) {
      return c.json({ ok: false, error: "No token provided" }, 400);
    }

    // Persist the token
    setSetting("telegram_bot_token", resolvedToken);

    const result = await startTelegramBot(resolvedToken);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 400);
    }
    return c.json({ ok: true, username: result.username });
  } catch (err) {
    return serverError(c, err, { message: "Failed to restart Telegram bot" });
  }
});

integrations.post("/telegram/stop", async (c) => {
  try {
    await stopTelegramBot();
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to stop Telegram bot" });
  }
});

// ── Discord ───────────────────────────────────────────────────────────────────

integrations.get("/discord/status", (c) => {
  return c.json(getDiscordBotStatus());
});

integrations.post("/discord/restart", async (c) => {
  try {
    const parsed = botTokenSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);

    const resolvedToken =
      parsed.data.token?.trim() || getSetting("discord_bot_token");

    if (!resolvedToken) {
      return c.json({ ok: false, error: "No token provided" }, 400);
    }

    // Persist the token
    setSetting("discord_bot_token", resolvedToken);

    const result = await startDiscordBot(resolvedToken);
    if (!result.ok) {
      return c.json({ ok: false, error: result.error }, 400);
    }
    return c.json({ ok: true, username: result.username });
  } catch (err) {
    return serverError(c, err, { message: "Failed to restart Discord bot" });
  }
});

integrations.post("/discord/stop", async (c) => {
  try {
    await stopDiscordBot();
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to stop Discord bot" });
  }
});

// ── MCP Tokens ────────────────────────────────────────────────────────────────

integrations.get("/mcp/tokens", (c) => {
  try {
    const tokens = db
      .select({
        id: schema.mcpTokens.id,
        name: schema.mcpTokens.name,
        createdAt: schema.mcpTokens.createdAt,
        lastUsedAt: schema.mcpTokens.lastUsedAt,
        scope: schema.mcpTokens.scope,
        expiresAt: schema.mcpTokens.expiresAt,
      })
      .from(schema.mcpTokens)
      .all();
    return c.json(tokens.map((t) => ({ ...t, scope: parseTokenScope(t.scope) })));
  } catch (err) {
    return serverError(c, err, { message: "Failed to list MCP tokens" });
  }
});

integrations.post("/mcp/tokens", async (c) => {
  try {
    const parsed = mcpTokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);
    const { name } = parsed.data;
    const scope = parsed.data.scope ?? DEFAULT_TOKEN_SCOPE;
    const expiresAt = expiryFromDays(parsed.data.expiresInDays);

    const { id, plaintext, hash } = generateMcpToken(name);
    db.insert(schema.mcpTokens)
      .values({ id, name, tokenHash: hash, scope: JSON.stringify(scope), expiresAt })
      .run();

    return c.json({ ok: true, id, name, token: plaintext, scope, expiresAt });
  } catch (err) {
    return serverError(c, err, { message: "Failed to create MCP token" });
  }
});

integrations.patch("/mcp/tokens/:id", async (c) => {
  try {
    const { id } = c.req.param();
    const parsed = mcpTokenUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);

    const updates: { name?: string; scope?: string } = {};
    if (parsed.data.name) updates.name = parsed.data.name;
    if (parsed.data.scope) updates.scope = JSON.stringify(parsed.data.scope);
    if (Object.keys(updates).length === 0) return c.json({ ok: false, error: "Nothing to update" }, 400);

    const result = db.update(schema.mcpTokens).set(updates).where(eq(schema.mcpTokens.id, id)).run();
    if (result.changes === 0) return c.json({ ok: false, error: "Token not found" }, 404);
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to update MCP token", context: { tokenId: c.req.param("id") } });
  }
});

/** Domains and installed apps a token scope can be limited to. */
integrations.get("/mcp/scope-options", (c) => {
  try {
    const domains = listDomains().map(({ name, toolCount }) => ({ name, toolCount }));
    const apps = db
      .select({ appId: schema.installedApps.appId, displayName: schema.installedApps.displayName })
      .from(schema.installedApps)
      .all()
      .map((a) => ({ appId: a.appId, name: a.displayName || a.appId }));
    return c.json({ domains, apps });
  } catch (err) {
    return serverError(c, err, { message: "Failed to list MCP scope options" });
  }
});

integrations.delete("/mcp/tokens/:id", (c) => {
  try {
    const { id } = c.req.param();
    db.delete(schema.mcpTokens).where(eq(schema.mcpTokens.id, id)).run();
    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to delete MCP token", context: { tokenId: c.req.param("id") } });
  }
});

export { integrations };
