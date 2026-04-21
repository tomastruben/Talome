import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { startTelegramBot, stopTelegramBot, getTelegramBotStatus } from "../messaging/telegram.js";
import { startDiscordBot, stopDiscordBot, getDiscordBotStatus } from "../messaging/discord-bot.js";
import { serverError } from "../middleware/request-logger.js";
import { generateMcpToken } from "./mcp.js";

const integrations = new Hono();

/* ── Request schemas ─────────────────────────────────────────────────────── */

const botTokenSchema = z.object({
  token: z.string().max(500).optional(),
});

const mcpTokenSchema = z.object({
  name: z.string().min(1).max(100).transform((s) => s.trim()),
});

// ── Telegram ─────────────────────────────────────────────────────────────────

integrations.get("/telegram/status", (c) => {
  return c.json(getTelegramBotStatus());
});

integrations.post("/telegram/restart", async (c) => {
  try {
    const parsed = botTokenSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);

    const resolvedToken =
      parsed.data.token?.trim() ||
      db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, "telegram_bot_token"))
        .get()?.value;

    if (!resolvedToken) {
      return c.json({ ok: false, error: "No token provided" }, 400);
    }

    // Persist the token
    db.insert(schema.settings)
      .values({ key: "telegram_bot_token", value: resolvedToken })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: resolvedToken } })
      .run();

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
      parsed.data.token?.trim() ||
      db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, "discord_bot_token"))
        .get()?.value;

    if (!resolvedToken) {
      return c.json({ ok: false, error: "No token provided" }, 400);
    }

    // Persist the token
    db.insert(schema.settings)
      .values({ key: "discord_bot_token", value: resolvedToken })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: resolvedToken } })
      .run();

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
      })
      .from(schema.mcpTokens)
      .all();
    return c.json(tokens);
  } catch (err) {
    return serverError(c, err, { message: "Failed to list MCP tokens" });
  }
});

integrations.post("/mcp/tokens", async (c) => {
  try {
    const parsed = mcpTokenSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);
    const { name } = parsed.data;

    const { id, plaintext, hash } = generateMcpToken(name);
    db.insert(schema.mcpTokens)
      .values({ id, name, tokenHash: hash })
      .run();

    return c.json({ ok: true, id, name, token: plaintext });
  } catch (err) {
    return serverError(c, err, { message: "Failed to create MCP token" });
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
