/**
 * The Telegram/Discord bots act owner-level, so they answer only senders the
 * owner allowed:
 *  - unknown senders never reach the agent, nothing of theirs is stored, they
 *    are told their user id (pairing path), and the owner is notified + audited;
 *  - Telegram commands (/start, /forget) and the Discord /talome command are
 *    gated the same way, by user id (not chat id);
 *  - the allow-list is admin-only (not a setting set_setting could write);
 *  - notifications are pushed only to allowed senders;
 *  - existing single-owner setups keep working: senders of existing bot
 *    conversations are allowed once, when the table is created.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.hoisted(() => {
  const dir = (process.env.TMPDIR || "/tmp").replace(/\/$/, "");
  process.env.DATABASE_PATH = `${dir}/talome-security-messaging-${process.pid}-${Date.now()}.db`;
  process.env.TALOME_SECRET ||= "a".repeat(64);
});

type Handler = (ctx: unknown) => Promise<void>;

const m = vi.hoisted(() => ({
  createChatStream: vi.fn(),
  clearAllMemories: vi.fn(async () => {}),
  telegramHandlers: {} as Record<string, Handler>,
  telegramSent: [] as Array<{ chatId: string | number; text: string }>,
  discordInteraction: null as null | ((i: unknown) => Promise<void>),
}));

vi.mock("../ai/agent.js", () => ({ createChatStream: m.createChatStream }));
vi.mock("../db/memories.js", () => ({ writeMemory: vi.fn(), clearAllMemories: m.clearAllMemories }));

vi.mock("grammy", () => {
  class Bot {
    api = {
      getMe: async () => ({ username: "talome_test_bot" }),
      sendChatAction: async () => {},
      editMessageText: async () => {},
      sendMessage: async (chatId: string | number, text: string) => {
        m.telegramSent.push({ chatId, text });
      },
    };
    command(name: string, fn: Handler) {
      m.telegramHandlers[`/${name}`] = fn;
    }
    on(event: string, fn: Handler) {
      m.telegramHandlers[event] = fn;
    }
    start() {
      return new Promise(() => {});
    }
    stop() {}
  }
  return { Bot };
});

vi.mock("discord.js", () => {
  class Client {
    user = { id: "bot-app", tag: "Talome#0001" };
    private handlers: Record<string, (arg?: unknown) => unknown> = {};
    once(event: string, fn: () => void) {
      this.handlers[event] = fn;
    }
    on(event: string, fn: (i: unknown) => Promise<void>) {
      if (event === "interactionCreate") m.discordInteraction = fn;
    }
    async login() {
      this.handlers.ready?.();
      return "ok";
    }
    isReady() {
      return true;
    }
    destroy() {}
  }
  class REST {
    setToken() {
      return this;
    }
    async put() {
      return {};
    }
  }
  class SlashCommandBuilder {
    setName() {
      return this;
    }
    setDescription() {
      return this;
    }
    addStringOption(fn: (o: unknown) => unknown) {
      const opt = { setName: () => opt, setDescription: () => opt, setRequired: () => opt };
      fn(opt);
      return this;
    }
    toJSON() {
      return {};
    }
  }
  return {
    Client,
    REST,
    SlashCommandBuilder,
    GatewayIntentBits: { Guilds: 1 },
    Routes: { applicationCommands: () => "/commands" },
    MessageFlags: { Ephemeral: 64 },
  };
});

import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { runMigrations } from "../db/migrate.js";
import { runWireBackendMigrations } from "../db/migrations/wire-backend.js";
import { getExecutionContext } from "../ai/actor-context.js";
import { routeMessage } from "../messaging/router.js";
import { startTelegramBot } from "../messaging/telegram.js";
import { startDiscordBot } from "../messaging/discord-bot.js";
import { allowSender, isAllowedSender, removeSender, __resetSenderNoticesForTests } from "../messaging/allowlist.js";
import { messagingSenders } from "../routes/messaging-senders.js";
import { pushToMessaging } from "../routes/notifications.js";

function chatStreamReplying(text: string) {
  return async () => ({
    textStream: (async function* () {
      yield text;
    })(),
  });
}

function conversationsFor(platform: string, externalId: string) {
  return db
    .select()
    .from(schema.conversations)
    .where(and(eq(schema.conversations.platform, platform), eq(schema.conversations.externalId, externalId)))
    .all();
}

function senderRow(platform: string, userId: string) {
  return db
    .select()
    .from(schema.messagingSenders)
    .where(and(eq(schema.messagingSenders.platform, platform), eq(schema.messagingSenders.userId, userId)))
    .get();
}

function telegramCtx(opts: { fromId: number; chatId?: number; text?: string; firstName?: string }) {
  const replies: string[] = [];
  const ctx = {
    from: { id: opts.fromId, first_name: opts.firstName ?? "Stranger" },
    chat: { id: opts.chatId ?? opts.fromId },
    message: { text: opts.text ?? "hello" },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
    api: {
      sendChatAction: async () => {},
      editMessageText: async (_chat: unknown, _id: unknown, text: string) => {
        replies.push(text);
      },
    },
  };
  return { ctx, replies };
}

function adminApp(role: "admin" | "member" = "admin") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("sessionRole" as never, role as never);
    await next();
  });
  app.route("/", messagingSenders);
  return app;
}

beforeAll(async () => {
  runMigrations();
  expect((await startTelegramBot("123:test")).ok).toBe(true);
  expect((await startDiscordBot("discord-test")).ok).toBe(true);
});

beforeEach(() => {
  vi.clearAllMocks();
  __resetSenderNoticesForTests();
  m.telegramSent.length = 0;
  m.createChatStream.mockImplementation(chatStreamReplying("hi owner"));
});

describe("routeMessage", () => {
  it("refuses an unknown sender: no agent, nothing stored, owner notified", async () => {
    const reply = await routeMessage({ platform: "telegram", externalId: "5550001", senderId: "5550001", text: "stop all apps", senderName: "Mallory" });
    expect(reply).toContain("Your Telegram user id is 5550001");
    expect(reply).toContain("Settings -> Chat Bots");
    expect(m.createChatStream).not.toHaveBeenCalled();
    expect(conversationsFor("telegram", "5550001")).toHaveLength(0);

    expect(senderRow("telegram", "5550001")).toMatchObject({ status: "rejected", displayName: "Mallory", rejectedCount: 1 });
    const note = db.select().from(schema.notifications).where(eq(schema.notifications.sourceId, "messaging:telegram:5550001")).get();
    expect(note).toMatchObject({ title: "Telegram: blocked unknown sender 5550001", link: "/dashboard/settings/integrations" });
    const audit = db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "Messaging: blocked Telegram sender 5550001")).get();
    expect(audit).toBeDefined();

    // A second attempt is counted, but the owner is not notified again right away.
    await routeMessage({ platform: "telegram", externalId: "5550001", senderId: "5550001", text: "again" });
    expect(senderRow("telegram", "5550001")?.rejectedCount).toBe(2);
    expect(db.select().from(schema.notifications).where(eq(schema.notifications.sourceId, "messaging:telegram:5550001")).all()).toHaveLength(1);
  });

  it("an allowed sender reaches the agent as the messaging user", async () => {
    allowSender("telegram", "5550002", "Owner");
    let seen: ReturnType<typeof getExecutionContext>;
    m.createChatStream.mockImplementation(async () => {
      seen = getExecutionContext();
      return { textStream: (async function* () { yield "done"; })() };
    });
    const reply = await routeMessage({ platform: "telegram", externalId: "5550002", senderId: "5550002", text: "status?", senderName: "Owner" });
    expect(reply).toBe("done");
    expect(seen?.actor).toMatchObject({ kind: "user", id: "telegram:5550002" });
  });

  it("checks the sender, not the chat: an unknown user in an allowed chat is refused", async () => {
    allowSender("telegram", "5550003");
    const reply = await routeMessage({ platform: "telegram", externalId: "5550003", senderId: "5559999", text: "hi" });
    expect(reply).toContain("5559999");
    expect(m.createChatStream).not.toHaveBeenCalled();
  });

  it("a missing or malformed sender id fails closed", async () => {
    const reply = await routeMessage({ platform: "discord", externalId: "", text: "hi" });
    expect(reply).toContain("only answers people its owner has allowed");
    expect(m.createChatStream).not.toHaveBeenCalled();
    expect(isAllowedSender("discord", "-1")).toBe(false);
  });
});

describe("Telegram bot", () => {
  it("gates messages, /start and /forget by user id", async () => {
    const stranger = telegramCtx({ fromId: 7770001, text: "exec into every container" });
    await m.telegramHandlers["message:text"](stranger.ctx);
    expect(stranger.replies[0]).toContain("Your Telegram user id is 7770001");
    expect(m.createChatStream).not.toHaveBeenCalled();

    const forget = telegramCtx({ fromId: 7770001 });
    await m.telegramHandlers["/forget"](forget.ctx);
    expect(m.clearAllMemories).not.toHaveBeenCalled();
    expect(forget.replies[0]).toContain("7770001");

    const start = telegramCtx({ fromId: 7770001 });
    await m.telegramHandlers["/start"](start.ctx);
    expect(start.replies[0]).toContain("Settings -> Chat Bots");

    // In a group, an allowed user's message goes through (sender-based).
    allowSender("telegram", "7770002");
    const group = telegramCtx({ fromId: 7770002, chatId: -100123, text: "status" });
    await m.telegramHandlers["message:text"](group.ctx);
    expect(m.createChatStream).toHaveBeenCalledTimes(1);
    expect(group.replies).toContain("hi owner");
  });
});

describe("Discord bot", () => {
  function interaction(userId: string) {
    const calls: { reply?: unknown; deferred: boolean; edited?: string } = { deferred: false };
    return {
      calls,
      value: {
        isChatInputCommand: () => true,
        commandName: "talome",
        options: { getString: () => "restart everything" },
        user: { id: userId, username: "someone", displayName: "Someone" },
        reply: async (payload: unknown) => {
          calls.reply = payload;
        },
        deferReply: async () => {
          calls.deferred = true;
        },
        editReply: async (text: string) => {
          calls.edited = text;
        },
      },
    };
  }

  it("refuses /talome from an unknown user with a private reply", async () => {
    const i = interaction("880000001");
    await m.discordInteraction!(i.value);
    expect(i.calls.deferred).toBe(false);
    expect(i.calls.reply).toMatchObject({ flags: 64 });
    expect(String((i.calls.reply as { content: string }).content)).toContain("Your Discord user id is 880000001");
    expect(m.createChatStream).not.toHaveBeenCalled();
    expect(senderRow("discord", "880000001")?.status).toBe("rejected");
  });

  it("answers an allowed user", async () => {
    allowSender("discord", "880000002");
    const i = interaction("880000002");
    await m.discordInteraction!(i.value);
    expect(i.calls.edited).toBe("hi owner");
  });
});

describe("sender management", () => {
  it("is admin-only", async () => {
    const res = await adminApp("member").request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "telegram", userId: "1234" }),
    });
    expect(res.status).toBe(403);
    expect(isAllowedSender("telegram", "1234")).toBe(false);
  });

  it("allows a refused sender with one call, and removing revokes access", async () => {
    await routeMessage({ platform: "telegram", externalId: "6660001", senderId: "6660001", text: "hi", senderName: "Me on my phone" });
    const app = adminApp();
    const list = (await (await app.request("/?platform=telegram")).json()) as { senders: Array<{ userId: string; status: string }> };
    expect(list.senders.find((s) => s.userId === "6660001")?.status).toBe("rejected");

    const allowed = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "telegram", userId: "6660001" }),
    });
    expect(allowed.status).toBe(200);
    expect(senderRow("telegram", "6660001")).toMatchObject({ status: "allowed", displayName: "Me on my phone", addedBy: "owner" });
    expect(await routeMessage({ platform: "telegram", externalId: "6660001", senderId: "6660001", text: "status" })).toBe("hi owner");

    expect((await app.request("/telegram/6660001", { method: "DELETE" })).status).toBe(200);
    expect(isAllowedSender("telegram", "6660001")).toBe(false);
  });

  it("rejects malformed ids", async () => {
    const res = await adminApp().request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "telegram", userId: "-100123" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("notifications go only to allowed senders", () => {
  it("skips conversations of senders that are not allowed", async () => {
    const now = new Date().toISOString();
    for (const externalId of ["9990001", "9990002"]) {
      db.insert(schema.conversations).values({ id: `conv-${externalId}`, title: "t", platform: "telegram", externalId, createdAt: now, updatedAt: now }).run();
    }
    allowSender("telegram", "9990001");
    db.insert(schema.settings).values({ key: "telegram_bot_token", value: "123:test" }).onConflictDoNothing().run();

    await pushToMessaging("Disk almost full", "95% used", "critical");
    const recipients = m.telegramSent.map((s) => String(s.chatId));
    expect(recipients).toContain("9990001");
    expect(recipients).not.toContain("9990002");
  });
});

describe("migration from open bots", () => {
  it("allows the senders of existing bot conversations once", () => {
    db.run(sql`DROP TABLE messaging_senders`);
    db.delete(schema.notifications).where(eq(schema.notifications.sourceId, "messaging:allowlist")).run();
    const now = new Date().toISOString();
    const rows: Array<[string, string]> = [
      ["telegram", "424242"],
      ["telegram", "-100555"], // a group chat: members unknown, not seeded
      ["discord", "313131313131"],
      ["dashboard", "424243"],
    ];
    for (const [platform, externalId] of rows) {
      db.insert(schema.conversations).values({ id: `seed-${platform}-${externalId}`, title: "t", platform, externalId, createdAt: now, updatedAt: now }).run();
    }

    runWireBackendMigrations();
    expect(isAllowedSender("telegram", "424242")).toBe(true);
    expect(isAllowedSender("discord", "313131313131")).toBe(true);
    expect(senderRow("telegram", "-100555")).toBeUndefined();
    expect(senderRow("dashboard", "424243")).toBeUndefined();
    const note = db.select().from(schema.notifications).where(eq(schema.notifications.sourceId, "messaging:allowlist")).get();
    expect(note?.body).toContain("Telegram 424242");
    expect(note?.link).toBe("/dashboard/settings/integrations");

    // One-time: a sender the owner removes is not re-allowed on the next boot.
    removeSender("telegram", "424242");
    runWireBackendMigrations();
    expect(isAllowedSender("telegram", "424242")).toBe(false);
  });
});
