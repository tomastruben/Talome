/**
 * Detached worker process for apply_change and plan_change.
 *
 * Spawned with `detached: true, stdio: "ignore"` so it survives tsx watch restarts.
 * Communicates back to the server via HTTP POST to /api/evolution/internal-event
 * (loopback only, no auth required).
 *
 * argv: node evolution-worker.ts <runId> <mode> <scope> <serverPort> <dbPath> <taskB64>
 *   mode: "apply" | "plan"
 */

import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import { mkdirSync, existsSync, renameSync, rmSync, cpSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";
import {
  spawnClaudeStreaming,
  getChangedFiles,
  runTypecheck,
  stashRollback,
} from "../ai/claude-process.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("evolution-worker");

/**
 * Claude-Code wall-clock timeout. Default 15 minutes. A hung CLI
 * session won't tie up the worker forever. Override per run with
 * TALOME_EVOLUTION_TIMEOUT_MS for long tasks.
 */
const CLAUDE_TIMEOUT_MS = Number(process.env.TALOME_EVOLUTION_TIMEOUT_MS) || 15 * 60 * 1000;

// ── Args ──────────────────────────────────────────────────────────────────────

const [, , runId, mode, scope, serverPort, dbPath, taskB64] = process.argv;

if (!runId || !mode || !scope || !serverPort || !dbPath || !taskB64) {
  console.error("[evolution-worker] Missing required arguments");
  process.exit(1);
}

const task = Buffer.from(taskB64, "base64").toString("utf8");
const port = Number(serverPort);
const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../..");

const SCOPE_DIRS: Record<string, string> = {
  backend: join(PROJECT_ROOT, "apps/core"),
  frontend: join(PROJECT_ROOT, "apps/dashboard"),
  full: PROJECT_ROOT,
};

// ── DB (direct sqlite, no ORM overhead in a worker) ──────────────────────────

mkdirSync(join(dbPath, ".."), { recursive: true });
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");

// ── Event bridge ──────────────────────────────────────────────────────────────

async function postEvent(event: Record<string, unknown>) {
  try {
    await fetch(`http://127.0.0.1:${port}/api/evolution/internal-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Server may be restarting — non-fatal, worker continues regardless
  }
}

// ── Lifecycle guards ─────────────────────────────────────────────────────────

/**
 * If the worker exits while the DB row is still `running`, stash any
 * uncommitted changes Claude made and mark the run failed. Without this,
 * a crash mid-edit leaves the working tree dirty and the DB showing
 * "running" until the reaper picks it up — meanwhile the user's tsx
 * watch could be trying to start the broken code.
 *
 * This runs from process.on("exit"), so it must be synchronous.
 */
let cleanupDone = false;
function cleanupDanglingState(reason: string): void {
  if (cleanupDone) return;
  cleanupDone = true;

  let runStatus = "running";
  try {
    const row = sqlite
      .prepare("SELECT status FROM evolution_runs WHERE id = ?")
      .get(runId) as { status?: string } | undefined;
    runStatus = row?.status ?? "running";
  } catch { /* DB may be gone */ }

  if (runStatus !== "running") return;

  // Best-effort stash any Claude writes so the working tree is clean
  // again for the next run. `-u` catches untracked files too.
  let stashMessage: string | null = null;
  try {
    const statusResult = spawnSync("git", ["status", "--porcelain"], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 5_000,
    });
    const dirty = statusResult.status === 0 && (statusResult.stdout ?? "").trim().length > 0;
    if (dirty) {
      stashMessage = `talome-orphan-recovery-${runId}`;
      spawnSync("git", ["stash", "push", "-u", "-m", stashMessage], {
        cwd: PROJECT_ROOT,
        timeout: 10_000,
        stdio: "ignore",
      });
    }
  } catch { /* best-effort */ }

  try {
    sqlite
      .prepare(
        "UPDATE evolution_runs SET status = 'failed', completed_at = ?, error = ? WHERE id = ?",
      )
      .run(
        new Date().toISOString(),
        `Worker terminated unexpectedly (${reason})${stashMessage ? `; changes stashed as "${stashMessage}"` : ""}`,
        runId,
      );
  } catch { /* DB may be gone */ }
}

// Graceful termination — parent restart, OS asked nicely, supervisor kill.
// Flush DB state then exit with a non-zero code so the reaper knows.
function signalHandler(signal: string): () => void {
  return () => {
    cleanupDanglingState(signal);
    process.exit(1);
  };
}
process.on("SIGTERM", signalHandler("SIGTERM"));
process.on("SIGINT", signalHandler("SIGINT"));
process.on("SIGHUP", signalHandler("SIGHUP"));

// Last-chance sync cleanup. Runs on any exit path — normal return,
// exception, signal. Must be synchronous; can't post HTTP events here.
process.on("exit", () => {
  cleanupDanglingState("process-exit");
});

// An unhandled rejection ends the Node process in modern Node anyway,
// but the explicit handler gives us a labeled reason in the DB row.
process.on("uncaughtException", (err) => {
  cleanupDanglingState(`uncaughtException: ${err?.message ?? err}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  cleanupDanglingState(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
});

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const start = Date.now();

  // Record our PID so startup reconciliation can check if we're still alive
  sqlite
    .prepare("UPDATE evolution_runs SET pid = ? WHERE id = ?")
    .run(process.pid, runId);

  await postEvent({ type: "started", task, scope });

  const cwd = SCOPE_DIRS[scope] ?? PROJECT_ROOT;
  const scopeHint: Record<string, string> = {
    backend: " Focus on apps/core/.",
    frontend: " Focus on apps/dashboard/.",
    full: "",
  };

  let fullTask = task + (scopeHint[scope] ?? "");

  if (mode === "plan") {
    fullTask +=
      " Describe the changes you would make in detail (files to modify, what would change, and why), but do NOT actually modify any files.";
  }

  // Hard deadline so a hung Claude CLI can't pin the worker forever.
  // spawnClaudeStreaming respects the abort signal and kills the child
  // process group on timeout.
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), CLAUDE_TIMEOUT_MS);

  const { code, stdout, stderr } = await spawnClaudeStreaming(
    fullTask,
    cwd,
    async (chunk) => {
      await postEvent({ type: "output", chunk });
    },
    deadlineController.signal,
  );
  clearTimeout(deadlineTimer);

  if (deadlineController.signal.aborted) {
    await postEvent({
      type: "failed",
      error: `Claude Code exceeded ${Math.round(CLAUDE_TIMEOUT_MS / 60_000)} minute timeout`,
    });
    // cleanupDanglingState handles stash + DB status on exit.
    process.exit(1);
  }

  const duration = Date.now() - start;

  if (mode === "plan") {
    if (code !== 0 && !stdout) {
      await postEvent({ type: "failed", error: stderr || `Claude Code exited with code ${code}` });
      sqlite
        .prepare(
          "UPDATE evolution_runs SET status = 'failed', completed_at = ?, duration = ?, error = ? WHERE id = ?",
        )
        .run(new Date().toISOString(), duration, stderr || "Claude Code failed", runId);
      process.exit(0);
    }

    // Persist plan text so it survives a core restart
    sqlite
      .prepare(
        "UPDATE evolution_runs SET status = 'applied', completed_at = ?, duration = ?, plan_result = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), duration, stdout.slice(0, 8000), runId);

    await postEvent({ type: "applied", task, scope, filesChanged: [], duration });
    await postEvent({ type: "plan_result", runId, plan: stdout.slice(0, 8000) });
    process.exit(0);
  }

  // apply mode
  if (code !== 0 && !stdout) {
    await postEvent({ type: "failed", error: stderr || `Claude Code exited with code ${code}` });
    sqlite
      .prepare(
        "UPDATE evolution_runs SET status = 'failed', completed_at = ?, duration = ?, error = ? WHERE id = ?",
      )
      .run(new Date().toISOString(), duration, stderr || "Claude Code failed", runId);
    process.exit(0);
  }

  const filesChanged = await getChangedFiles(cwd);

  // Typecheck
  const checkDir =
    scope === "backend"
      ? SCOPE_DIRS.backend
      : scope === "frontend"
        ? SCOPE_DIRS.frontend
        : PROJECT_ROOT;
  const { ok, errors } = await runTypecheck(checkDir);

  if (!ok) {
    const stashMessage = await stashRollback(cwd);
    await postEvent({ type: "reverted", task, scope, filesChanged, typeErrors: errors, duration });
    sqlite
      .prepare(
        `UPDATE evolution_runs
         SET status = 'rolled_back', completed_at = ?, files_changed = ?,
             type_errors = ?, rolled_back = 1, duration = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        JSON.stringify(filesChanged),
        errors.slice(0, 2000),
        duration,
        runId,
      );

    // Also write to legacy evolution_log for history page
    sqlite
      .prepare(
        `INSERT INTO evolution_log (id, timestamp, task, scope, files_changed, type_errors, rolled_back, duration)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        `ev_${Date.now()}`,
        new Date().toISOString(),
        task,
        scope,
        JSON.stringify(filesChanged),
        errors.slice(0, 2000),
        duration,
      );

    await postEvent({
      type: "apply_result",
      runId,
      success: false,
      rolledBack: true,
      stashMessage,
      filesChanged,
      typeErrors: errors,
    });
    process.exit(0);
  }

  // Capture git diff for visual display
  let diffOutput = "";
  try {
    diffOutput = execSync("git diff HEAD~1", { cwd, encoding: "utf8", timeout: 10_000 }).slice(0, 50_000);
  } catch {
    // No diff available (first commit, etc.)
  }

  await postEvent({ type: "applied", task, scope, filesChanged, duration });
  sqlite
    .prepare(
      `UPDATE evolution_runs
       SET status = 'applied', completed_at = ?, files_changed = ?, duration = ?, diff_output = ?
       WHERE id = ?`,
    )
    .run(new Date().toISOString(), JSON.stringify(filesChanged), duration, diffOutput, runId);

  // Write to legacy evolution_log for history page
  sqlite
    .prepare(
      `INSERT INTO evolution_log (id, timestamp, task, scope, files_changed, type_errors, rolled_back, duration)
       VALUES (?, ?, ?, ?, ?, '', 0, ?)`,
    )
    .run(
      `ev_${Date.now()}`,
      new Date().toISOString(),
      task,
      scope,
      JSON.stringify(filesChanged),
      duration,
    );

  // ── Auto-rebuild dashboard if frontend files were changed ──────────────────
  // Skip only when the dashboard itself is in dev mode (next dev with HMR).
  // When core runs in dev mode via the managed wrapper (TALOME_MANAGED=1),
  // the dashboard still serves from .next/ and needs rebuilds.
  const isDevMode = process.env.TSX === "1" || process.env.NODE_ENV === "development";
  const dashboardHasHMR = isDevMode && !process.env.TALOME_MANAGED;
  const touchesFrontend = !dashboardHasHMR && (scope === "frontend" || scope === "full" ||
    filesChanged.some((f: string) => f.startsWith("apps/dashboard/") || f.startsWith("apps/web/")));

  if (touchesFrontend) {
    const dashboardDir = join(PROJECT_ROOT, "apps/dashboard");
    const liveBuild = join(dashboardDir, ".next");
    const oldBuild = join(dashboardDir, ".next-old");

    try {
      await postEvent({ type: "rebuild_started", runId });

      // Backup live build, preserve Turbopack cache for incremental compilation
      if (existsSync(oldBuild)) rmSync(oldBuild, { recursive: true, force: true });
      if (existsSync(liveBuild)) {
        renameSync(liveBuild, oldBuild);
        if (existsSync(join(oldBuild, "cache"))) {
          cpSync(join(oldBuild, "cache"), join(liveBuild, "cache"), { recursive: true });
        }
      }

      execSync("pnpm build", { cwd: dashboardDir, encoding: "utf8", timeout: 180_000, stdio: "pipe" });

      // Clean up old build
      if (existsSync(oldBuild)) {
        try { rmSync(oldBuild, { recursive: true, force: true }); } catch { /* best effort */ }
      }

      await postEvent({ type: "rebuild_complete", runId });
    } catch (rebuildErr) {
      // Restore old build so dashboard stays operational
      if (existsSync(oldBuild)) {
        try {
          if (existsSync(liveBuild)) rmSync(liveBuild, { recursive: true, force: true });
          renameSync(oldBuild, liveBuild);
        } catch { /* best effort */ }
      }
      const msg = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
      await postEvent({ type: "rebuild_failed", runId, error: msg.slice(0, 500) }).catch((err) => log.warn("Failed to post rebuild_failed event", err));
    }
  }

  // ── Auto-rebuild backend if core/types files were changed ──────────────────
  // Skip in dev mode — tsx watch handles hot reload automatically.
  // Rebuild types first (core depends on types dist/) then core.
  // The detached worker survives the server restart this triggers.
  const touchesBackend = !isDevMode && (scope === "backend" || scope === "full" ||
    filesChanged.some((f: string) => f.startsWith("apps/core/") || f.startsWith("packages/types/")));

  if (touchesBackend) {
    const typesDir = join(PROJECT_ROOT, "packages/types");
    const coreDir = join(PROJECT_ROOT, "apps/core");

    try {
      await postEvent({ type: "backend_rebuild_started", runId });

      // Rebuild types first if changed (core depends on types dist/)
      if (filesChanged.some((f: string) => f.startsWith("packages/types/"))) {
        execSync("pnpm exec tsc", { cwd: typesDir, encoding: "utf8", timeout: 30_000, stdio: "pipe" });
      }

      // Compile core src/ → dist/
      execSync("pnpm exec tsc", { cwd: coreDir, encoding: "utf8", timeout: 60_000, stdio: "pipe" });

      await postEvent({ type: "backend_rebuild_complete", runId });
    } catch (rebuildErr) {
      const msg = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
      await postEvent({ type: "backend_rebuild_failed", runId, error: msg.slice(0, 500) }).catch((err) => log.warn("Failed to post backend_rebuild_failed event", err));
    }
  }

  await postEvent({ type: "apply_result", runId, success: true, filesChanged, duration });
  process.exit(0);
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  await postEvent({ type: "failed", error: msg }).catch((err) => log.warn("Failed to post failure event", err));
  try {
    sqlite
      .prepare(
        "UPDATE evolution_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?",
      )
      .run(msg.slice(0, 500), new Date().toISOString(), runId);
  } catch {
    // ignore
  }
  process.exit(1);
});
