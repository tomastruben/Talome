import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { spawn } from "node:child_process";
import { db, schema } from "./db/index.js";
import { desc, eq } from "drizzle-orm";
import { logAiUsage, shouldRunService, isInStartupGrace } from "./agent-loop/budget.js";
import { createLogger } from "./utils/logger.js";

const activityLog = createLogger("activity-summary");

const ACTIVITY_MODEL = "claude-haiku-4-5-20251001";

let _claudeAvailable: boolean | null = null;
async function isClaudeCodeAvailable(): Promise<boolean> {
  if (_claudeAvailable !== null) return _claudeAvailable;
  try {
    _claudeAvailable = await new Promise<boolean>((resolve) => {
      const proc = spawn("claude", ["--version"], { shell: false });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node regression: ChildProcess lost .on()
      const p = proc as any;
      p.on("close", (code: number | null) => resolve(code === 0));
      p.on("error", () => resolve(false));
    });
  } catch { _claudeAvailable = false; }
  return _claudeAvailable;
}

async function generateViaClaudeCode(systemPrompt: string, userPrompt: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    const { ANTHROPIC_API_KEY: _s1, CLAUDECODE: _s2, ...cleanEnv } = process.env;
    const proc = spawn("claude", ["--dangerously-skip-permissions", "--print", `${systemPrompt}\n\n${userPrompt}`], {
      cwd: process.cwd(), env: cleanEnv, shell: false,
    });
    const timeout = setTimeout(() => { proc.kill("SIGTERM"); resolve(null); }, 30_000);
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node regression: ChildProcess lost .on()
    const p2 = proc as any;
    p2.on("close", () => { clearTimeout(timeout); resolve(stdout.trim() || null); });
    p2.on("error", () => { clearTimeout(timeout); resolve(null); });
  });
}

async function generateActivitySummary(): Promise<void> {
  if (isInStartupGrace()) return;
  const zoneCheck = shouldRunService("activity_summary");
  if (!zoneCheck.allowed) {
    activityLog.info(`${zoneCheck.reason} — skipping`);
    return;
  }

  try {
    const apiKey =
      process.env.ANTHROPIC_API_KEY ||
      db.select().from(schema.settings).where(eq(schema.settings.key, "anthropic_key")).get()?.value;

    if (!apiKey) return;

    // Skip if a summary was generated recently (< 30 min ago) — prevents restart spam
    try {
      const lastAt = db.select().from(schema.settings).where(eq(schema.settings.key, "activity_summary_at")).get();
      if (lastAt?.value && Date.now() - new Date(lastAt.value).getTime() < 30 * 60 * 1000) return;
    } catch { /* ignore */ }

    const entries = db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(50)
      .all();

    if (entries.length === 0) return;

    const log = entries
      .map((e) => `[${e.timestamp}] ${e.action} ${e.details} (${e.tier})`)
      .join("\n");

    const systemPrompt = "You summarise server activity logs into exactly 3 concise bullet points (one sentence each, starting with '•'). Focus on what changed, what's notable, what needs attention. Be specific — include container names, app names, sizes. No intro text, no outro.";
    const userPrompt = `Recent activity:\n${log}`;

    let summary: string | null = null;
    if (await isClaudeCodeAvailable()) {
      summary = await generateViaClaudeCode(systemPrompt, userPrompt);
      if (summary) {
        logAiUsage({ model: "claude-code-local", tokensIn: 0, tokensOut: 0, context: "activity_summary" });
        activityLog.info("Generated summary via Claude Code (subscription)");
      }
    }

    if (!summary) {
      const anthropic = createAnthropic({ apiKey });
      const result = await generateText({
        model: anthropic(ACTIVITY_MODEL),
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: 150,
      });
      logAiUsage({
        model: ACTIVITY_MODEL,
        tokensIn: result.usage?.inputTokens ?? 0,
        tokensOut: result.usage?.outputTokens ?? 0,
        context: "activity_summary",
      });
      summary = result.text.trim();
    }
    if (!summary) return;

    const now = new Date().toISOString();
    db.insert(schema.settings)
      .values({ key: "activity_summary", value: summary })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: summary } })
      .run();
    db.insert(schema.settings)
      .values({ key: "activity_summary_at", value: now })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: now } })
      .run();

    activityLog.info("Generated summary");
  } catch (err: unknown) {
    const e = err as Record<string, Record<string, unknown> | undefined>;
    const msg = (e?.lastError?.message ?? (err instanceof Error ? err.message : null)) || "Unknown error";
    const code = (e?.lastError?.statusCode ?? (e as Record<string, unknown>)?.statusCode) || "";
    activityLog.warn(`Failed: ${msg}${code ? ` (${code})` : ""}`);
  }
}

let intervalId: ReturnType<typeof setInterval> | undefined;

export function startActivitySummaryScheduler(): void {
  // Delay first run to avoid restart spam (startup grace handles the rest)
  setTimeout(() => generateActivitySummary(), 90_000);

  // Then run every hour
  intervalId = setInterval(() => {
    generateActivitySummary();
  }, 3_600_000);
}

export function stopActivitySummaryScheduler(): void {
  if (intervalId !== undefined) {
    clearInterval(intervalId);
    intervalId = undefined;
  }
}
