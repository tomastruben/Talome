/**
 * Chat-bot lifecycle routes are admin-only: a member cannot restart a bot
 * with a different token (re-pointing which bot the owner's agent answers
 * through) or stop it. The bot tokens are protected settings, so an AI
 * set_setting of them is destructive (approval in cautious mode).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-security-bot-integrations-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

const m = vi.hoisted(() => ({
  startTelegramBot: vi.fn(async () => ({ ok: true, username: "tg_bot" })),
  stopTelegramBot: vi.fn(async () => {}),
  startDiscordBot: vi.fn(async () => ({ ok: true, username: "dc_bot" })),
  stopDiscordBot: vi.fn(async () => {}),
}));

vi.mock("../messaging/telegram.js", () => ({
  startTelegramBot: m.startTelegramBot,
  stopTelegramBot: m.stopTelegramBot,
  getTelegramBotStatus: () => ({ running: true }),
}));
vi.mock("../messaging/discord-bot.js", () => ({
  startDiscordBot: m.startDiscordBot,
  stopDiscordBot: m.stopDiscordBot,
  getDiscordBotStatus: () => ({ running: true }),
}));

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { integrations } from "../routes/integrations.js";
import { getEffectiveTier, isProtectedSettingKey } from "../ai/execution.js";

function appAs(role: "admin" | "member") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionRole" as never, role as never);
    c.set("sessionUser" as never, `${role}-1` as never);
    await next();
  });
  app.route("/", integrations);
  return app;
}

function post(app: Hono, path: string, body: unknown = {}) {
  return app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

function storedToken(key: string): string | undefined {
  return db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value;
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  db.delete(schema.settings).where(eq(schema.settings.key, "telegram_bot_token")).run();
  db.delete(schema.settings).where(eq(schema.settings.key, "discord_bot_token")).run();
});

describe("chat-bot restart/stop routes", () => {
  for (const platform of ["telegram", "discord"] as const) {
    const key = `${platform}_bot_token`;
    const start = platform === "telegram" ? m.startTelegramBot : m.startDiscordBot;
    const stop = platform === "telegram" ? m.stopTelegramBot : m.stopDiscordBot;

    it(`a member cannot swap the ${platform} bot token or stop the bot`, async () => {
      db.insert(schema.settings).values({ key, value: "owner-token" }).run();
      const member = appAs("member");

      const restart = await post(member, `/${platform}/restart`, { token: "attacker-token" });
      expect(restart.status).toBe(403);
      expect(storedToken(key)).toBe("owner-token");
      expect(start).not.toHaveBeenCalled();

      const stopped = await post(member, `/${platform}/stop`);
      expect(stopped.status).toBe(403);
      expect(stop).not.toHaveBeenCalled();

      // Status stays readable.
      expect((await member.request(`/${platform}/status`)).status).toBe(200);
    });

    it(`an admin can restart the ${platform} bot with a new token and stop it`, async () => {
      const admin = appAs("admin");
      const restart = await post(admin, `/${platform}/restart`, { token: "new-token" });
      expect(restart.status).toBe(200);
      expect(storedToken(key)).toBe("new-token");
      expect(start).toHaveBeenCalledWith("new-token");

      expect((await post(admin, `/${platform}/stop`)).status).toBe(200);
      expect(stop).toHaveBeenCalledTimes(1);
    });
  }
});

describe("bot tokens are protected settings", () => {
  it("set_setting of a bot token is destructive", () => {
    for (const key of ["telegram_bot_token", "discord_bot_token"]) {
      expect(isProtectedSettingKey(key)).toBe(true);
      expect(getEffectiveTier("set_setting", { key, value: "x" }, "modify")).toBe("destructive");
    }
  });
});
