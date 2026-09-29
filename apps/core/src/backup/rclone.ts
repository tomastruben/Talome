/**
 * rclone wrapper — copy local backups to cloud storage.
 * Supports any rclone remote (S3, B2, GDrive, SFTP, ...).
 *
 * Security: rclone is always invoked with an argument array (no shell), and
 * credentials are passed only through RCLONE_CONFIG_* environment variables
 * — never on the command line, where they would show up in `ps` output.
 */

import { execFile } from "node:child_process";

export interface RcloneOptions {
  /** Extra environment (e.g. RCLONE_CONFIG_<REMOTE>_* credentials) */
  env?: Record<string, string>;
  /** Hard limit for the whole command; 0 = none. Default 10 min, none for transfers. */
  timeoutMs?: number;
  /**
   * Abort when rclone reports no transfer progress for this long (transfers
   * only; they print their stats every 30 s). Default 15 min for transfers.
   */
  stallTimeoutMs?: number;
  /** Cancels the command (the caller's operation was cancelled) */
  signal?: AbortSignal;
}

/**
 * Transfers (backup uploads, downloads for verification/recovery) can take
 * hours for large archives on a home uplink, so they get no fixed timeout —
 * only a stall timeout (rclone itself also retries and times out idle
 * connections).
 */
export const TRANSFER_STALL_TIMEOUT_MS = 15 * 60 * 1000;
/** Periodic one-line stats on stderr (at NOTICE, so they print without -v) — the progress signal. */
const TRANSFER_STATS_ARGS = ["--stats", "30s", "--stats-one-line", "--stats-log-level", "NOTICE"];

/**
 * The "transferred" amount of an rclone stats line
 * ("… NOTICE:   1.234 GiB / 5 GiB, 24%, 10 MiB/s, ETA 6m"), or null.
 */
export function parseTransferred(line: string): string | null {
  const m = line.match(/(\d+(?:\.\d+)?\s*[A-Za-z]*)\s*\/\s*\d+(?:\.\d+)?\s*[A-Za-z]*,\s*(?:\d+%|-)/);
  return m ? m[1].replace(/\s+/g, "") : null;
}

export interface RcloneRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

function assertSafeArg(value: string): void {
  if (value.startsWith("-")) throw new Error(`Refusing rclone path that looks like a flag: ${value}`);
}

/** Run rclone with an argument array. Never throws. */
export function runRclone(args: string[], opts: RcloneOptions = {}): Promise<RcloneRunResult> {
  return new Promise((resolveRun) => {
    let stalledAfterMs: number | null = null;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let child: ReturnType<typeof execFile> | undefined;
    try {
      child = execFile(
        "rclone",
        args,
        {
          env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
          timeout: opts.timeoutMs ?? 600_000,
          maxBuffer: 10 * 1024 * 1024,
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        (err, stdout, stderr) => {
          if (watchdog) clearInterval(watchdog);
          const out = String(stdout ?? "");
          const errOut = String(stderr ?? "");
          if (stalledAfterMs !== null) {
            resolveRun({
              success: false,
              stdout: out,
              stderr: errOut,
              error: `rclone made no progress for ${Math.round(stalledAfterMs / 60_000)} min — aborted`,
            });
          } else if (err) {
            resolveRun({ success: false, stdout: out, stderr: errOut, error: (errOut.trim() || err.message).slice(0, 2000) });
          } else {
            resolveRun({ success: true, stdout: out, stderr: errOut });
          }
        },
      );
    } catch (err) {
      resolveRun({ success: false, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const stallMs = opts.stallTimeoutMs;
    if (!stallMs || stallMs <= 0 || !child) return;
    // Stall detection: any change of the transferred amount counts as progress
    let lastProgressAt = Date.now();
    let lastTransferred: string | null = null;
    let pending = "";
    const onOutput = (chunk: Buffer | string) => {
      pending += String(chunk);
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const transferred = parseTransferred(line);
        if (transferred !== null && transferred !== lastTransferred) {
          lastTransferred = transferred;
          lastProgressAt = Date.now();
        }
      }
    };
    child.stderr?.on("data", onOutput);
    child.stdout?.on("data", onOutput);
    const running = child;
    watchdog = setInterval(() => {
      if (Date.now() - lastProgressAt < stallMs) return;
      stalledAfterMs = stallMs;
      if (watchdog) clearInterval(watchdog);
      running.kill("SIGTERM");
    }, Math.max(10, Math.min(Math.floor(stallMs / 4), 30_000)));
    watchdog.unref?.();
  });
}

function transferOptions(opts: RcloneOptions): RcloneOptions {
  return { ...opts, timeoutMs: opts.timeoutMs ?? 0, stallTimeoutMs: opts.stallTimeoutMs ?? TRANSFER_STALL_TIMEOUT_MS };
}

/** Check if rclone is installed */
export async function rcloneCheck(): Promise<{ installed: boolean; version?: string }> {
  const r = await runRclone(["version"], { timeoutMs: 5000 });
  if (!r.success) return { installed: false };
  const versionMatch = r.stdout.match(/rclone\s+v([\d.]+)/);
  return { installed: true, version: versionMatch?.[1] };
}

/** List configured rclone remotes */
export async function rcloneListRemotes(opts: RcloneOptions = {}): Promise<{ success: boolean; remotes?: string[]; error?: string }> {
  const r = await runRclone(["listremotes"], { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  if (!r.success) return { success: false, error: r.error };
  const remotes = r.stdout.trim().split("\n").filter(Boolean).map((line) => line.replace(/:$/, ""));
  return { success: true, remotes };
}

/** Copy a local directory to an rclone remote path */
export async function rcloneSync(
  localPath: string,
  remotePath: string,
  opts: RcloneOptions = {},
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    assertSafeArg(localPath);
    assertSafeArg(remotePath);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const r = await runRclone(["copy", localPath, remotePath, ...TRANSFER_STATS_ARGS], transferOptions(opts));
  return r.success ? { success: true, output: (r.stdout + r.stderr).trim() } : { success: false, error: r.error };
}

/** Upload a single file to an rclone remote */
export async function rcloneCopyFile(
  localFile: string,
  remotePath: string,
  opts: RcloneOptions = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    assertSafeArg(localFile);
    assertSafeArg(remotePath);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const r = await runRclone(["copyto", localFile, remotePath, ...TRANSFER_STATS_ARGS], transferOptions(opts));
  return r.success ? { success: true } : { success: false, error: r.error };
}

/** Download a remote directory to a local path */
export async function rcloneCopyFrom(
  remotePath: string,
  localPath: string,
  opts: RcloneOptions = {},
): Promise<{ success: boolean; error?: string }> {
  try {
    assertSafeArg(localPath);
    assertSafeArg(remotePath);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const r = await runRclone(["copy", remotePath, localPath, ...TRANSFER_STATS_ARGS], transferOptions(opts));
  return r.success ? { success: true } : { success: false, error: r.error };
}

/** Delete a remote directory and its contents */
export async function rclonePurge(remotePath: string, opts: RcloneOptions = {}): Promise<{ success: boolean; error?: string }> {
  try {
    assertSafeArg(remotePath);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const r = await runRclone(["purge", remotePath], { ...opts, timeoutMs: opts.timeoutMs ?? 120_000 });
  return r.success ? { success: true } : { success: false, error: r.error };
}

/** Check if a remote path exists */
export async function rcloneExists(remotePath: string, opts: RcloneOptions = {}): Promise<boolean> {
  try {
    assertSafeArg(remotePath);
  } catch {
    return false;
  }
  const r = await runRclone(["lsf", remotePath, "--max-depth", "1"], { ...opts, timeoutMs: opts.timeoutMs ?? 10_000 });
  return r.success;
}
