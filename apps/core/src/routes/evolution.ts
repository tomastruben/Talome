import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import { generateObject, generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { eq, desc } from "drizzle-orm";
import { readEvolutionLog } from "../ai/tools/claude-code-tool.js";
import { PROJECT_ROOT } from "../ai/tools/claude-code-tool.js";
import { addEvolutionListener, emitEvolutionEvent, storeRunResult } from "../ai/evolution-emitter.js";
import { generateSuggestions } from "../evolution/suggest.js";
import { reapDeadWorkers } from "../evolution/auto-execute.js";
import { getChangedFiles, runTypecheck, stashRollback, spawnProcess } from "../ai/claude-process.js";
import { saveScreenshots } from "../ai/claude-runner.js";
import { logAiUsage } from "../agent-loop/budget.js";
import { writeNotification } from "../db/notifications.js";
import { writeAuditEntry } from "../db/audit.js";
import { db, schema } from "../db/index.js";
import { scheduleEvolutionRestart } from "../evolution-restart.js";
import { join, basename, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { existsSync, renameSync, rmSync, cpSync } from "node:fs";
import { createLogger } from "../utils/logger.js";
import { getSetting } from "../utils/settings.js";

const log = createLogger("evolution");

export { waitForRunResult } from "../ai/evolution-emitter.js";

const IS_DEV_MODE = process.env.TSX === "1" || process.env.NODE_ENV === "development";

/**
 * Compile backend (types → core) and schedule a graceful restart.
 * Used by both the /complete endpoint (Terminal mode) and the internal-event handler (Headless mode).
 * Runs asynchronously — callers should fire-and-forget with `void`.
 */
async function rebuildAndRestartBackend(filesChanged: string[], runId: string): Promise<void> {
  const typesDir = join(PROJECT_ROOT, "packages/types");
  const coreDir = join(PROJECT_ROOT, "apps/core");

  try {
    emitEvolutionEvent({ type: "backend_rebuild_started", runId });

    // Rebuild types first if changed (core depends on types dist/)
    if (filesChanged.some((f) => f.startsWith("packages/types/"))) {
      execSync("pnpm exec tsc", { cwd: typesDir, encoding: "utf8", timeout: 30_000, stdio: "pipe" });
    }

    // Compile core src/ → dist/
    execSync("pnpm exec tsc", { cwd: coreDir, encoding: "utf8", timeout: 60_000, stdio: "pipe" });

    emitEvolutionEvent({ type: "backend_rebuild_complete", runId });
    scheduleEvolutionRestart();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitEvolutionEvent({ type: "backend_rebuild_failed", runId, error: msg.slice(0, 500) });
  }
}

export const evolution = new Hono();

// ── Server mode (dev ↔ build) ────────────────────────────────────────────────
// Mode file read by scripts/start-core.sh to decide tsx watch vs node dist/.

const SERVER_MODE_FILE = join(homedir(), ".talome", "server-mode");

evolution.get("/server-mode", async (c) => {
  try {
    let mode = "build";
    try {
      mode = (await readFile(SERVER_MODE_FILE, "utf8")).trim();
      if (mode !== "dev" && mode !== "build") mode = "build";
    } catch {
      // File doesn't exist → default to build
    }
    const isLive = process.env.TSX === "1";
    // Mode switching only works when started via scripts/start-core.sh (sets TALOME_MANAGED=1).
    // When started via `pnpm dev` (turbo/tsx), the process manager doesn't read the mode file.
    const managed = process.env.TALOME_MANAGED === "1";
    return c.json({ mode, active: isLive ? "dev" : "build", managed });
  } catch (err) {
    console.error("[evolution] GET /server-mode error:", err);
    return c.json({ mode: "build", active: "build", managed: false });
  }
});

evolution.post("/server-mode", async (c) => {
  const parsed = z.object({
    mode: z.enum(["dev", "build"]),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Invalid mode" }, 400);
  const body = parsed.data;

  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(homedir(), ".talome"), { recursive: true });

  // When switching to build, compile first so dist/ is fresh.
  // Only write mode file if compilation succeeds — prevents divergence.
  if (body.mode === "build" && process.env.TSX === "1") {
    try {
      const typesDir = join(PROJECT_ROOT, "packages/types");
      const coreDir = join(PROJECT_ROOT, "apps/core");
      execSync("pnpm exec tsc", { cwd: typesDir, encoding: "utf8", timeout: 30_000, stdio: "pipe" });
      execSync("pnpm exec tsc", { cwd: coreDir, encoding: "utf8", timeout: 60_000, stdio: "pipe" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: "Compilation failed — mode not switched", details: msg.slice(0, 500) }, 500);
    }
  }

  await writeFile(SERVER_MODE_FILE, body.mode, "utf8");
  writeAuditEntry("AI: server_mode", "destructive", `Switched to ${body.mode} mode`);

  // Restart so the wrapper picks up the new mode
  scheduleEvolutionRestart();

  return c.json({ ok: true, mode: body.mode, restarting: true });
});

// ── GET /api/evolution/history ────────────────────────────────────────────────

evolution.get("/history", async (c) => {
  try {
    const limit = Number(c.req.query("limit") ?? "50");
    const entries = await readEvolutionLog(Math.min(limit, 200));
    return c.json({ entries, count: entries.length });
  } catch (err) {
    console.error("[evolution] GET /history error:", err);
    return c.json({ entries: [], count: 0, error: String(err) }, 500);
  }
});

// ── GET /api/evolution/runs/:id — single run with diff ───────────────────────

evolution.get("/runs/:id", (c) => {
  try {
    const id = c.req.param("id");
    const run = db
      .select()
      .from(schema.evolutionRuns)
      .where(eq(schema.evolutionRuns.id, id))
      .get();

    if (!run) return c.json({ error: "Run not found" }, 404);

    let filesChanged: string[] = [];
    try { filesChanged = JSON.parse(run.filesChanged || "[]"); } catch { /* */ }

    return c.json({ ...run, filesChanged });
  } catch (err) {
    console.error("[evolution] GET /runs/:id error:", err);
    return c.json({ error: "Failed to load run" }, 500);
  }
});

// ── POST /api/evolution/internal-event — worker loopback ─────────────────────

evolution.post("/internal-event", async (c) => {
  const event = await c.req.json() as Record<string, unknown>;

  if (event.type === "plan_result" || event.type === "apply_result") {
    const runId = event.runId as string | undefined;
    if (runId) {
      storeRunResult(runId, event);
    }
  }

  emitEvolutionEvent(event as unknown as Parameters<typeof emitEvolutionEvent>[0]);

  // Worker compiled new dist/ — schedule a graceful restart to load the new code.
  // The worker is detached and survives this restart; results are already in SQLite.
  if (event.type === "backend_rebuild_complete") {
    scheduleEvolutionRestart();
  }

  return c.json({ ok: true });
});

// ── GET /api/evolution/stream — SSE ──────────────────────────────────────────

evolution.get("/stream", (c) => {
  c.header("Content-Type", "text/event-stream");
  c.header("Cache-Control", "no-cache");
  c.header("Connection", "keep-alive");
  c.header("X-Accel-Buffering", "no");

  return stream(c, async (s) => {
    await s.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    let closed = false;

    const unsubscribe = addEvolutionListener(async (event) => {
      if (closed) return;
      try {
        await s.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    });

    const heartbeat = setInterval(async () => {
      if (closed) {
        clearInterval(heartbeat);
        return;
      }
      try {
        await s.write(`: heartbeat\n\n`);
      } catch {
        closed = true;
        clearInterval(heartbeat);
      }
    }, 20_000);

    await new Promise<void>((resolve) => {
      s.onAbort(() => {
        closed = true;
        resolve();
      });
    });

    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ── GET /api/evolution/git-head — current HEAD hash ──────────────────────────

evolution.get("/git-head", async (c) => {
  try {
    const { stdout } = await spawnProcess("git", ["rev-parse", "HEAD"], PROJECT_ROOT);
    return c.json({ hash: stdout.trim() });
  } catch (err) {
    console.error("[evolution] GET /git-head error:", err);
    return c.json({ hash: null });
  }
});

// ── Suggestions ──────────────────────────────────────────────────────────────

// GET /api/evolution/suggestions
evolution.get("/suggestions", (c) => {
  try {
    // Reconcile any workers that died without updating the DB, so the
    // frontend never sees a stale "in_progress" task with a dead process.
    const statusFilter = c.req.query("status");
    if (statusFilter === "in_progress") {
      reapDeadWorkers();
    }

    const query = db
      .select()
      .from(schema.evolutionSuggestions)
      .orderBy(desc(schema.evolutionSuggestions.createdAt));

    const rows = statusFilter
      ? query.where(eq(schema.evolutionSuggestions.status, statusFilter as "pending")).all()
      : query.all();

    return c.json({
      suggestions: rows.map((r) => ({
        ...r,
        sourceSignals: (() => { try { return JSON.parse(r.sourceSignals) as string[]; } catch { return []; } })(),
        screenshots: (() => { try { return JSON.parse(r.screenshots ?? "[]") as string[]; } catch { return []; } })(),
      })),
    });
  } catch (err) {
    console.error("[evolution] GET /suggestions error:", err);
    return c.json({ suggestions: [], error: String(err) }, 500);
  }
});

// POST /api/evolution/suggestions/generate — trigger scan
evolution.post("/suggestions/generate", async (c) => {
  try {
    const result = await generateSuggestions();
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// PUT /api/evolution/suggestions/:id — update (dismiss, edit prompt)
evolution.put("/suggestions/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const body = await c.req.json() as Record<string, unknown>;

    const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (typeof body.status === "string") updates.status = body.status;
    if (typeof body.taskPrompt === "string") updates.taskPrompt = body.taskPrompt;
    if (typeof body.dismissReason === "string") updates.dismissReason = body.dismissReason;

    db.update(schema.evolutionSuggestions)
      .set(updates as Partial<typeof schema.evolutionSuggestions.$inferInsert>)
      .where(eq(schema.evolutionSuggestions.id, id))
      .run();

    return c.json({ ok: true });
  } catch (err) {
    console.error("[evolution] PUT /suggestions/:id error:", err);
    return c.json({ error: "Failed to update suggestion" }, 500);
  }
});

// ── Screenshot serving ───────────────────────────────────────────────────────

const SCREENSHOTS_DIR = join(homedir(), ".talome", "evolution-screenshots");

evolution.get("/screenshots/:filename", async (c) => {
  const filename = basename(c.req.param("filename"));
  // Only allow image file extensions
  if (!/^\d+-\d+\.(png|jpg|jpeg|webp)$/.test(filename)) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  try {
    const data = await readFile(join(SCREENSHOTS_DIR, filename));
    const ext = filename.split(".").pop() ?? "png";
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    return new Response(new Uint8Array(data), { headers: { "Content-Type": mime, "Cache-Control": "public, max-age=86400" } });
  } catch {
    return c.json({ error: "Not found" }, 404);
  }
});

// ── Shared constants ─────────────────────────────────────────────────────────

const SCOPE_DIRS: Record<string, string> = {
  backend: join(PROJECT_ROOT, "apps/core"),
  frontend: join(PROJECT_ROOT, "apps/dashboard"),
  full: PROJECT_ROOT,
};

const TERMINAL_DAEMON_PORT = Number(process.env.TERMINAL_DAEMON_PORT) || 4001;

// ── Bug Hunt — lightweight model for augmentation ────────────────────────────

type AiProvider = "anthropic" | "openai" | "ollama";

const LIGHTWEIGHT_MODELS: Record<AiProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
  ollama: "",
};

function getActiveProvider(): AiProvider {
  const stored = getSetting("ai_provider");
  if (stored === "anthropic" || stored === "openai" || stored === "ollama") return stored;
  return "anthropic";
}

/** Create a lightweight model instance using the user's configured provider. */
function createLightweightModel() {
  const provider = getActiveProvider();
  const modelId = getSetting("ai_model") || LIGHTWEIGHT_MODELS[provider] || LIGHTWEIGHT_MODELS.anthropic;

  switch (provider) {
    case "anthropic": {
      const apiKey = getSetting("anthropic_key") || process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return null;
      return { model: createAnthropic({ apiKey })(modelId), modelId };
    }
    case "openai": {
      const apiKey = getSetting("openai_key") || process.env.OPENAI_API_KEY;
      if (!apiKey) return null;
      return { model: createOpenAI({ apiKey })(modelId), modelId };
    }
    case "ollama": {
      const url = getSetting("ollama_url");
      if (!url) return null;
      return { model: createOpenAI({ baseURL: `${url}/v1`, apiKey: "ollama" })(modelId), modelId };
    }
    default:
      return null;
  }
}

/** Extract a short human-readable label from a task prompt (no AI needed). */
function extractFallbackName(taskPrompt: string, suggestionTitle?: string): string {
  if (suggestionTitle) return suggestionTitle.slice(0, 40);
  // Strip markdown/punctuation, grab first few meaningful words
  const words = taskPrompt
    .replace(/[#*_`>[\](){}]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(the|and|for|with|this|that|from|into|when|also|will|should|must|can|has|have|are|was|were|been|not|but)$/i.test(w))
    .slice(0, 4);
  if (words.length === 0) return "Evolution Task";
  // Title case
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** Generate a concise 2-4 word session name from a task prompt. */
async function generateSessionDisplayName(taskPrompt: string, suggestionTitle?: string): Promise<string> {
  const fallback = extractFallbackName(taskPrompt, suggestionTitle);

  const lm = createLightweightModel();
  if (!lm) return fallback;

  try {
    const result = await generateText({
      model: lm.model,
      prompt: `Generate a concise 2-4 word label for this task. Use Title Case. No quotes, no punctuation, no articles. Examples: "Docker Config Fix", "Memory Leak Debug", "Network Setup", "Terminal UI Polish", "Auth Middleware Rewrite".

Task: "${taskPrompt.slice(0, 300)}"

Label:`,
      maxOutputTokens: 20,
    });

    logAiUsage({
      model: lm.modelId,
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
      context: "session_name_gen",
    });

    const name = result.text.trim().replace(/^["']|["']$/g, "").slice(0, 40);
    return name || fallback;
  } catch {
    return fallback;
  }
}

/** Fire-and-forget: generate a display name and update DB + daemon. */
function generateAndStoreDisplayName(
  runId: string,
  sessionId: string,
  taskPrompt: string,
  suggestionTitle?: string,
) {
  void generateSessionDisplayName(taskPrompt, suggestionTitle).then((displayName) => {
    // Update DB
    db.update(schema.evolutionRuns)
      .set({ displayName })
      .where(eq(schema.evolutionRuns.id, runId))
      .run();

    // Update daemon session (PATCH now accepts pre-session updates)
    void fetch(`http://127.0.0.1:${TERMINAL_DAEMON_PORT}/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName }),
    }).catch((err) => log.debug("Failed to update daemon session (daemon may not be running)", err));
  });
}

const bugReportSchema = z.object({
  title: z.string().describe("Concise bug title (under 80 chars)"),
  description: z.string().describe("2-3 sentence clear description of the bug"),
  stepsToReproduce: z.array(z.string()).describe("Step-by-step reproduction instructions"),
  expectedBehavior: z.string().describe("What the user expected to happen"),
  actualBehavior: z.string().describe("What actually happens"),
  category: z.enum(["performance", "reliability", "ux", "feature", "maintenance"]),
  scope: z.enum(["backend", "frontend", "full"]),
  priority: z.enum(["low", "medium", "high"]),
  taskPrompt: z.string().describe(
    "Detailed, actionable prompt for Claude Code to investigate and fix this bug. " +
    "Include specific areas to look at, what to check, and what a fix should accomplish.",
  ),
});

// POST /api/evolution/bug-hunt — augment a bug description with Haiku
evolution.post("/bug-hunt", async (c) => {
  const contextSchema = z.object({
    route: z.string().optional(),
    viewport: z.object({ width: z.number(), height: z.number() }).optional(),
    consoleErrors: z.array(z.object({
      level: z.enum(["error", "warn"]),
      message: z.string(),
      timestamp: z.string(),
    })).optional(),
    networkErrors: z.array(z.object({
      url: z.string(),
      status: z.number(),
      method: z.string(),
      timestamp: z.string(),
    })).optional(),
    uncaughtErrors: z.array(z.string()).optional(),
  }).optional();

  const bodySchema = z.object({
    description: z.string().min(1),
    screenshots: z.array(z.string()).optional(),
    context: contextSchema,
  });

  const body = bodySchema.parse(await c.req.json());

  const lm = createLightweightModel();
  if (!lm) {
    return c.json({ error: "No AI provider configured" }, 400);
  }

  // Save screenshots if provided
  let screenshotPaths: string[] = [];
  if (body.screenshots && body.screenshots.length > 0) {
    screenshotPaths = await saveScreenshots(body.screenshots);
  }

  // Build auto-captured context section
  const ctx = body.context;
  const contextParts: string[] = [];
  if (ctx?.route) contextParts.push(`Current page: ${ctx.route}`);
  if (ctx?.consoleErrors && ctx.consoleErrors.length > 0) {
    const errors = ctx.consoleErrors.slice(-15).map((e) => `[${e.level}] ${e.message}`).join("\n");
    contextParts.push(`Browser console errors:\n${errors}`);
  }
  if (ctx?.networkErrors && ctx.networkErrors.length > 0) {
    const netErrs = ctx.networkErrors.slice(-10).map((e) => `${e.method} ${e.url} → ${e.status}`).join("\n");
    contextParts.push(`Failed network requests:\n${netErrs}`);
  }
  if (ctx?.uncaughtErrors && ctx.uncaughtErrors.length > 0) {
    contextParts.push(`Uncaught errors:\n${ctx.uncaughtErrors.slice(-5).join("\n")}`);
  }
  if (ctx?.viewport) {
    contextParts.push(`Viewport: ${ctx.viewport.width}×${ctx.viewport.height}`);
  }

  const autoContext = contextParts.length > 0
    ? `\n\nAuto-captured browser context:\n${contextParts.join("\n\n")}`
    : "";

  try {
    const screenshotContext = screenshotPaths.length > 0
      ? `\n\nThe user also attached ${screenshotPaths.length} screenshot(s) showing the bug.`
      : "";

    const result = await generateObject({
      model: lm.model,
      schema: bugReportSchema,
      prompt: `You are a senior software engineer helping triage a bug report for Talome, an AI-first home server management platform.

The codebase is a TypeScript monorepo:
- apps/core/ — Hono backend (AI agent, Docker API, tools, DB)
- apps/dashboard/ — Next.js 16 frontend (React 19, Tailwind, shadcn/ui)
- packages/types/ — shared types

The user has described a bug in their own words. Your job is to:
1. Understand what they're describing
2. Write a clear, structured bug report
3. Generate a detailed taskPrompt that Claude Code can use to investigate and fix the bug
4. Determine the correct scope (backend/frontend/full) and priority

User's bug description:
"${body.description}"${screenshotContext}${autoContext}

Use the auto-captured context (console errors, failed network requests, current page) to enrich your analysis. These signals help narrow down the root cause.

Be specific in the taskPrompt — mention likely files, components, or systems involved based on the description and context. The taskPrompt should be a complete instruction that Claude Code can execute autonomously.`,
      maxRetries: 1,
    });

    logAiUsage({
      model: lm.modelId,
      tokensIn: result.usage?.inputTokens ?? 0,
      tokensOut: result.usage?.outputTokens ?? 0,
      context: "bug_hunt_augment",
    });

    return c.json({
      augmented: result.object,
      screenshotPaths,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// POST /api/evolution/bug-hunt/submit — create suggestion + execute
evolution.post("/bug-hunt/submit", async (c) => {
  const bodySchema = z.object({
    title: z.string(),
    description: z.string(),
    category: z.enum(["performance", "reliability", "ux", "feature", "maintenance"]),
    priority: z.enum(["low", "medium", "high"]),
    scope: z.enum(["backend", "frontend", "full"]),
    taskPrompt: z.string(),
    screenshotPaths: z.array(z.string()).optional(),
    autoExecute: z.boolean().default(false),
    auto: z.boolean().default(false),
    yolo: z.boolean().default(false), // legacy alias
  });

  const body = bodySchema.parse(await c.req.json());
  const autoMode = body.auto || body.yolo;
  const now = new Date().toISOString();
  const id = `sug_${Date.now()}_bughunt`;

  db.insert(schema.evolutionSuggestions)
    .values({
      id,
      title: body.title,
      description: body.description,
      category: body.category,
      priority: body.priority,
      risk: "medium",
      sourceSignals: JSON.stringify(["bug_hunt"]),
      taskPrompt: body.taskPrompt,
      scope: body.scope,
      status: body.autoExecute ? "in_progress" : "pending",
      source: "bug_hunt",
      screenshots: JSON.stringify(body.screenshotPaths ?? []),
      createdAt: now,
      updatedAt: now,
    })
    .run();

  writeAuditEntry("AI: bug_hunt_submit", "modify", `${body.title}: ${body.description.slice(0, 120)}`);

  // If auto-execute, trigger evolution execution
  if (body.autoExecute) {
    const runId = `ev_${Date.now()}`;

    // Use bug-hunt title as immediate display name; AI may refine later
    const immediateName = body.title.slice(0, 40);

    db.insert(schema.evolutionRuns).values({
      id: runId,
      task: body.taskPrompt.slice(0, 500),
      scope: body.scope,
      status: "running",
      startedAt: now,
      displayName: immediateName,
    }).run();

    db.update(schema.evolutionSuggestions)
      .set({ status: "in_progress", runId, updatedAt: now })
      .where(eq(schema.evolutionSuggestions.id, id))
      .run();

    const sessionName = `evolution-${runId}`;
    try {
      await fetch(`http://127.0.0.1:${TERMINAL_DAEMON_PORT}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: sessionName, displayName: immediateName }),
      });
    } catch {
      // Daemon may not be running
    }

    writeAuditEntry("AI: evolution_execute", "destructive", `bug_hunt: ${body.taskPrompt.slice(0, 120)}`);

    // Generate a concise AI display name asynchronously (may refine the immediate name)
    generateAndStoreDisplayName(runId, `sess_${sessionName}`, body.taskPrompt, body.title);

    // Append screenshot file paths so Claude Code can read the images
    const paths = body.screenshotPaths ?? [];
    const enrichedPrompt = paths.length > 0
      ? body.taskPrompt + `\n\nVisual references for this bug have been saved at:\n${paths.map((p) => `  - ${p}`).join("\n")}\nStudy these screenshots carefully before making any changes.`
      : body.taskPrompt;

    // Write prompt to temp file for atomic CLI argument passing
    const promptFile = `/tmp/talome-prompt-${runId}.md`;
    await writeFile(promptFile, enrichedPrompt, "utf-8");

    const skipPerms = autoMode ? " --dangerously-skip-permissions" : "";
    const command = `cd ${PROJECT_ROOT} && env -u ANTHROPIC_API_KEY claude${skipPerms} "$(cat ${promptFile})"`;

    return c.json({
      suggestionId: id,
      execution: {
        runId,
        sessionName: `sess_${sessionName}`,
        command,
        taskPrompt: enrichedPrompt,
        scope: body.scope,
      },
    });
  }

  return c.json({ suggestionId: id });
});

// ── Execute — start Claude Code in terminal ──────────────────────────────────

evolution.post("/execute", async (c) => {
  const bodySchema = z.object({
    suggestionId: z.string().optional(),
    taskPrompt: z.string().optional(),
    scope: z.enum(["backend", "frontend", "full"]).default("full"),
    auto: z.boolean().default(false),
  });

  const body = bodySchema.parse(await c.req.json());

  let taskPrompt = body.taskPrompt ?? "";
  let suggestionId = body.suggestionId;

  // If a suggestion ID is provided, read its prompt + screenshots
  let screenshotPaths: string[] = [];
  let suggestionTitle: string | undefined;
  if (suggestionId) {
    const suggestion = db
      .select()
      .from(schema.evolutionSuggestions)
      .where(eq(schema.evolutionSuggestions.id, suggestionId))
      .get();

    if (!suggestion) return c.json({ error: "Suggestion not found" }, 404);
    taskPrompt = suggestion.taskPrompt;
    suggestionTitle = suggestion.title;
    try { screenshotPaths = JSON.parse(suggestion.screenshots ?? "[]"); } catch { /* */ }
  }

  if (!taskPrompt) return c.json({ error: "No task prompt provided" }, 400);

  // Append screenshot file paths so Claude Code can read the images
  const enrichedPrompt = screenshotPaths.length > 0
    ? taskPrompt + `\n\nVisual references for this bug have been saved at:\n${screenshotPaths.map((p: string) => `  - ${p}`).join("\n")}\nStudy these screenshots carefully before making any changes.`
    : taskPrompt;

  // Create evolution_runs row with immediate display name
  const runId = `ev_${Date.now()}`;
  const now = new Date().toISOString();
  const immediateName = extractFallbackName(taskPrompt, suggestionTitle);

  db.insert(schema.evolutionRuns).values({
    id: runId,
    task: taskPrompt.slice(0, 500),
    scope: body.scope,
    status: "running",
    startedAt: now,
    displayName: immediateName,
  }).run();

  // Update suggestion status
  if (suggestionId) {
    db.update(schema.evolutionSuggestions)
      .set({ status: "in_progress", runId, updatedAt: now })
      .where(eq(schema.evolutionSuggestions.id, suggestionId))
      .run();
  }

  // Create terminal session via daemon (pass display name immediately)
  const sessionName = `evolution-${runId}`;
  try {
    await fetch(`http://127.0.0.1:${TERMINAL_DAEMON_PORT}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: sessionName, displayName: immediateName }),
    });
  } catch {
    // Daemon may not be running — frontend will handle this gracefully
  }

  writeAuditEntry("AI: evolution_execute", "destructive", `${body.scope}: ${taskPrompt.slice(0, 120)}`);

  // Generate a concise AI display name asynchronously
  generateAndStoreDisplayName(runId, `sess_${sessionName}`, taskPrompt, suggestionTitle);

  // Write prompt to a temp file so we can pass it as a single CLI argument
  // to Claude Code — avoids fragmented idle-gap injection and timing heuristics.
  const promptFile = `/tmp/talome-prompt-${runId}.md`;
  await writeFile(promptFile, enrichedPrompt, "utf-8");

  // Single command: start Claude Code with the full prompt baked in.
  // "$(cat ...)" is shell-safe — double-quoted command substitution preserves
  // all special characters without re-interpretation.
  const skipPerms = body.auto ? " --dangerously-skip-permissions" : "";
  const command = `cd ${PROJECT_ROOT} && env -u ANTHROPIC_API_KEY claude${skipPerms} "$(cat ${promptFile})"`;

  return c.json({
    runId,
    sessionName: `sess_${sessionName}`,
    command,
    taskPrompt: enrichedPrompt,
    suggestionId,
    projectRoot: PROJECT_ROOT,
  });
});

// ── Reinject — restart a run with a fresh terminal session ───────────────────

evolution.post("/runs/:id/reinject", async (c) => {
  const reinjectBody = z.object({
    auto: z.boolean().default(false),
    yolo: z.boolean().default(false), // legacy alias
  }).safeParse(await c.req.json().catch(() => ({})));
  const autoMode = reinjectBody.success ? (reinjectBody.data.auto || reinjectBody.data.yolo) : false;

  const oldRunId = c.req.param("id");

  const oldRun = db
    .select()
    .from(schema.evolutionRuns)
    .where(eq(schema.evolutionRuns.id, oldRunId))
    .get();

  if (!oldRun) return c.json({ error: "Run not found" }, 404);

  // Find the associated suggestion to get full taskPrompt + screenshots
  const suggestion = db
    .select()
    .from(schema.evolutionSuggestions)
    .where(eq(schema.evolutionSuggestions.runId, oldRunId))
    .get();

  const taskPrompt = suggestion?.taskPrompt ?? oldRun.task;
  const scope = oldRun.scope ?? "full";
  let screenshotPaths: string[] = [];
  if (suggestion?.screenshots) {
    try { screenshotPaths = JSON.parse(suggestion.screenshots); } catch { /* */ }
  }

  // Kill the old terminal session (if any)
  const oldSessionName = `evolution-${oldRunId}`;
  const oldSessId = `sess_${oldSessionName}`;
  try {
    await fetch(`http://127.0.0.1:${TERMINAL_DAEMON_PORT}/sessions/${oldSessId}`, {
      method: "DELETE",
    }).catch((err) => log.warn(`Failed to kill old terminal session ${oldSessId}`, err));
  } catch { /* */ }

  // Mark old run as interrupted (preserve history)
  const now = new Date().toISOString();
  if (oldRun.status === "running") {
    db.update(schema.evolutionRuns)
      .set({ status: "interrupted", completedAt: now })
      .where(eq(schema.evolutionRuns.id, oldRunId))
      .run();
  }

  // Create a fresh run with new ID
  const newRunId = `ev_${Date.now()}`;
  const immediateName = oldRun.displayName ?? extractFallbackName(taskPrompt, suggestion?.title);

  db.insert(schema.evolutionRuns).values({
    id: newRunId,
    task: taskPrompt.slice(0, 500),
    scope,
    status: "running",
    startedAt: now,
    displayName: immediateName,
  }).run();

  // Point the suggestion to the new run
  if (suggestion) {
    db.update(schema.evolutionSuggestions)
      .set({ status: "in_progress", runId: newRunId, updatedAt: now })
      .where(eq(schema.evolutionSuggestions.id, suggestion.id))
      .run();
  }

  // Create fresh terminal session with new name
  const newSessionName = `evolution-${newRunId}`;
  try {
    await fetch(`http://127.0.0.1:${TERMINAL_DAEMON_PORT}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newSessionName, displayName: immediateName }),
    });
  } catch {
    return c.json({ error: "Terminal daemon unavailable" }, 503);
  }

  // Generate AI display name asynchronously
  generateAndStoreDisplayName(newRunId, `sess_${newSessionName}`, taskPrompt, suggestion?.title);

  const enrichedPrompt = screenshotPaths.length > 0
    ? taskPrompt + `\n\nVisual references for this bug have been saved at:\n${screenshotPaths.map((p: string) => `  - ${p}`).join("\n")}\nStudy these screenshots carefully before making any changes.`
    : taskPrompt;

  // Write prompt to temp file for atomic CLI argument passing
  const promptFile = `/tmp/talome-prompt-${newRunId}.md`;
  await writeFile(promptFile, enrichedPrompt, "utf-8");

  const skipPerms = autoMode ? " --dangerously-skip-permissions" : "";
  const command = `cd ${PROJECT_ROOT} && env -u ANTHROPIC_API_KEY claude${skipPerms} "$(cat ${promptFile})"`;

  writeAuditEntry("AI: evolution_reinject", "destructive", `${scope}: ${taskPrompt.slice(0, 120)}`);

  return c.json({
    runId: newRunId,
    sessionName: `sess_${newSessionName}`,
    command,
    taskPrompt: enrichedPrompt,
    scope,
    suggestionId: suggestion?.id,
  });
});

// ── Complete — post-execution typecheck + record ─────────────────────────────

evolution.post("/complete", async (c) => {
  const bodySchema = z.object({
    runId: z.string(),
    scope: z.enum(["backend", "frontend", "full"]).default("full"),
    autoRollback: z.boolean().default(true),
  });

  const body = bodySchema.parse(await c.req.json());

  const run = db
    .select()
    .from(schema.evolutionRuns)
    .where(eq(schema.evolutionRuns.id, body.runId))
    .get();

  if (!run) return c.json({ error: "Run not found" }, 404);

  const scopeDir = SCOPE_DIRS[body.scope] ?? PROJECT_ROOT;
  const filesChanged = await getChangedFiles(PROJECT_ROOT);
  const duration = Date.now() - new Date(run.startedAt).getTime();
  const now = new Date().toISOString();

  // Typecheck FIRST — don't commit broken code.
  const { ok: typecheckOk, errors: typeErrors } = await runTypecheck(scopeDir);

  if (!typecheckOk) {
    // Type errors — changes stay in the working tree so Claude Code can fix them.
    // Don't commit, don't rollback — just report back.
    db.update(schema.evolutionRuns)
      .set({
        status: "failed",
        completedAt: now,
        filesChanged: JSON.stringify(filesChanged),
        typeErrors: typeErrors.slice(0, 2000),
        rolledBack: false,
        duration,
      })
      .where(eq(schema.evolutionRuns.id, body.runId))
      .run();

    return c.json({
      ok: false,
      rolledBack: false,
      filesChanged,
      typeErrors: typeErrors.slice(0, 2000),
      duration,
    });
  }

  // Typecheck passed — commit the changes
  if (filesChanged.length > 0) {
    await spawnProcess("git", ["add", "-A"], PROJECT_ROOT);
    const commitMsg = run.displayName ?? run.task.slice(0, 72);
    await spawnProcess("git", ["commit", "-m", commitMsg], PROJECT_ROOT);
  }

  // Success — typecheck passed and changes committed
  db.update(schema.evolutionRuns)
    .set({
      status: "applied",
      completedAt: now,
      filesChanged: JSON.stringify(filesChanged),
      typeErrors: "",
      rolledBack: false,
      duration,
    })
    .where(eq(schema.evolutionRuns.id, body.runId))
    .run();

  db.insert(schema.evolutionLog).values({
    id: `ev_${Date.now()}`,
    timestamp: now,
    task: run.task,
    scope: run.scope,
    filesChanged: JSON.stringify(filesChanged),
    typeErrors: "",
    rolledBack: false,
    duration,
  }).run();

  // Update suggestion
  const suggestion = db
    .select()
    .from(schema.evolutionSuggestions)
    .where(eq(schema.evolutionSuggestions.runId, body.runId))
    .get();
  if (suggestion) {
    db.update(schema.evolutionSuggestions)
      .set({ status: "completed", updatedAt: now })
      .where(eq(schema.evolutionSuggestions.id, suggestion.id))
      .run();
  }

  writeNotification("info", "Talome improved itself", run.task.slice(0, 120));
  emitEvolutionEvent({ type: "applied", task: run.task, scope: run.scope, filesChanged, duration });

  // Rebuild backend if core/types files were changed (Terminal mode — batch changes
  // accumulate during the session, compile + restart happens once at "Complete").
  const touchesBackend = !IS_DEV_MODE && (body.scope === "backend" || body.scope === "full" ||
    filesChanged.some((f) => f.startsWith("apps/core/") || f.startsWith("packages/types/")));

  if (touchesBackend) {
    // Fire-and-forget — response returns immediately, rebuild runs in background
    void rebuildAndRestartBackend(filesChanged, body.runId);
  }

  return c.json({
    ok: true,
    rolledBack: false,
    filesChanged,
    duration,
  });
});

// ── POST /api/evolution/rebuild-dashboard — blue-green production build ───────
//
// Blue-green strategy: build into .next-staging/, then atomically swap with .next/.
// The live dashboard stays operational during the entire build. If the build fails,
// nothing changes — the current build is untouched. Build cache (.next/cache) is
// preserved across builds for Turbopack incremental compilation (5-15s warm rebuilds
// instead of 30-60s cold builds).

let rebuildInProgress = false;

evolution.post("/rebuild-dashboard", async (c) => {
  if (rebuildInProgress) {
    return c.json({ ok: false, error: "Build already in progress" }, 409);
  }

  // Only skip when the dashboard itself is in dev mode (next dev with HMR).
  // When core runs in dev mode via the managed wrapper (TALOME_MANAGED=1),
  // the dashboard still serves from .next/standalone/ and needs manual rebuilds.
  const dashboardHasHMR = IS_DEV_MODE && !process.env.TALOME_MANAGED;
  if (dashboardHasHMR) {
    return c.json({ ok: true, skipped: true, reason: "Dev mode — hot reload active" });
  }

  rebuildInProgress = true;
  const startTime = Date.now();
  const dashboardDir = resolve(PROJECT_ROOT, "apps/dashboard");
  const liveBuild = join(dashboardDir, ".next");
  const stagingBuild = join(dashboardDir, ".next-staging");
  const oldBuild = join(dashboardDir, ".next-old");

  try {
    // 1. Backup the current live build so we can restore on failure
    if (existsSync(oldBuild)) rmSync(oldBuild, { recursive: true, force: true });
    if (existsSync(liveBuild)) {
      // Preserve the build cache for Turbopack incremental compilation —
      // only backup manifests and output, not the cache directory
      renameSync(liveBuild, oldBuild);
      // Restore cache to the build directory so Turbopack can reuse it
      if (existsSync(join(oldBuild, "cache"))) {
        cpSync(join(oldBuild, "cache"), join(liveBuild, "cache"), { recursive: true });
      }
    }

    // 2. Build — writes to .next/ with warm Turbopack cache
    execSync("pnpm build", {
      cwd: dashboardDir,
      encoding: "utf8",
      timeout: 180_000,
      stdio: "pipe",
    });

    // 3. Build succeeded — clean up old build asynchronously
    if (existsSync(oldBuild)) {
      setTimeout(() => { try { rmSync(oldBuild, { recursive: true, force: true }); } catch { /* best effort */ } }, 5000);
    }

    const duration = Date.now() - startTime;
    return c.json({ ok: true, duration });
  } catch (err) {
    // Build failed — restore old build so dashboard stays operational
    if (existsSync(oldBuild)) {
      try {
        if (existsSync(liveBuild)) rmSync(liveBuild, { recursive: true, force: true });
        renameSync(oldBuild, liveBuild);
      } catch { /* best effort restore */ }
    }
    const stderr = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err);
    const duration = Date.now() - startTime;
    return c.json({ ok: false, buildError: stderr.slice(0, 2000), duration }, 500);
  } finally {
    rebuildInProgress = false;
  }
});

evolution.post("/rebuild-dashboard/autofix", async (c) => {
  if (rebuildInProgress) {
    return c.json({ ok: false, error: "Build already in progress" }, 409);
  }

  const body = await c.req.json().catch(() => ({})) as { buildError?: string };
  const dashboardDir = resolve(PROJECT_ROOT, "apps/dashboard");

  // Try typecheck first to get precise errors
  let errors = body.buildError ?? "";
  try {
    execSync("pnpm exec tsc --noEmit", { cwd: dashboardDir, encoding: "utf8", timeout: 30_000, stdio: "pipe" });
  } catch (err) {
    errors = (err as { stdout?: string }).stdout ?? errors;
  }

  if (!errors) {
    return c.json({ ok: false, error: "No build errors to fix" }, 400);
  }

  // Spawn Claude Code to fix the errors
  const task = `Fix these TypeScript/build errors in apps/dashboard. Do NOT add new features — only fix the errors:\n\n${errors.slice(0, 3000)}`;
  const runId = `ev_${Date.now()}`;

  writeAuditEntry("AI: autofix_build", "destructive", `Dashboard build errors: ${errors.slice(0, 200)}`);

  db.insert(schema.evolutionRuns).values({
    id: runId,
    task: "Autofix dashboard build errors",
    scope: "frontend",
    status: "running",
    displayName: "Build autofix",
  }).run();

  // Spawn Claude Code to fix errors — fire-and-forget, result tracked via evolution_runs
  const { spawnClaudeStreaming: runClaude } = await import("../ai/claude-process.js");
  void runClaude(task, dashboardDir).then(async (result) => {
    const status = result.code === 0 ? "applied" : "failed";
    db.update(schema.evolutionRuns)
      .set({ status, completedAt: new Date().toISOString(), error: result.code !== 0 ? result.stderr.slice(0, 2000) : undefined })
      .where(eq(schema.evolutionRuns.id, runId))
      .run();
    // If fix succeeded, rebuild automatically
    if (result.code === 0) {
      try {
        execSync("pnpm build", { cwd: dashboardDir, encoding: "utf8", timeout: 120_000, stdio: "pipe" });
        writeNotification("info", "Dashboard rebuilt", "Build autofix succeeded and dashboard was rebuilt.");
      } catch {
        writeNotification("warning", "Autofix applied but rebuild failed", "Check the terminal for details.");
      }
    }
  });

  return c.json({ ok: true, runId, hint: "Autofix started — check the Intelligence page for progress." });
});
