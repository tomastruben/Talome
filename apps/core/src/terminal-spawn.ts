/**
 * Shared terminal daemon lifecycle utilities.
 *
 * Used by both index.ts (startup + health check) and the terminal route
 * (ensure-daemon endpoint) to manage the daemon process.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DAEMON_PORT } from "./terminal-constants.js";

const PID_FILE = join(homedir(), ".talome", "terminal-daemon.pid");

/** Check if the daemon process is alive via its PID file. */
export function isDaemonAlive(): boolean {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf-8").trim());
    if (!pid || isNaN(pid)) return false;
    process.kill(pid, 0); // existence check only
    return true;
  } catch {
    return false;
  }
}

/** Spawn the daemon as a detached child that outlives this process. */
export function spawnDaemon(): boolean {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const isDev = !!process.env.TSX;

  // In dev mode (tsx), the compiled .js doesn't exist — use tsx to run .ts directly.
  // In prod, node runs the compiled .js.
  const projectRoot = resolve(__dirname, isDev ? ".." : "../..");
  const daemonScript = isDev
    ? resolve(__dirname, "terminal-daemon.ts")
    : resolve(__dirname, "terminal-daemon.js");

  let cmd: string;
  let args: string[];

  if (isDev) {
    // Use local tsx binary from node_modules
    cmd = resolve(projectRoot, "node_modules", ".bin", "tsx");
    args = ["--env-file=.env", daemonScript];
  } else {
    cmd = process.execPath;
    args = ["--env-file=.env", daemonScript];
  }

  try {
    const child = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
      cwd: projectRoot,
      env: { ...process.env },
    });
    child.unref();
    console.log(`[terminal-spawn] Daemon spawned (pid ${child.pid}, dev=${isDev})`);
    return true;
  } catch (err) {
    console.error("[terminal-spawn] Failed to spawn daemon:", err);
    return false;
  }
}

/**
 * Ensure the daemon is running. If it's not alive, spawn it and wait
 * for the health endpoint to respond (up to 5s).
 */
export async function ensureDaemonRunning(): Promise<{ running: boolean; spawned: boolean }> {
  // Quick check — is it already alive?
  try {
    const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) return { running: true, spawned: false };
  } catch {
    // Not responding — check PID and potentially respawn
  }

  if (isDaemonAlive()) {
    // Process exists but not responding to HTTP yet — give it a moment
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { running: true, spawned: false };
    } catch { /* still not ready */ }
  }

  // Spawn a new daemon
  const spawned = spawnDaemon();
  if (!spawned) return { running: false, spawned: false };

  // Poll for readiness (up to 5s)
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return { running: true, spawned: true };
    } catch { /* not ready yet */ }
  }

  return { running: false, spawned: true };
}
