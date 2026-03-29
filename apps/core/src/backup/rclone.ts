/**
 * rclone wrapper — sync local backups to cloud storage.
 * Supports any rclone remote (S3, B2, GDrive, etc.).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Check if rclone is installed */
export async function rcloneCheck(): Promise<{ installed: boolean; version?: string }> {
  try {
    const { stdout } = await execAsync("rclone version --check", { timeout: 5000 });
    const versionMatch = stdout.match(/rclone\s+v([\d.]+)/);
    return { installed: true, version: versionMatch?.[1] };
  } catch {
    return { installed: false };
  }
}

/** List configured rclone remotes */
export async function rcloneListRemotes(): Promise<{ success: boolean; remotes?: string[]; error?: string }> {
  try {
    const { stdout } = await execAsync("rclone listremotes", { timeout: 10000 });
    const remotes = stdout.trim().split("\n").filter(Boolean).map((r) => r.replace(/:$/, ""));
    return { success: true, remotes };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Sync a local directory to an rclone remote path */
export async function rcloneSync(
  localPath: string,
  remotePath: string,
): Promise<{ success: boolean; output?: string; error?: string }> {
  try {
    const { stdout, stderr } = await execAsync(
      `rclone copy "${localPath}" "${remotePath}" --progress --stats-one-line`,
      { timeout: 600_000 }, // 10 min timeout for large backups
    );
    return { success: true, output: (stdout + stderr).trim() };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Upload a single file to an rclone remote */
export async function rcloneCopyFile(
  localFile: string,
  remotePath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    await execAsync(
      `rclone copyto "${localFile}" "${remotePath}" --progress`,
      { timeout: 600_000 },
    );
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Check if a remote path exists */
export async function rcloneExists(
  remotePath: string,
): Promise<boolean> {
  try {
    await execAsync(`rclone lsf "${remotePath}" --max-depth 0`, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
