import { Bot, type Context } from "grammy";
import { routeMessage } from "./router.js";

let activeBotInstance: Bot | null = null;
let activeBotUsername: string | null = null;

export function getTelegramBotStatus(): { connected: boolean; username?: string } {
  if (activeBotInstance && activeBotUsername) {
    return { connected: true, username: activeBotUsername };
  }
  return { connected: false };
}

export async function stopTelegramBot(): Promise<void> {
  if (activeBotInstance) {
    try {
      activeBotInstance.stop();
    } catch {
      // Best-effort stop
    }
    activeBotInstance = null;
    activeBotUsername = null;
    console.log("[telegram] Bot stopped");
  }
}

export async function startTelegramBot(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  // Stop any existing instance first
  await stopTelegramBot();

  try {
    const bot = new Bot(token);

    // /start command — greet and establish conversation
    bot.command("start", async (ctx: Context) => {
      await ctx.reply(
        "Hi! I'm Talome, your home server AI. Ask me anything about your containers, apps, media, or system health.",
      );
    });

    // /forget command — clear memories
    bot.command("forget", async (ctx: Context) => {
      try {
        const { db, schema } = await import("../db/index.js");
        const { eq } = await import("drizzle-orm");
        const { clearAllMemories } = await import("../db/memories.js");
        const enabledRow = db
          .select()
          .from(schema.settings)
          .where(eq(schema.settings.key, "memory_enabled"))
          .get();
        if (enabledRow?.value === "false") {
          await ctx.reply("Memory is disabled — nothing to forget.");
          return;
        }
        await clearAllMemories();
        await ctx.reply("Done. I've cleared all stored memories.");
      } catch (err) {
        await ctx.reply("Failed to clear memories. Please try again.");
        console.error("[telegram] forget error:", err);
      }
    });

    // Route all plain text messages through the agent
    bot.on("message:text", async (ctx: Context) => {
      const text = ctx.message?.text;
      if (!text || text.startsWith("/")) return;

      const chatId = String(ctx.chat?.id ?? "unknown");
      const senderName =
        ctx.from?.first_name
          ? `${ctx.from.first_name}${ctx.from?.last_name ? " " + ctx.from.last_name : ""}`
          : ctx.from?.username;

      // Send a typing indicator and placeholder so the user gets instant feedback
      await ctx.api.sendChatAction(ctx.chat!.id, "typing");

      let sentMsg: { message_id: number } | undefined;
      try {
        sentMsg = await ctx.reply("…");
      } catch {
        // Non-fatal — we'll still try to send the final reply
      }

      try {
        const response = await routeMessage({
          platform: "telegram",
          externalId: chatId,
          text,
          senderName,
        });

        if (sentMsg) {
          await ctx.api.editMessageText(ctx.chat!.id, sentMsg.message_id, response);
        } else {
          await ctx.reply(response);
        }
      } catch (err) {
        const errorText = "Sorry, something went wrong. Please try again.";
        if (sentMsg) {
          await ctx.api.editMessageText(ctx.chat!.id, sentMsg.message_id, errorText).catch(() =>
            ctx.reply(errorText),
          );
        } else {
          await ctx.reply(errorText);
        }
        console.error("[telegram] message handling error:", err);
      }
    });

    // Validate token and get bot info before committing
    const me = await bot.api.getMe();
    activeBotUsername = me.username ?? null;

    // Start long polling in the background (non-blocking)
    bot.start({
      onStart: (info) => {
        console.log(`[telegram] Bot @${info.username} is running`);
      },
    }).catch((err) => {
      console.error("[telegram] Bot polling error:", err);
      activeBotInstance = null;
      activeBotUsername = null;
    });

    activeBotInstance = bot;
    return { ok: true, username: me.username };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("[telegram] Failed to start bot:", error);
    return { ok: false, error };
  }
}
