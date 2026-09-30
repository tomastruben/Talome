import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { db, schema } from "./db/index.js";
import { desc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { logAiUsage, getBudgetZone } from "./agent-loop/budget.js";
import { createLogger } from "./utils/logger.js";
import { getSetting } from "./utils/settings.js";
import { generateTextViaClaudeCode, isClaudeCodeAvailable } from "./ai/claude-process.js";
import { fenceUntrusted } from "./ai/untrusted-data.js";
import { getSystemStats, listContainers } from "./docker/client.js";

const log = createLogger("digest");

const DIGEST_SYSTEM_PROMPT = `You are generating a concise weekly digest for a home server.
Using only the server state you are given, produce a brief summary covering:
1. **Services** — which are running, any issues
2. **Storage** — disk usage
3. **Notable events** — anything worth flagging from this week

Keep it focused, honest, and under 300 words. No fluff. Lead with anything critical.`;

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * The server state the digest is written from, gathered by Talome itself —
 * the model gets no tools. Container names, event messages and sources come
 * from apps and logs, so the caller fences all of it as untrusted.
 */
export async function gatherDigestState(): Promise<string> {
  const sections: string[] = [];

  try {
    const containers = await listContainers();
    const running = containers.filter((c) => c.status === "running");
    const notRunning = containers.filter((c) => c.status !== "running");
    sections.push(
      `Services: ${running.length} of ${containers.length} containers running.`,
      ...notRunning.slice(0, 30).map((c) => `- ${c.name}: ${c.status}`),
    );
  } catch {
    sections.push("Services: container list unavailable.");
  }

  try {
    const stats = await getSystemStats();
    sections.push(
      `Storage: ${stats.disk.percent.toFixed(0)}% used (${formatGiB(stats.disk.usedBytes)} of ${formatGiB(stats.disk.totalBytes)}).`,
      ...stats.disk.mounts.slice(0, 12).map((m) => `- ${m.mount}: ${m.percent.toFixed(0)}% of ${formatGiB(m.totalBytes)}`),
      `Memory: ${stats.memory.percent.toFixed(0)}% used. Uptime: ${Math.round(stats.uptime / 86_400)} days.`,
    );
  } catch {
    sections.push("Storage: disk usage unavailable.");
  }

  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const events = db
      .select({
        severity: schema.systemEvents.severity,
        type: schema.systemEvents.type,
        source: schema.systemEvents.source,
        message: schema.systemEvents.message,
        count: schema.systemEvents.occurrenceCount,
      })
      .from(schema.systemEvents)
      .where(sql`${schema.systemEvents.createdAt} > ${weekAgo} AND ${schema.systemEvents.severity} IN ('warning', 'critical')`)
      .orderBy(desc(schema.systemEvents.createdAt))
      .limit(25)
      .all();
    sections.push(
      events.length > 0 ? "Notable events this week:" : "Notable events this week: none.",
      ...events.map((e) => `- [${e.severity}] ${e.type} from ${e.source}${e.count > 1 ? ` (${e.count}x)` : ""}: ${e.message.slice(0, 200)}`),
    );
  } catch {
    sections.push("Notable events: unavailable.");
  }

  return sections.join("\n");
}

/** The digest request: the gathered state fenced as untrusted data. */
export function buildDigestPrompt(state: string): string {
  return `Generate this week's server digest from this server state.\n\n${fenceUntrusted(state, {
    label: "server state gathered by Talome: container names, disk usage and event messages",
    prefix: "STATE",
    maxChars: 8000,
  })}`;
}

export async function generateWeeklyDigest(): Promise<void> {
  const apiKey = getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return; // No key — skip silently
  if (getBudgetZone() === "exhausted") {
    log.info("Daily budget exhausted — skipping");
    return;
  }

  const DIGEST_MODEL = "claude-haiku-4-5-20251001";

  try {
    const prompt = buildDigestPrompt(await gatherDigestState());
    let text: string | null = null;

    if (await isClaudeCodeAvailable()) {
      const cwd = fileURLToPath(new URL("../..", import.meta.url));
      text = await generateTextViaClaudeCode(`${DIGEST_SYSTEM_PROMPT}\n\n${prompt}`, { cwd, timeoutMs: 120_000 });
      if (text) {
        logAiUsage({ model: "claude-code-local", tokensIn: 0, tokensOut: 0, context: "weekly_digest" });
        log.info("Generated digest via Claude Code (subscription)");
      }
    }

    if (!text && apiKey) {
      // No tools: the digest is written from the state gathered above.
      const result = await generateText({
        model: createAnthropic({ apiKey })(DIGEST_MODEL),
        system: DIGEST_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });
      logAiUsage({
        model: DIGEST_MODEL,
        tokensIn: result.usage?.inputTokens ?? 0,
        tokensOut: result.usage?.outputTokens ?? 0,
        context: "weekly_digest",
      });
      text = result.text;
    }

    if (!text || text.length < 50) return;

    // Store as a special conversation so it appears in conversation history
    const id = randomUUID();
    const now = new Date().toISOString();
    const weekLabel = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric" });

    db.insert(schema.conversations)
      .values({ id, title: `Weekly Digest — ${weekLabel}`, createdAt: now, updatedAt: now })
      .run();

    db.insert(schema.messages)
      .values({
        id: randomUUID(),
        conversationId: id,
        role: "assistant",
        content: text,
        createdAt: now,
      })
      .run();

    // Persist the digest id for the home widget
    db.insert(schema.settings)
      .values({ key: "latest_digest_id", value: id })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: id } })
      .run();

    db.insert(schema.settings)
      .values({ key: "latest_digest_at", value: now })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: now } })
      .run();

    log.info(`Weekly digest generated (conversation ${id})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Failed to generate digest: ${message}`);
  }
}

function getNextMondayAt9(): number {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const next = new Date(now);
  next.setDate(now.getDate() + daysUntilMonday);
  next.setHours(9, 0, 0, 0);
  return next.getTime() - now.getTime();
}

export function startDigestScheduler() {
  const msUntilNext = getNextMondayAt9();
  log.info(`Next digest in ${Math.round(msUntilNext / 3600000)}h`);

  setTimeout(function schedule() {
    generateWeeklyDigest();
    setTimeout(schedule, 7 * 24 * 60 * 60 * 1000); // repeat weekly
  }, msUntilNext);
}
