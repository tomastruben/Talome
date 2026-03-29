import { Hono } from "hono";
import { z } from "zod";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { writeMemory, deleteMemory, clearAllMemories } from "../db/memories.js";

const memories = new Hono();

/* ── Request schemas ─────────────────────────────────────────────────────── */

const createMemorySchema = z.object({
  type: z.enum(["preference", "fact", "context", "correction"]),
  content: z.string().min(1).max(5000),
});

const updateMemorySchema = z.object({
  content: z.string().min(1).max(5000).optional(),
  enabled: z.boolean().optional(),
});

const memoryEnabledSchema = z.object({
  enabled: z.boolean(),
});

const extractMemorySchema = z.object({
  conversationId: z.string().min(1).max(200),
  text: z.string().min(1).max(50_000),
});

// ── List all memories ────────────────────────────────────────────────────────
memories.get("/", (c) => {
  try {
    const rows = db
      .select()
      .from(schema.memories)
      .orderBy(desc(schema.memories.createdAt))
      .all();
    return c.json(rows);
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Manual create ────────────────────────────────────────────────────────────
memories.post("/", async (c) => {
  try {
    const parsed = createMemorySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { type, content } = parsed.data;
    await writeMemory(type, content);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Edit a memory ────────────────────────────────────────────────────────────
memories.put("/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    const parsed = updateMemorySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { content, enabled } = parsed.data;
    const now = new Date().toISOString();
    db.update(schema.memories)
      .set({
        ...(content !== undefined ? { content } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        updatedAt: now,
      })
      .where(eq(schema.memories.id, id))
      .run();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Delete a single memory ───────────────────────────────────────────────────
memories.delete("/:id", async (c) => {
  try {
    const id = Number(c.req.param("id"));
    await deleteMemory(id);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Clear all memories ───────────────────────────────────────────────────────
memories.delete("/", async (c) => {
  const confirm = c.req.query("confirm");
  if (confirm !== "true") return c.json({ error: "Pass ?confirm=true to clear all memories" }, 400);
  try {
    await clearAllMemories();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Memory enabled toggle (stored in settings table) ────────────────────────
memories.get("/enabled", (c) => {
  try {
    const row = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "memory_enabled"))
      .get();
    const enabled = row ? row.value !== "false" : true;
    return c.json({ enabled });
  } catch {
    return c.json({ enabled: true });
  }
});

memories.post("/enabled", async (c) => {
  try {
    const parsed = memoryEnabledSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { enabled } = parsed.data;
    const value = enabled ? "true" : "false";
    db.insert(schema.settings)
      .values({ key: "memory_enabled", value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: String(err) }, 500);
  }
});

// ── Background memory extraction from a conversation ────────────────────────
memories.post("/extract", async (c) => {
  try {
    const parsed = extractMemorySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { conversationId, text } = parsed.data;

    // Check if memory is enabled
    const enabledRow = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "memory_enabled"))
      .get();
    if (enabledRow && enabledRow.value === "false") {
      return c.json({ ok: true, skipped: true });
    }

    const apiKey =
      db.select().from(schema.settings).where(eq(schema.settings.key, "anthropic_key")).get()
        ?.value || process.env.ANTHROPIC_API_KEY;

    if (!apiKey) return c.json({ ok: true, skipped: true });

    const anthropic = createAnthropic({ apiKey });
    const memModel = "claude-haiku-4-5-20251001";

    const memResult = await generateText({
      model: anthropic(memModel),
      system: `You extract memorable facts from AI assistant conversations.
Output ONLY a JSON array of 0–3 objects, no markdown, no explanation.
Each object: { "type": "preference"|"fact"|"context"|"correction", "content": "<one sentence>", "confidence": 0.0–1.0 }
Rules:
- type "preference": user preferences or habits ("User prefers Sonarr over manual downloads")
- type "fact": objective facts about their setup ("The server hostname is homelab")
- type "context": situational context ("User is setting up a new media server")
- type "correction": user corrected the assistant ("The correct port is 8096, not 8080")
- Only extract things genuinely worth remembering across sessions
- Skip pleasantries, greetings, one-off questions
- If nothing is worth remembering, output []`,
      prompt: `Extract memorable facts from this assistant response:\n\n${text.slice(0, 2000)}`,
    });

    const { logAiUsage } = await import("../agent-loop/budget.js");
    logAiUsage({
      model: memModel,
      tokensIn: memResult.usage?.inputTokens ?? 0,
      tokensOut: memResult.usage?.outputTokens ?? 0,
      context: "memory_extraction",
    });

    const raw = memResult.text;

    let extracted: { type: string; content: string; confidence: number }[] = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      extracted = JSON.parse(match ? match[0] : raw);
    } catch {
      return c.json({ ok: true, extracted: 0 });
    }

    let saved = 0;
    for (const item of extracted) {
      if (item.content && item.type) {
        await writeMemory(
          item.type as "preference" | "fact" | "context" | "correction",
          item.content,
          conversationId,
          item.confidence ?? 1.0,
        );
        saved++;
      }
    }

    return c.json({ ok: true, extracted: saved });
  } catch (err) {
    const e = err as any;
    const msg = e?.lastError?.message || e?.message || "Unknown error";
    const code = e?.lastError?.statusCode || e?.statusCode || "";
    console.warn(`[memories] extract failed: ${msg}${code ? ` (${code})` : ""}`);
    return c.json({ ok: true, extracted: 0 });
  }
});

export { memories };
