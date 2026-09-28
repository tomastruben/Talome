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
  timeoutMs?: number;
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
    execFile(
      "rclone",
      args,
      {
        env: { ...(process.env as Record<string, string>), ...(opts.env ?? {}) },
        timeout: opts.timeoutMs ?? 600_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const out = String(stdout ?? "");
        const errOut = String(stderr ?? "");
        if (err) {
          resolveRun({ success: false, stdout: out, stderr: errOut, error: (errOut.trim() || err.message).slice(0, 2000) });
        } else {
          resolveRun({ success: true, stdout: out, stderr: errOut });
        }
      },
    );
  });
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
  const r = await runRclone(["copy", localPath, remotePath, "--stats-one-line"], opts);
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
  const r = await runRclone(["copyto", localFile, remotePath], opts);
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
  const r = await runRclone(["copy", remotePath, localPath], opts);
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
