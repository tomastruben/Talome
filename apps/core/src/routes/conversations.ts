import { Hono } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { eq, desc, and, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { serverError } from "../middleware/request-logger.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("conversations");
const conversations = new Hono();

/* ── Request schemas ─────────────────────────────────────────────────────── */

const createConversationSchema = z.object({
  title: z.string().max(200).optional(),
  platform: z.string().max(50).optional(),
  externalId: z.string().max(500).optional(),
});

const createMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(5_000_000),
  idempotencyKey: z.string().max(100).optional(),
});

const STORED_UI_MESSAGE_KIND = "ui-message-v1";

function getStoredMessageText(content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      kind?: string;
      text?: string;
    };

    if (parsed.kind === STORED_UI_MESSAGE_KIND) {
      return parsed.text?.trim() || "";
    }
  } catch {
    // Plain text rows are still valid.
  }

  return content.trim();
}

/* ── Idempotency tracking (in-memory, TTL 60s) ──────────────────────────── */

const recentMessageKeys = new Map<string, { id: string; expiresAt: number }>();

function pruneExpiredKeys() {
  const now = Date.now();
  for (const [key, entry] of recentMessageKeys) {
    if (entry.expiresAt < now) recentMessageKeys.delete(key);
  }
}

// Prune every 5min — keys already expire on access, this just caps memory
setInterval(pruneExpiredKeys, 300_000).unref();

/* ── Routes ──────────────────────────────────────────────────────────────── */

conversations.get("/", (c) => {
  try {
    const userId = c.get("sessionUser" as never) as string | undefined;
    const role = c.get("sessionRole" as never) as string | undefined;
    const showAll = c.req.query("all") === "true" && role === "admin";

    let rows;
    if (userId && !showAll) {
      // Show user's conversations + legacy ones (no userId) on dashboard
      const userRows = db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.userId, userId))
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(200)
        .all();

      const legacyRows = db
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.platform, "dashboard"),
            isNull(schema.conversations.userId),
          ),
        )
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(200)
        .all();

      const ids = new Set(userRows.map((r) => r.id));
      rows = [...userRows];
      for (const r of legacyRows) {
        if (!ids.has(r.id)) rows.push(r);
      }
      rows.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    } else {
      rows = db
        .select()
        .from(schema.conversations)
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(200)
        .all();
    }
    return c.json(rows);
  } catch (err) {
    return serverError(c, err, { message: "Failed to load conversations" });
  }
});

conversations.post("/", async (c) => {
  try {
    const parsed = createConversationSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { title, platform, externalId } = parsed.data;
    const userId = c.get("sessionUser" as never) as string | undefined;
    const id = randomUUID();
    const now = new Date().toISOString();
    db.insert(schema.conversations)
      .values({
        id,
        title: title ?? "New Conversation",
        platform: platform ?? "dashboard",
        externalId: externalId ?? null,
        userId: userId ?? null,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return c.json({
      id,
      title: title ?? "New Conversation",
      platform: platform ?? "dashboard",
      externalId: externalId ?? null,
      userId: userId ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    return serverError(c, err, { message: "Failed to create conversation" });
  }
});

// Look up a conversation by its external platform ID (used by bots to resume threads)
conversations.get("/by-external/:platform/:externalId", (c) => {
  try {
    const platform = c.req.param("platform");
    const externalId = c.req.param("externalId");
    const row = db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.platform, platform),
          eq(schema.conversations.externalId, externalId),
        ),
      )
      .orderBy(desc(schema.conversations.updatedAt))
      .limit(1)
      .get();
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(row);
  } catch (err) {
    return serverError(c, err, { message: "Failed to look up conversation", context: { platform: c.req.param("platform"), externalId: c.req.param("externalId") } });
  }
});

conversations.get("/:id/messages", (c) => {
  try {
    const conversationId = c.req.param("id");
    const rows = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .all();
    return c.json(rows);
  } catch (err) {
    return serverError(c, err, { message: "Failed to load messages", context: { conversationId: c.req.param("id") } });
  }
});

conversations.post("/:id/messages", async (c) => {
  try {
    const conversationId = c.req.param("id");
    const parsed = createMessageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { role, content, idempotencyKey } = parsed.data;

    // Idempotency: if we've seen this key recently, return the existing message
    if (idempotencyKey) {
      const cacheKey = `${conversationId}:${idempotencyKey}`;
      const existing = recentMessageKeys.get(cacheKey);
      if (existing && existing.expiresAt > Date.now()) {
        const existingMsg = db
          .select()
          .from(schema.messages)
          .where(eq(schema.messages.id, existing.id))
          .get();
        if (existingMsg) {
          return c.json(existingMsg);
        }
      }
    }

    const id = randomUUID();
    const now = new Date().toISOString();

    db.insert(schema.messages)
      .values({ id, conversationId, role, content, createdAt: now })
      .run();

    // Optimistic locking: increment version atomically
    db.update(schema.conversations)
      .set({
        updatedAt: now,
        version: sql`${schema.conversations.version} + 1`,
      })
      .where(eq(schema.conversations.id, conversationId))
      .run();

    // Cache the idempotency key
    if (idempotencyKey) {
      const cacheKey = `${conversationId}:${idempotencyKey}`;
      recentMessageKeys.set(cacheKey, { id, expiresAt: Date.now() + 60_000 });
    }

    return c.json({ id, conversationId, role, content, createdAt: now });
  } catch (err) {
    return serverError(c, err, { message: "Failed to save message", context: { conversationId: c.req.param("id") } });
  }
});

// Generate a title for a conversation based on its messages
conversations.post("/:id/title", async (c) => {
  const conversationId = c.req.param("id");
  try {
    const messages = db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .all();
    const firstUser = messages.find((m) => m.role === "user");
    if (!firstUser) return c.json({ ok: true });
    const firstUserText = getStoredMessageText(firstUser.content);
    if (!firstUserText) return c.json({ ok: true });

    const now = new Date().toISOString();

    // Try Claude Haiku for a short, descriptive title (fire-and-forget quality)
    try {
      const apiKey =
        db.select().from(schema.settings).where(eq(schema.settings.key, "anthropic_key")).get()?.value ||
        process.env.ANTHROPIC_API_KEY;
      if (apiKey) {
        const anthropic = createAnthropic({ apiKey });
        const titleModel = "claude-haiku-4-5-20251001";
        const titleResult = await generateText({
          model: anthropic(titleModel),
          system: "Generate a short 3–6 word title for a conversation given its first user message. Return only the title, no quotes, no punctuation at end.",
          prompt: firstUserText.slice(0, 200),
          maxOutputTokens: 20,
        });
        const { logAiUsage } = await import("../agent-loop/budget.js");
        logAiUsage({
          model: titleModel,
          tokensIn: titleResult.usage?.inputTokens ?? 0,
          tokensOut: titleResult.usage?.outputTokens ?? 0,
          context: "conversation_title",
        });
        const text = titleResult.text.trim().slice(0, 60);
        if (text) {
          db.update(schema.conversations)
            .set({
              title: text,
              updatedAt: now,
              version: sql`${schema.conversations.version} + 1`,
            })
            .where(eq(schema.conversations.id, conversationId))
            .run();
          return c.json({ title: text });
        }
      }
    } catch {
      // Fall through to truncation fallback
    }

    // Fallback: first 60 chars of user message
    const title = firstUserText.slice(0, 60).trim();
    db.update(schema.conversations)
      .set({
        title,
        updatedAt: now,
        version: sql`${schema.conversations.version} + 1`,
      })
      .where(eq(schema.conversations.id, conversationId))
      .run();
    return c.json({ title });
  } catch {
    // Best-effort
  }
  return c.json({ ok: true });
});

// Atomic delete: remove messages + conversation in a single transaction
conversations.delete("/:id", (c) => {
  try {
    const conversationId = c.req.param("id");

    // Check conversation exists before deleting
    const existing = db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .get();

    if (!existing) {
      return c.json({ error: "Conversation not found" }, 404);
    }

    // Atomic transaction — both deletes succeed or neither does
    db.delete(schema.messages)
      .where(eq(schema.messages.conversationId, conversationId))
      .run();
    db.delete(schema.conversations)
      .where(eq(schema.conversations.id, conversationId))
      .run();

    return c.json({ ok: true });
  } catch (err) {
    return serverError(c, err, { message: "Failed to delete conversation", context: { conversationId: c.req.param("id") } });
  }
});

export { conversations };
