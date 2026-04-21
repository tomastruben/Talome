import { db, schema } from "../db/index.js";
import { eq, and, desc } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { createChatStream } from "../ai/agent.js";
import { writeMemory } from "../db/memories.js";
import type { UIMessage } from "ai";

export interface InboundMessage {
  platform: "telegram" | "discord";
  externalId: string;
  text: string;
  senderName?: string;
}

// Find an existing conversation for this platform + externalId, or create one.
function ensureConversation(platform: string, externalId: string, firstMessage: string): string {
  const existing = db
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

  if (existing) return existing.id;

  const id = randomUUID();
  const now = new Date().toISOString();
  const title = firstMessage.slice(0, 60).trim() || "New Conversation";
  db.insert(schema.conversations)
    .values({ id, title, platform, externalId, createdAt: now, updatedAt: now })
    .run();
  return id;
}

// Load all messages for a conversation as UIMessages for the agent.
function loadMessages(conversationId: string): UIMessage[] {
  const rows = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .all();
  return rows.map((m) => ({
    id: m.id,
    role: m.role as "user" | "assistant",
    parts: [{ type: "text" as const, text: m.content }],
    createdAt: new Date(m.createdAt),
  }));
}

function persistMessage(conversationId: string, role: "user" | "assistant", content: string) {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.insert(schema.messages)
    .values({ id, conversationId, role, content, createdAt: now })
    .run();
  db.update(schema.conversations)
    .set({ updatedAt: now })
    .where(eq(schema.conversations.id, conversationId))
    .run();
}

async function extractMemoriesBackground(conversationId: string, text: string) {
  if (text.length <= 100) return;
  try {
    const { generateText } = await import("ai");
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    const apiKey =
      db.select().from(schema.settings).where(eq(schema.settings.key, "anthropic_key")).get()
        ?.value || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return;

    const enabledRow = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "memory_enabled"))
      .get();
    if (enabledRow?.value === "false") return;

    const anthropic = createAnthropic({ apiKey });
    const memModel = "claude-haiku-4-5-20251001";
    const memResult = await generateText({
      model: anthropic(memModel),
      system: `Extract 0–3 memorable facts from this assistant response. Output ONLY a JSON array of { "type": "preference"|"fact"|"context"|"correction", "content": "<one sentence>", "confidence": 0.0–1.0 }. If nothing worth remembering, output [].`,
      prompt: text.slice(0, 2000),
    });
    const { logAiUsage } = await import("../agent-loop/budget.js");
    logAiUsage({
      model: memModel,
      tokensIn: memResult.usage?.inputTokens ?? 0,
      tokensOut: memResult.usage?.outputTokens ?? 0,
      context: "memory_extraction",
    });
    const raw = memResult.text;
    let items: { type: string; content: string; confidence: number }[] = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      items = JSON.parse(match ? match[0] : raw);
    } catch {
      return;
    }
    for (const item of items) {
      if (item.content && item.type) {
        await writeMemory(
          item.type as "preference" | "fact" | "context" | "correction",
          item.content,
          conversationId,
          item.confidence ?? 1.0,
        );
      }
    }
  } catch (err: any) {
    const msg = err?.lastError?.message || err?.message || "Unknown error";
    const code = err?.lastError?.statusCode || err?.statusCode || "";
    console.warn(`[router] memory extraction failed: ${msg}${code ? ` (${code})` : ""}`);
  }
}

export async function routeMessage(msg: InboundMessage): Promise<string> {
  const { platform, externalId, text, senderName } = msg;

  const conversationId = ensureConversation(platform, externalId, text);
  persistMessage(conversationId, "user", text);

  const messages = loadMessages(conversationId);
  const context = `Platform: ${platform}${senderName ? `, user: ${senderName}` : ""}. Respond in plain text (no markdown, no backtick code blocks — the user is reading this in a chat app).`;

  const result = await createChatStream(messages, context);

  // Collect all streamed text chunks
  let fullText = "";
  for await (const chunk of result.textStream) {
    fullText += chunk;
  }

  if (fullText) {
    persistMessage(conversationId, "assistant", fullText);
    // Background memory extraction — do not await
    extractMemoriesBackground(conversationId, fullText).catch(() => {});
  }

  return fullText || "Sorry, I couldn't generate a response.";
}
