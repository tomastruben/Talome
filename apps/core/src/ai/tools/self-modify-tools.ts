import { tool } from "ai";
import { z } from "zod";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { eq } from "drizzle-orm";
import { writeAuditEntry } from "../../db/audit.js";
import { PROJECT_ROOT, readEvolutionLog } from "./claude-code-tool.js";
import { emitEvolutionEvent } from "../evolution-emitter.js";
import { writeNotification } from "../../db/notifications.js";
import { saveScreenshots } from "../claude-runner.js";
import { db, schema } from "../../db/index.js";
import { waitForRunResult } from "../evolution-emitter.js";
import { and } from "drizzle-orm";

// ── DB polling fallback for MCP context ───────────────────────────────────────
// When apply_change / plan_change is invoked via the MCP stdio server (a separate
// process from core), the in-process evolution emitter never receives worker events
// (the worker posts to core's HTTP port, not the MCP process).
// In that case we poll SQLite directly until the run row is no longer 'running'.

const IS_CORE_PROCESS = !!process.env.CORE_PORT;

async function waitForRunResultAny(
  runId: string,
  mode: "plan" | "apply",
  timeoutMs = 600_000,
): Promise<Record<string, unknown>> {
  if (IS_CORE_PROCESS) {
    return waitForRunResult(runId, timeoutMs);
  }

  // MCP context — poll SQLite every 2s
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [run] = db
      .select()
      .from(schema.evolutionRuns)
      .where(eq(schema.evolutionRuns.id, runId))
      .all();

    if (run && run.status !== "running") {
      if (mode === "plan") {
        return { type: "plan_result", runId, plan: run.planResult ?? "" };
      }
      if (run.status === "applied") {
        return {
          type: "apply_result",
          runId,
          success: true,
          filesChanged: JSON.parse(run.filesChanged || "[]"),
          duration: run.duration,
        };
      }
      if (run.status === "rolled_back") {
        return {
          type: "apply_result",
          runId,
          success: false,
          rolledBack: true,
          filesChanged: JSON.parse(run.filesChanged || "[]"),
          typeErrors: run.typeErrors,
          duration: run.duration,
        };
      }
      // failed or interrupted
      return {
        type: "apply_result",
        runId,
        success: false,
        rolledBack: false,
        error: run.error ?? "Evolution worker failed",
      };
    }

    await new Promise((r) => setTimeout(r, 2_000));
  }

  throw new Error(`Timed out waiting for run ${runId}`);
}

// ── Worker path ───────────────────────────────────────────────────────────────
// Resolve from PROJECT_ROOT so paths work in both dev (tsx) and prod (node dist/)

const CORE_ROOT = resolve(PROJECT_ROOT, "apps/core");
const WORKER_PATH = resolve(CORE_ROOT, "src/ai/evolution-worker.ts");
const TSX_BIN = resolve(CORE_ROOT, "node_modules/.bin/tsx");

const SERVER_PORT = Number(process.env.CORE_PORT) || 4000;
const DB_PATH = process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db");

// ── Helpers ───────────────────────────────────────────────────────────────────

function runGitIn(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn("git", args, { cwd: PROJECT_ROOT, env: process.env });
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- @types/node regression: ChildProcess lost .on()
    const p = proc as any;
    p.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.on("error", (err: Error) => resolve({ code: 1, stdout: "", stderr: err.message }));
  });
}

/**
 * Spawn the evolution worker as a detached process that survives tsx watch restarts.
 * Returns the runId immediately — the caller then waits for the result via waitForRunResult().
 */
function spawnWorker(runId: string, mode: "plan" | "apply", scope: string, task: string): void {
  const taskB64 = Buffer.from(task).toString("base64");

  const worker = spawn(
    TSX_BIN,
    [
      WORKER_PATH,
      runId,
      mode,
      scope,
      String(SERVER_PORT),
      DB_PATH,
      taskB64,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );

  worker.unref(); // Let parent process exit/restart without killing the worker
}

const SCOPE_DIRS: Record<string, string> = {
  backend: join(PROJECT_ROOT, "apps/core"),
  frontend: join(PROJECT_ROOT, "apps/dashboard"),
  full: PROJECT_ROOT,
};

/**
 * Pre-flight checks for apply_change. Any of these "no" before the worker
 * spawns is safer than any "sorry" after. Returns an error message if the
 * check fails, or null if we're good to go.
 *
 *  - `.git` must exist. Without it, the worker's stash/rollback path is
 *    a no-op and a failed change has no automatic recovery. This also
 *    catches the "Talome is running inside a container" case where the
 *    source tree is ephemeral.
 *
 *  - The working tree must be clean. `git stash push -u` sweeps ANY
 *    uncommitted file into the stash, including unrelated dev work. A
 *    user with WIP shouldn't lose it to an AI's auto-rollback.
 *
 *  - No other evolution run may be in-flight. Two concurrent
 *    apply_change calls would interleave stashes and almost certainly
 *    lose work. We already have the DB row; just check it.
 */
async function preflightApplyChange(): Promise<string | null> {
  if (!existsSync(join(PROJECT_ROOT, ".git"))) {
    return (
      "apply_change requires a .git directory in the project root so the " +
      "worker can stash and roll back on typecheck failure. This Talome " +
      "install appears to have no git history (e.g. Talome is running " +
      "from a container image with .git stripped). Reinstall from " +
      "https://get.talome.dev to enable self-evolution."
    );
  }

  const status = await runGitIn(["status", "--porcelain"]);
  if (status.code === 0 && status.stdout.trim().length > 0) {
    return (
      "Refusing to run apply_change: the working tree has uncommitted " +
      "changes. The worker's auto-rollback would sweep your changes into " +
      "a git stash and make them hard to recover. Commit, stash, or " +
      "discard your current work first, then try again. (`git status` " +
      "to see what's there.)"
    );
  }

  const running = db
    .select({ id: schema.evolutionRuns.id })
    .from(schema.evolutionRuns)
    .where(eq(schema.evolutionRuns.status, "running"))
    .all();
  if (running.length > 0) {
    return (
      `Another evolution run is in progress (id=${running[0].id}). ` +
      "Wait for it to finish before starting a new one. You can watch " +
      "progress on the Evolution page."
    );
  }

  return null;
}

// Silence the unused-import warning — `and` was imported for a future filter
// but isn't currently used. Keeping the import avoids churn when we add it.
void and;

// ── plan_change ───────────────────────────────────────────────────────────────

export const planChangeTool = tool({
  description:
    "Preview what Claude Code would change without actually applying it. " +
    "Runs Claude Code in a detached process (survives server restarts) to produce a text description of planned changes. " +
    "Use this before apply_change to verify the plan is correct. " +
    "After calling: show the plan to the user and ask if they want to proceed.",
  inputSchema: z.object({
    task: z.string().describe("What to build, fix, or change — same description you'd pass to apply_change"),
    scope: z.enum(["backend", "frontend", "full"]).default("full"),
  }),
  execute: async ({ task, scope }) => {
    const runId = `ev_${Date.now()}`;

    writeAuditEntry("AI: plan_change", "read", `${scope}: ${task}`);

    // Write in-progress record before spawning
    db.insert(schema.evolutionRuns).values({
      id: runId,
      task,
      scope,
      status: "running",
    }).run();

    // Spawn detached worker — it emits events back via internal-event loopback
    spawnWorker(runId, "plan", scope, task);

    // Wait for the worker to post plan_result (up to 10 min)
    try {
      const result = await waitForRunResultAny(runId, "plan") as Record<string, unknown>;
      const plan = (result.plan as string | undefined) ?? "";
      return {
        success: true,
        plan: plan.slice(0, 8000),
        truncated: plan.length > 8000,
        note: "This is a text description of planned changes — no files were modified.",
        hint: "Review the plan above. If it looks correct, call apply_change with the same task.",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  },
});

// ── apply_change ──────────────────────────────────────────────────────────────

export const applyChangeTool = tool({
  description:
    "Apply a code change to the Talome codebase via Claude Code with full safety guards. " +
    "Runs in a detached process that survives server restarts — the change completes even if tsx watch reloads. " +
    "Runs tsc --noEmit and automatically rolls back via git stash if type errors are found. " +
    "Requires user confirmation (confirmed: true). " +
    "If the user attached screenshots or images to their message, pass them via the screenshots parameter — " +
    "they will be saved to disk so Claude Code can read them as visual context. " +
    "After calling: report files changed, typecheck result, and whether a rollback occurred.",
  inputSchema: z.object({
    task: z.string().describe("What to build, fix, or change"),
    scope: z.enum(["backend", "frontend", "full"]).default("full"),
    confirmed: z
      .boolean()
      .default(false)
      .describe("Set to true only after user has explicitly confirmed they want the change applied"),
    screenshots: z
      .array(z.string())
      .optional()
      .describe(
        "Base64 data URLs of screenshots or images the user attached — saved to disk so Claude Code can read them as visual context when making UI changes",
      ),
  }),
  execute: async ({ task, scope, confirmed, screenshots }) => {
    if (!confirmed) {
      return {
        success: false,
        needs_confirmation: true,
        message:
          "This will modify the Talome codebase. Please confirm by calling apply_change again with confirmed: true. " +
          "Consider calling plan_change first to preview the diff.",
      };
    }

    const preflightError = await preflightApplyChange();
    if (preflightError) {
      writeAuditEntry("AI: apply_change BLOCKED (preflight)", "destructive", preflightError, false);
      return { success: false, error: preflightError, preflight: true };
    }

    // Save any attached screenshots so Claude Code can read them
    const screenshotPaths = screenshots && screenshots.length > 0
      ? await saveScreenshots(screenshots)
      : [];

    // Append screenshot note to task if needed
    let fullTask = task;
    if (screenshotPaths.length > 0) {
      fullTask +=
        `\n\nVisual references for this task have been saved at:\n${screenshotPaths.map((p) => `  - ${p}`).join("\n")}\nStudy these images carefully before making any UI changes.`;
    }

    const runId = `ev_${Date.now()}`;

    writeAuditEntry("AI: apply_change", "destructive", `${scope}: ${task}`);

    // Write in-progress record before spawning
    db.insert(schema.evolutionRuns).values({
      id: runId,
      task,
      scope,
      status: "running",
    }).run();

    // Spawn detached worker — survives server restarts
    spawnWorker(runId, "apply", scope, fullTask);

    // Wait for apply_result (up to 10 min)
    try {
      const result = await waitForRunResultAny(runId, "apply") as Record<string, unknown>;

      if (result.success) {
        writeNotification("info", "Talome improved itself", task.slice(0, 120));
        return {
          success: true,
          rolled_back: false,
          files_changed: result.filesChanged ?? [],
          typecheck: "passed",
          duration_ms: result.duration ?? 0,
        };
      }

      if (result.rolledBack) {
        writeNotification("warning", "Evolution change reverted", `Type errors after: ${task.slice(0, 120)}`);
        return {
          success: false,
          rolled_back: true,
          reason: "TypeScript errors introduced — automatically reverted via git stash.",
          type_errors: ((result.typeErrors as string) ?? "").slice(0, 2000),
          files_changed: result.filesChanged ?? [],
          stash_message: result.stashMessage,
          hint: "Refine the task and try again. The stash can be inspected with `git stash show -p`.",
        };
      }

      return {
        success: false,
        error: (result.error as string) ?? "Claude Code failed",
        rolled_back: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  },
});

// ── rollback_change ───────────────────────────────────────────────────────────

export const rollbackChangeTool = tool({
  description:
    "Roll back the most recent code change made by apply_change. " +
    "Pops the most recent git stash (created by apply_change or auto-rollback). " +
    "After calling: confirm what was restored and the current git status.",
  inputSchema: z.object({
    stash_message: z
      .string()
      .optional()
      .describe("Specific stash message from the apply_change result to restore. If omitted, pops the latest stash."),
  }),
  execute: async ({ stash_message }) => {
    writeAuditEntry("AI: rollback_change", "destructive", stash_message ?? "latest stash");

    const { stdout: stashList } = await runGitIn(["stash", "list"]);

    if (!stashList) {
      return { success: false, error: "No stashes found. Nothing to roll back." };
    }

    let stashRef = "stash@{0}";
    if (stash_message) {
      const lines = stashList.split("\n");
      const match = lines.find((l) => l.includes(stash_message));
      if (match) {
        stashRef = match.split(":")[0];
      } else {
        return {
          success: false,
          error: `Stash with message "${stash_message}" not found.`,
          available_stashes: stashList,
        };
      }
    }

    const { code, stderr } = await runGitIn(["stash", "pop", stashRef]);
    if (code !== 0) {
      return { success: false, error: stderr };
    }

    const { stdout: statusOut } = await runGitIn(["status", "--short"]);
    emitEvolutionEvent({ type: "reverted", task: "manual rollback", scope: "full", filesChanged: [], duration: 0 });
    writeNotification(
      "info",
      "Evolution change rolled back",
      stash_message ? `Restored: ${stash_message}` : "Latest change reverted",
    );

    return {
      success: true,
      restored_stash: stashRef,
      git_status: statusOut,
    };
  },
});

// ── list_changes ──────────────────────────────────────────────────────────────

export const listChangesTool = tool({
  description:
    "List the history of code changes made by Talome's AI (apply_change calls and auto-rollbacks). " +
    "Shows task description, files affected, whether it was rolled back, and duration. " +
    "After calling: summarise the recent evolution history.",
  inputSchema: z.object({
    limit: z.number().default(20).describe("Maximum number of entries to return"),
  }),
  execute: async ({ limit }) => {
    const entries = await readEvolutionLog(limit);
    return {
      count: entries.length,
      entries,
      hint: entries.length === 0 ? "No code changes recorded yet." : undefined,
    };
  },
});
