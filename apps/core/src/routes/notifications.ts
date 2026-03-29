import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { eq, desc, sql } from "drizzle-orm";
import { createLogger } from "../utils/logger.js";

const log = createLogger("notifications");
const notifications = new Hono();

/**
 * Check if a messaging platform should receive notifications at this level.
 * Controlled by settings: telegram_notification_levels / discord_notification_levels
 * Value is a comma-separated list of levels, e.g. "critical" or "warning,critical"
 * Default: "warning,critical" (backwards compatible)
 */
function platformAcceptsLevel(platform: "telegram" | "discord", level: string): boolean {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, `${platform}_notification_levels`))
      .get();
    if (!row?.value) return true; // No filter configured = accept all warning+critical
    const allowed = row.value.split(",").map((s) => s.trim().toLowerCase());
    return allowed.includes(level);
  } catch {
    return true;
  }
}

/**
 * Push a notification to all connected messaging channels (Telegram, Discord).
 * Respects per-platform level filters configured via settings.
 * This is best-effort — failures are silently swallowed so they never break the caller.
 */
async function pushToMessaging(title: string, message: string, level = "warning"): Promise<void> {
  const text = `🔔 *${title}*\n${message}`;

  if (platformAcceptsLevel("telegram", level)) {
    try {
      const { getTelegramBotStatus } = await import("../messaging/telegram.js");
      const telegramStatus = getTelegramBotStatus();
      if (telegramStatus.connected) {
        const telegramChats = db
          .select({ externalId: schema.conversations.externalId })
          .from(schema.conversations)
          .where(eq(schema.conversations.platform, "telegram"))
          .all();

        if (telegramChats.length > 0) {
          const telegramToken = db
            .select()
            .from(schema.settings)
            .where(eq(schema.settings.key, "telegram_bot_token"))
            .get()?.value;

          if (telegramToken) {
            const { Bot } = await import("grammy");
            const bot = new Bot(telegramToken);
            const uniqueChats = [...new Set(telegramChats.map((c) => c.externalId).filter((id): id is string => id !== null))];
            await Promise.allSettled(
              uniqueChats.map((chatId) =>
                bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" })
              )
            );
          }
        }
      }
    } catch {
      // best-effort: do not crash if telegram push fails
    }
  }

  if (platformAcceptsLevel("discord", level)) {
    try {
      const { getDiscordBotStatus } = await import("../messaging/discord-bot.js");
      const discordStatus = getDiscordBotStatus();
      if (discordStatus.connected) {
        const discordChats = db
          .select({ externalId: schema.conversations.externalId })
          .from(schema.conversations)
          .where(eq(schema.conversations.platform, "discord"))
          .all();

        if (discordChats.length > 0) {
          const { Client } = await import("discord.js");
          const discordToken = db
            .select()
            .from(schema.settings)
            .where(eq(schema.settings.key, "discord_bot_token"))
            .get()?.value;

          if (discordToken) {
            const client = new Client({ intents: [] });
            await client.login(discordToken);
            const uniqueUsers = [...new Set(discordChats.map((c) => c.externalId).filter((id): id is string => id !== null))];
            await Promise.allSettled(
              uniqueUsers.map(async (userId) => {
                const user = await client.users.fetch(userId);
                await user.send(`🔔 **${title}**\n${message}`);
              })
            );
            client.destroy();
          }
        }
      }
    } catch {
      // best-effort: do not crash if discord push fails
    }
  }
}

export { pushToMessaging };

notifications.get("/", (c) => {
  try {
    const limit = Math.min(parseInt(c.req.query("limit") || "50"), 100);
    const rows = db
      .select()
      .from(schema.notifications)
      .orderBy(desc(schema.notifications.createdAt))
      .limit(limit)
      .all();
    return c.json(rows);
  } catch (err) {
    log.error("GET / error", err);
    return c.json([]);
  }
});

notifications.get("/unread-count", (c) => {
  try {
    const row = db
      .select({ count: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(eq(schema.notifications.read, false))
      .get();
    return c.json({ count: row?.count ?? 0 });
  } catch (err) {
    log.error("GET /unread-count error", err);
    return c.json({ count: 0 });
  }
});

notifications.get("/mute-status", (c) => {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "notifications_muted"))
      .get();
    return c.json({ muted: row?.value === "true" });
  } catch (err) {
    log.error("GET /mute-status error", err);
    return c.json({ muted: false });
  }
});

notifications.post("/toggle-mute", async (c) => {
  try {
    const body = await c.req.json<{ muted?: boolean }>();
    const muted = body.muted === true;
    db.insert(schema.settings)
      .values({ key: "notifications_muted", value: String(muted) })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: String(muted) },
      })
      .run();
    return c.json({ ok: true, muted });
  } catch (err) {
    log.error("POST /toggle-mute error", err);
    return c.json({ error: "Failed to toggle mute" }, 500);
  }
});

notifications.post("/:id/read", (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    db.update(schema.notifications)
      .set({ read: true })
      .where(eq(schema.notifications.id, id))
      .run();
    return c.json({ ok: true });
  } catch (err) {
    log.error("POST /:id/read error", err);
    return c.json({ error: "Failed to mark notification as read" }, 500);
  }
});

notifications.post("/read-all", (c) => {
  try {
    db.update(schema.notifications)
      .set({ read: true })
      .where(eq(schema.notifications.read, false))
      .run();
    return c.json({ ok: true });
  } catch (err) {
    log.error("POST /read-all error", err);
    return c.json({ error: "Failed to mark all notifications as read" }, 500);
  }
});

notifications.delete("/:id", (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);
    db.delete(schema.notifications)
      .where(eq(schema.notifications.id, id))
      .run();
    return c.json({ ok: true });
  } catch (err) {
    log.error("DELETE /:id error", err);
    return c.json({ error: "Failed to delete notification" }, 500);
  }
});

export { notifications };
