import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { getSetting, setSetting } from "../utils/settings.js";
import { eq } from "drizzle-orm";
import { startTelegramBot, stopTelegramBot, getTelegramBotStatus } from "../messaging/telegram.js";
import { startDiscordBot, stopDiscordBot, getDiscordBotStatus } from "../messaging/discord-bot.js";
import { serverError } from "../middleware/request-logger.js";
import { requireRole } from "../middleware/role-guard.js";
import { mcpTokens } from "./mcp-tokens.js";
import { messagingSenders } from "./messaging-senders.js";

const integrations = new Hono();

// Starting, stopping or re-pointing a chat bot (its token decides which bot
// the owner's agent answers through) is an admin action.
for (const platform of ["telegram", "discord"] as const) {
  integrations.use(`/${platform}/restart`, requireRole("admin"));
  integrations.use(`/${platform}/stop`, requireRole("admin"));
}

/* ── Request schemas ─────────────────────────────────────────────────────── */

const botTokenSchema = z.object({
  token: z.string().max(500).optional(),
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
// Per-token grants, expiry and soft revocation live in routes/mcp-tokens.ts.

integrations.route("/mcp/tokens", mcpTokens);

// ── Chat bot senders ──────────────────────────────────────────────────────────
// Who the Telegram/Discord bots answer (admin-only, messaging/allowlist.ts).

integrations.route("/messaging/senders", messagingSenders);

export { integrations };
