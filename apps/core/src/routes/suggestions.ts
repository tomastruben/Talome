import { Hono } from "hono";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import { logAiUsage } from "../agent-loop/budget.js";

const suggestions = new Hono();

/* ── Types ───────────────────────────────────────────────────────────────── */

interface Suggestion {
  /** Short label shown in the UI (2–5 words) */
  label: string;
  /** Full prompt sent to the assistant when tapped */
  prompt: string;
}

/* ── Cache ───────────────────────────────────────────────────────────────────
 * Personalized suggestions are generated once per day via Haiku.
 */

interface CacheEntry {
  suggestions: Suggestion[];
  generatedAt: number;
}

const cache = new Map<string, CacheEntry>();
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day

/* ── Static fallbacks ────────────────────────────────────────────────────────
 * Shown when no API key, no memories, or before first generation.
 */

const FALLBACK_SUGGESTIONS: Suggestion[] = [
  { label: "Check system health", prompt: "How's my server doing?" },
  { label: "What's downloading?", prompt: "What's currently downloading?" },
  { label: "Suggest a movie tonight", prompt: "Suggest something to watch tonight" },
  { label: "Find available updates", prompt: "Are there any updates available?" },
  { label: "Set up an automation", prompt: "I want to automate something" },
  { label: "Create a custom app", prompt: "I want to create a new app" },
  { label: "What's coming this week?", prompt: "What's coming out this week?" },
  { label: "Set up notifications", prompt: "I want to get notified about things" },
];

/* ── Route ───────────────────────────────────────────────────────────────── */

suggestions.get("/", async (c) => {
  const userId = (c.get("sessionUser" as never) as string | undefined) ?? "default";

  // Return cached if still warm
  const cached = cache.get(userId);
  if (cached && Date.now() - cached.generatedAt < COOLDOWN_MS) {
    return c.json({ suggestions: cached.suggestions, source: "cache" });
  }

  // Check for API key
  const apiKey =
    db.select().from(schema.settings).where(eq(schema.settings.key, "anthropic_key")).get()?.value ||
    process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return c.json({ suggestions: FALLBACK_SUGGESTIONS, source: "fallback" });
  }

  // Gather context signals
  const memoriesRows = db
    .select()
    .from(schema.memories)
    .where(eq(schema.memories.enabled, true))
    .orderBy(desc(schema.memories.accessCount))
    .limit(15)
    .all();

  const installedRows = db
    .select({ appId: schema.installedApps.appId, status: schema.installedApps.status })
    .from(schema.installedApps)
    .all();

  const recentConversations = db
    .select({ title: schema.conversations.title })
    .from(schema.conversations)
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(5)
    .all();

  // No memories and no apps — new user, use onboarding fallbacks
  if (memoriesRows.length === 0 && installedRows.length === 0) {
    const entry: CacheEntry = { suggestions: FALLBACK_SUGGESTIONS, generatedAt: Date.now() };
    cache.set(userId, entry);
    return c.json({ suggestions: FALLBACK_SUGGESTIONS, source: "fallback" });
  }

  // Build context snapshot for Haiku
  const memoryLines = memoriesRows.map((m) => `- [${m.type}] ${m.content}`).join("\n");
  const appLines = installedRows.map((a) => `${a.appId} (${a.status})`).join(", ");
  const recentLines = recentConversations.map((c) => c.title).join(", ");

  try {
    const anthropic = createAnthropic({ apiKey });
    const model = "claude-haiku-4-5-20251001";

    const result = await generateText({
      model: anthropic(model),
      system: `You generate 8 chat suggestion chips for a home server assistant called Talome.

Each suggestion has two parts:
- "label": text shown on the chip (3–7 words). Conversational, natural. Questions or short intents. Examples: "What's downloading?", "Suggest a movie tonight", "I want to automate something".
- "prompt": a short, open-ended message (3–10 words) that starts a conversation. The AI will ask follow-up questions — the prompt should NOT over-specify. Good: "I want to automate something". Bad: "Set up an automation that checks for stalled downloads and retries or removes them automatically".

Cover a MIX of these categories (at least 5 different):
1. Health & monitoring — "How's my server doing?"
2. Media & entertainment — recommendations, calendar, what's new
3. Automations — create or review automated tasks
4. App management — updates, new apps, custom apps
5. Downloads — what's downloading, stalled items
6. Notifications — set up alerts
7. Storage & cleanup — disk usage, optimization
8. Intelligence — insights about library, patterns

Rules:
- Base on the user's installed apps, memories, and recent activity
- Reference actual app names they have when relevant
- Never suggest installing something they already have
- Tone: casual, like texting a friend. Not a sysadmin manual.
- Prompts must be SHORT and open-ended — let the assistant drive the conversation
- Output ONLY a JSON array of 8 objects with "label" and "prompt" keys`,
      prompt: `User memories:\n${memoryLines || "(none)"}\n\nInstalled apps: ${appLines || "(none)"}\n\nRecent conversations: ${recentLines || "(none)"}`,
      maxOutputTokens: 500,
    });

    logAiUsage({
      model,
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
      context: "suggestions",
    });

    let parsed: Suggestion[] = FALLBACK_SUGGESTIONS;
    try {
      const match = result.text.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(match ? match[0] : result.text);
      if (
        Array.isArray(arr) &&
        arr.length > 0 &&
        arr.every((s: unknown) =>
          typeof s === "object" && s !== null && "label" in s && "prompt" in s
        )
      ) {
        parsed = arr.slice(0, 8).map((s: Record<string, unknown>) => ({
          label: String(s.label),
          prompt: String(s.prompt),
        }));
      }
    } catch {
      // Use fallbacks on parse failure
    }

    const entry: CacheEntry = { suggestions: parsed, generatedAt: Date.now() };
    cache.set(userId, entry);

    return c.json({ suggestions: parsed, source: "personalized" });
  } catch (err) {
    console.warn("[suggestions] generation failed:", (err as Error).message);
    return c.json({ suggestions: FALLBACK_SUGGESTIONS, source: "fallback" });
  }
});

export { suggestions };
