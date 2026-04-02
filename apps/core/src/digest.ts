import { generateText, stepCountIs } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { spawn } from "node:child_process";
import { activeTools } from "./ai/agent.js";
import { db, schema } from "./db/index.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { logAiUsage, getBudgetZone } from "./agent-loop/budget.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger("digest");

let _claudeAvailable: boolean | null = null;
async function isClaudeCodeAvailable(): Promise<boolean> {
  if (_claudeAvailable !== null) return _claudeAvailable;
  try {
    _claudeAvailable = await new Promise<boolean>((resolve) => {
      const proc = spawn("claude", ["--version"], { shell: false });
      proc.on("close", (code) => resolve(code === 0));
      proc.on("error", () => resolve(false));
    });
  } catch { _claudeAvailable = false; }
  return _claudeAvailable;
}

async function generateViaClaudeCode(prompt: string, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    const { ANTHROPIC_API_KEY: _s1, CLAUDECODE: _s2, ...cleanEnv } = process.env;
    const proc = spawn("claude", ["--dangerously-skip-permissions", "--print", prompt], {
      cwd, env: cleanEnv, shell: false,
    });
    const timeout = setTimeout(() => { proc.kill("SIGTERM"); resolve(null); }, 120_000);
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.on("close", () => { clearTimeout(timeout); resolve(stdout.trim() || null); });
    proc.on("error", () => { clearTimeout(timeout); resolve(null); });
  });
}

function getSetting(key: string): string | undefined {
  try {
    const row = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row?.value || undefined;
  } catch {
    return undefined;
  }
}

async function generateWeeklyDigest() {
  const apiKey = getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return; // No key — skip silently
  if (getBudgetZone() === "exhausted") {
    log.info("Daily budget exhausted — skipping");
    return;
  }

  const DIGEST_MODEL = "claude-haiku-4-5-20251001";
  const DIGEST_PROMPT = `You are generating a concise weekly digest for a home server.
Use your tools to gather current state, then produce a brief summary covering:
1. **Services** — which are running, any issues
2. **Storage** — disk usage trends
3. **Downloads** — anything completed or in progress
4. **Notable events** — anything worth flagging from this week

Keep it focused, honest, and under 300 words. No fluff. Lead with anything critical.`;

  try {
    let text: string | null = null;

    if (await isClaudeCodeAvailable()) {
      const PROJECT_ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
      const fullPrompt = `${DIGEST_PROMPT}\n\nGenerate this week's server digest. Use your Talome MCP tools to check services, storage, downloads, and recent events.`;
      text = await generateViaClaudeCode(fullPrompt, PROJECT_ROOT);
      if (text) {
        logAiUsage({ model: "claude-code-local", tokensIn: 0, tokensOut: 0, context: "weekly_digest" });
        log.info("Generated digest via Claude Code (subscription)");
      }
    }

    if (!text && apiKey) {
      const result = await generateText({
        model: createAnthropic({ apiKey })(DIGEST_MODEL),
        system: DIGEST_PROMPT,
        messages: [{ role: "user", content: "Generate this week's server digest." }],
        tools: activeTools,
        stopWhen: stepCountIs(6),
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
