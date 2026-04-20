import { join } from "node:path";
import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  spawnProcess,
  spawnClaudeStreaming,
  getChangedFiles,
  runTypecheck,
  stashRollback,
} from "./claude-process.js";

export const PROJECT_ROOT = resolve(process.cwd(), "../..");

const SCREENSHOTS_DIR = join(homedir(), ".talome", "evolution-screenshots");

/**
 * Screenshot retention. Bug-hunt flows drop user-attached screenshots here
 * as visual context for Claude Code. They can contain sensitive content
 * (forms, API keys on screen). Keep only the last 14 days so old context
 * doesn't linger on disk.
 */
const SCREENSHOT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

async function sweepOldScreenshots() {
  try {
    const entries = await readdir(SCREENSHOTS_DIR);
    const cutoff = Date.now() - SCREENSHOT_RETENTION_MS;
    for (const name of entries) {
      try {
        const full = join(SCREENSHOTS_DIR, name);
        const s = await stat(full);
        if (s.isFile() && s.mtimeMs < cutoff) await unlink(full);
      } catch { /* best-effort per file */ }
    }
  } catch { /* dir missing — nothing to do */ }
}

// Sweep once at module load, then daily. `.unref()` so this timer doesn't
// keep the event loop alive on graceful shutdown.
sweepOldScreenshots();
setInterval(sweepOldScreenshots, 24 * 60 * 60 * 1000).unref?.();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClaudeRunOptions {
  /** The task description / prompt passed to Claude Code */
  task: string;
  /** Working directory for the Claude Code process */
  cwd: string;
  /**
   * headless: runs `claude --dangerously-skip-permissions --print <task>` (non-interactive)
   * interactive: emits a tmux command string — caller is responsible for sending it to a terminal
   */
  mode: "headless" | "interactive";
  /** Called with each stdout chunk as it arrives (headless only) */
  onOutput?: (chunk: string) => void;
  /** Run `pnpm exec tsc --noEmit` after Claude Code finishes (headless only) */
  runTypecheck?: boolean;
  /** Directory to run typecheck in (defaults to cwd) */
  typecheckDir?: string;
  /**
   * Automatically stash + revert via `git stash push` if typecheck fails.
   * Only applies when runTypecheck is true.
   */
  autoRollback?: boolean;
  /**
   * Absolute paths to image files that Claude Code should read as visual context.
   * Appended as a note at the end of the task prompt.
   */
  screenshotPaths?: string[];
}

export interface ClaudeRunResult {
  success: boolean;
  /** Only set in interactive mode */
  command?: string;
  /** stdout from the Claude Code process (headless only) */
  output?: string;
  /** Files changed (headless only, detected via git diff) */
  filesChanged?: string[];
  /** Whether typecheck passed */
  typecheckPassed?: boolean;
  /** Raw typecheck errors if typecheck failed */
  typeErrors?: string;
  /** Whether changes were automatically reverted */
  rolledBack?: boolean;
  /** The git stash message used for rollback (if any) */
  stashMessage?: string;
  /** Error message if the run failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildTmuxCommand(projectRoot: string): string {
  const unset = "unset CLAUDECODE;";
  const quoted = projectRoot.includes(" ") ? `"${projectRoot}"` : projectRoot;
  const tmuxCmd = `tmux new-session -A -s talome-claude -c ${quoted} "claude --continue"`;
  const fallback = `cd ${quoted} && claude --continue`;
  return `${unset} if command -v tmux >/dev/null 2>&1; then ${tmuxCmd}; else ${fallback}; fi`;
}

function appendScreenshotNote(task: string, paths: string[]): string {
  if (paths.length === 0) return task;
  return (
    task +
    `\n\nVisual references for this task have been saved at:\n${paths.map((p) => `  - ${p}`).join("\n")}\nStudy these images carefully before making any UI changes.`
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save base64 data URL images to disk so Claude Code can read them.
 * Returns absolute file paths.
 */
export async function saveScreenshots(dataUrls: string[]): Promise<string[]> {
  if (dataUrls.length === 0) return [];
  await mkdir(SCREENSHOTS_DIR, { recursive: true });
  const ts = Date.now();
  const paths: string[] = [];

  for (let i = 0; i < dataUrls.length; i++) {
    const url = dataUrls[i];
    // Strip data URL prefix: "data:image/png;base64,<data>"
    const base64 = url.includes(",") ? url.split(",")[1] : url;
    const ext = url.startsWith("data:image/jpeg") ? "jpg"
      : url.startsWith("data:image/gif") ? "gif"
      : url.startsWith("data:image/webp") ? "webp"
      : "png";
    const filePath = join(SCREENSHOTS_DIR, `${ts}-${i}.${ext}`);
    await writeFile(filePath, Buffer.from(base64, "base64"));
    paths.push(filePath);
  }

  return paths;
}

/**
 * Run Claude Code in headless or interactive mode.
 *
 * - headless: spawns `claude --dangerously-skip-permissions --print <task>`,
 *   optionally runs typecheck + auto-rollback, returns a full result.
 * - interactive: returns the tmux command string to send to a terminal session;
 *   no process is spawned here.
 */
export async function runClaudeCode(opts: ClaudeRunOptions): Promise<ClaudeRunResult> {
  const {
    cwd,
    mode,
    onOutput,
    runTypecheck: doTypecheck = false,
    typecheckDir,
    autoRollback = false,
    screenshotPaths = [],
  } = opts;

  if (mode === "interactive") {
    return {
      success: true,
      command: buildTmuxCommand(cwd),
    };
  }

  // Headless mode
  const task = appendScreenshotNote(opts.task, screenshotPaths);
  const start = Date.now();

  const { code, stdout, stderr } = await spawnClaudeStreaming(task, cwd, onOutput);

  if (code !== 0 && !stdout) {
    return {
      success: false,
      error: stderr || `Claude Code exited with code ${code}`,
      durationMs: Date.now() - start,
    };
  }

  const filesChanged = await getChangedFiles(cwd);

  if (!doTypecheck) {
    return {
      success: true,
      output: stdout,
      filesChanged,
      typecheckPassed: undefined,
      durationMs: Date.now() - start,
    };
  }

  const checkDir = typecheckDir ?? cwd;
  const { ok, errors } = await runTypecheck(checkDir);

  if (!ok && autoRollback) {
    const stashMessage = await stashRollback(cwd);
    return {
      success: false,
      output: stdout,
      filesChanged,
      typecheckPassed: false,
      typeErrors: errors,
      rolledBack: true,
      stashMessage,
      durationMs: Date.now() - start,
    };
  }

  return {
    success: ok,
    output: stdout,
    filesChanged,
    typecheckPassed: ok,
    typeErrors: ok ? undefined : errors,
    rolledBack: false,
    durationMs: Date.now() - start,
  };
}
