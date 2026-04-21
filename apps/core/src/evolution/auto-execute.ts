/**
 * Auto-Execute: automatically apply low-risk evolution suggestions.
 *
 * Called periodically from the monitor loop. Picks one pending low-risk
 * suggestion, spawns an evolution worker, and tracks the outcome.
 * Only runs if the `evolution_auto_execute` setting allows it.
 */

import { resolve, join } from "node:path";
import { spawn, execSync, spawnSync } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { writeNotification } from "../db/notifications.js";
import { getSetting } from "../utils/settings.js";

// Resolve from cwd (repo root) so paths work in both dev (tsx) and prod (node dist/)
const PROJECT_ROOT = resolve(process.cwd(), "../..");
const CORE_ROOT = resolve(PROJECT_ROOT, "apps/core");

// ── Worker paths (same as self-modify-tools) ─────────────────────────────────

const WORKER_PATH = resolve(CORE_ROOT, "src/ai/evolution-worker.ts");
const TSX_BIN = resolve(CORE_ROOT, "node_modules/.bin/tsx");

const SERVER_PORT = Number(process.env.CORE_PORT) || 4000;
const DB_PATH = process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db");

// ── State ────────────────────────────────────────────────────────────────────

// Track suggestions that failed auto-execution so we never retry them automatically
const failedAutoExecIds = new Set<string>();

// Cooldown: after a failure, wait before trying the next suggestion
const FAILURE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
let lastFailureAt = 0;
let consecutiveFailures = 0;

// Daily run cap — prevent runaway auto-execute sessions
const MAX_AUTO_EXEC_PER_DAY = 5;

// ── Helpers ──────────────────────────────────────────────────────────────────

// Keep in sync with the list in self-modify-tools.ts — keys Claude Code
// can leak to the evolution event stream if it runs `env` or similar.
const WORKER_ENV_SCRUB = [
  "TALOME_SECRET",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DATABASE_URL",
  "SMTP_PASSWORD",
  "DISCORD_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
];

function buildWorkerEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (WORKER_ENV_SCRUB.includes(k)) continue;
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function spawnWorker(runId: string, scope: string, task: string): void {
  const taskB64 = Buffer.from(task).toString("base64");

  const worker = spawn(
    TSX_BIN,
    [WORKER_PATH, runId, "apply", scope, String(SERVER_PORT), DB_PATH, taskB64],
    { detached: true, stdio: "ignore", env: buildWorkerEnv() },
  );

  worker.unref();
}

/**
 * Delegate a task to a new Claude Code tmux session.
 * Creates a dedicated session so the user can attach and watch/intervene.
 * Returns true if the session was created successfully.
 */
function delegateToTerminal(runId: string, task: string): boolean {
  try {
    // Encode task as base64 to avoid shell escaping issues
    const taskB64 = Buffer.from(task).toString("base64");
    const sessionName = `talome-evo-${runId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

    // Create a new detached tmux session running Claude Code with the task
    // Uses --print so it runs to completion, but in a visible tmux session
    // the user can attach to. Strips ANTHROPIC_API_KEY to use subscription auth.
    const cmd = [
      "tmux", "new-session", "-d",
      "-s", sessionName,
      "-c", PROJECT_ROOT,
      `env -u ANTHROPIC_API_KEY claude --dangerously-skip-permissions --print "$(echo '${taskB64}' | base64 -d)"`,
    ];

    execSync(cmd.join(" "), { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a process with the given PID is still alive.
 * Uses signal 0 which doesn't actually send a signal — just checks existence.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH = process doesn't exist
  }
}

/**
 * Reconcile evolution runs whose worker process has died without updating the DB.
 * Checks the PID recorded by the worker; if the process no longer exists, marks the
 * run as failed and reverts the linked suggestion to pending.
 */
export function reapDeadWorkers(): void {
  try {
    const running = db
      .select({
        id: schema.evolutionRuns.id,
        pid: schema.evolutionRuns.pid,
        startedAt: schema.evolutionRuns.startedAt,
      })
      .from(schema.evolutionRuns)
      .where(eq(schema.evolutionRuns.status, "running"))
      .all();

    const now = new Date().toISOString();

    for (const run of running) {
      // If PID was recorded and the process is dead → mark failed
      if (run.pid && !isProcessAlive(run.pid)) {
        // A worker that died via SIGKILL / OOM can't run its exit handler,
        // so the working tree may still be dirty from Claude's writes.
        // Stash anything left behind so the next run starts clean. Named
        // distinctly so users can find (and recover from) it.
        let recoveryNote = "";
        try {
          const statusResult = spawnSync("git", ["status", "--porcelain"], {
            cwd: PROJECT_ROOT,
            encoding: "utf8",
            timeout: 5_000,
          });
          const dirty = statusResult.status === 0 && (statusResult.stdout ?? "").trim().length > 0;
          if (dirty) {
            const stashName = `talome-orphan-recovery-${run.id}`;
            spawnSync("git", ["stash", "push", "-u", "-m", stashName], {
              cwd: PROJECT_ROOT,
              timeout: 10_000,
              stdio: "ignore",
            });
            recoveryNote = `; uncommitted changes stashed as "${stashName}"`;
          }
        } catch { /* best effort */ }

        db.update(schema.evolutionRuns)
          .set({
            status: "failed",
            completedAt: now,
            error: `Worker process terminated unexpectedly${recoveryNote}`,
          })
          .where(eq(schema.evolutionRuns.id, run.id))
          .run();

        // Revert any linked suggestion back to pending
        db.update(schema.evolutionSuggestions)
          .set({ status: "pending", updatedAt: now })
          .where(eq(schema.evolutionSuggestions.runId, run.id))
          .run();

        console.log(`[evolution/reaper] Reaped dead worker for run ${run.id} (pid ${run.pid})${recoveryNote}`);
        continue;
      }

      // If no PID was recorded and the run has been "running" for >15 minutes,
      // it's almost certainly dead (worker records PID within seconds of starting)
      if (!run.pid && run.startedAt) {
        const elapsed = Date.now() - new Date(run.startedAt).getTime();
        if (elapsed > 15 * 60 * 1000) {
          db.update(schema.evolutionRuns)
            .set({
              status: "failed",
              completedAt: now,
              error: "Worker never started (no PID recorded after 15 minutes)",
            })
            .where(eq(schema.evolutionRuns.id, run.id))
            .run();

          db.update(schema.evolutionSuggestions)
            .set({ status: "pending", updatedAt: now })
            .where(eq(schema.evolutionSuggestions.runId, run.id))
            .run();

          console.log(`[evolution/reaper] Reaped stale run ${run.id} (no PID after 15m)`);
        }
      }
    }
  } catch (err) {
    console.error("[evolution/reaper] error:", err);
  }
}

function hasRunningEvolution(): boolean {
  try {
    // Reap dead workers first so we don't block on phantom "running" rows
    reapDeadWorkers();

    const running = db
      .select({ id: schema.evolutionRuns.id })
      .from(schema.evolutionRuns)
      .where(eq(schema.evolutionRuns.status, "running"))
      .limit(1)
      .all();
    return running.length > 0;
  } catch {
    return false;
  }
}

// ── Reconcile previous auto-exec runs ────────────────────────────────────────

function reconcileCompletedRuns(): void {
  try {
    // Find suggestions that are in_progress with a runId that has completed
    const inProgress = db
      .select({
        id: schema.evolutionSuggestions.id,
        runId: schema.evolutionSuggestions.runId,
        title: schema.evolutionSuggestions.title,
      })
      .from(schema.evolutionSuggestions)
      .where(
        sql`${schema.evolutionSuggestions.status} = 'in_progress' AND ${schema.evolutionSuggestions.runId} IS NOT NULL AND ${schema.evolutionSuggestions.source} = 'scan'`,
      )
      .all();

    for (const sug of inProgress) {
      if (!sug.runId) continue;

      const run = db
        .select({
          status: schema.evolutionRuns.status,
          rolledBack: schema.evolutionRuns.rolledBack,
        })
        .from(schema.evolutionRuns)
        .where(eq(schema.evolutionRuns.id, sug.runId))
        .get();

      if (!run || run.status === "running") continue;

      const now = new Date().toISOString();

      if (run.status === "applied" && !run.rolledBack) {
        // Success — reset failure counter
        consecutiveFailures = 0;

        db.update(schema.evolutionSuggestions)
          .set({ status: "completed", updatedAt: now })
          .where(eq(schema.evolutionSuggestions.id, sug.id))
          .run();

        writeNotification(
          "info",
          `Auto-improvement applied: ${sug.title}`,
          "Low-risk suggestion was automatically executed and passed typecheck.",
          "evolution",
        );
      } else {
        // Failed or rolled back — revert to pending, but never auto-retry
        db.update(schema.evolutionSuggestions)
          .set({ status: "pending", updatedAt: now })
          .where(eq(schema.evolutionSuggestions.id, sug.id))
          .run();

        failedAutoExecIds.add(sug.id);
        lastFailureAt = Date.now();
        consecutiveFailures++;

        // Only notify on the first failure, then stay quiet until a success resets the counter
        if (consecutiveFailures <= 1) {
          writeNotification(
            "info",
            `Auto-improvement rolled back: ${sug.title}`,
            "Suggestion failed typecheck and was reverted. Will try others after a cooldown.",
            "evolution",
          );
        }

        console.log(`[evolution/auto-execute] Rolled back: ${sug.title} (${consecutiveFailures} consecutive failures, cooldown active)`);
      }
    }
  } catch (err) {
    console.error("[evolution/auto-execute] reconcile error:", err);
  }
}

// ── Main: maybe auto-execute one suggestion ──────────────────────────────────

export async function maybeAutoExecute(): Promise<void> {
  // Check setting: "none" | "low" | "medium" (default: "low")
  const policy = getSetting("evolution_auto_execute") ?? "low";
  if (policy === "none") return;

  const allowedRisks = policy === "medium" ? ["low", "medium"] : ["low"];

  // First, reconcile any previously dispatched runs
  reconcileCompletedRuns();

  // Don't overlap with any running evolution (manual or auto)
  if (hasRunningEvolution()) return;

  // Daily run cap — prevent runaway sessions
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayRuns = db
      .select({ id: schema.evolutionRuns.id })
      .from(schema.evolutionRuns)
      .where(sql`${schema.evolutionRuns.id} LIKE 'ev_auto_%' AND ${schema.evolutionRuns.startedAt} >= ${todayStart.toISOString()}`)
      .all();
    if (todayRuns.length >= MAX_AUTO_EXEC_PER_DAY) {
      return;
    }
  } catch { /* ignore */ }

  // Cooldown after failures — back off to avoid burning through suggestions
  if (consecutiveFailures > 0 && Date.now() - lastFailureAt < FAILURE_COOLDOWN_MS) {
    return;
  }

  try {
    // Find the next eligible suggestion
    const riskFilter = allowedRisks.map((r) => `'${r}'`).join(", ");
    const candidates = db
      .select()
      .from(schema.evolutionSuggestions)
      .where(
        sql`${schema.evolutionSuggestions.status} = 'pending' AND ${schema.evolutionSuggestions.risk} IN (${sql.raw(riskFilter)})`,
      )
      .limit(5)
      .all();

    // Filter out previously failed auto-execs
    const eligible = candidates.filter((c) => !failedAutoExecIds.has(c.id));
    if (eligible.length === 0) return;

    // Pick the highest priority one
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    eligible.sort(
      (a, b) =>
        (priorityOrder[a.priority as keyof typeof priorityOrder] ?? 2) -
        (priorityOrder[b.priority as keyof typeof priorityOrder] ?? 2),
    );

    const suggestion = eligible[0];
    const runId = `ev_auto_${Date.now()}`;
    const now = new Date().toISOString();

    // Create evolution run record (use suggestion title as display name)
    db.insert(schema.evolutionRuns)
      .values({
        id: runId,
        task: suggestion.taskPrompt,
        scope: suggestion.scope,
        status: "running",
        displayName: suggestion.title.slice(0, 40),
      })
      .run();

    // Mark suggestion as in_progress with the run ID
    db.update(schema.evolutionSuggestions)
      .set({ status: "in_progress", runId, updatedAt: now })
      .where(eq(schema.evolutionSuggestions.id, suggestion.id))
      .run();

    // Check execution mode: "headless" (default) or "terminal"
    const executionMode = getSetting("evolution_execution_mode") ?? "headless";

    if (executionMode === "terminal") {
      const sent = delegateToTerminal(runId, suggestion.taskPrompt);
      if (!sent) {
        // No tmux session — revert suggestion to pending and skip
        db.update(schema.evolutionSuggestions)
          .set({ status: "pending", updatedAt: now })
          .where(eq(schema.evolutionSuggestions.id, suggestion.id))
          .run();
        db.delete(schema.evolutionRuns)
          .where(eq(schema.evolutionRuns.id, runId))
          .run();
        console.log("[evolution/auto-execute] Terminal session not found, skipping");
        return;
      }
      console.log(`[evolution/auto-execute] Delegated to terminal: ${suggestion.title}`);
    } else {
      // Fire and forget — reconcileCompletedRuns() will pick up the result next cycle
      spawnWorker(runId, suggestion.scope, suggestion.taskPrompt);
      console.log(`[evolution/auto-execute] Started: ${suggestion.title} (run: ${runId})`);
    }
  } catch (err) {
    console.error("[evolution/auto-execute] error:", err);
  }
}
