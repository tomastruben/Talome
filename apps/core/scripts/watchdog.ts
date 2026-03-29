/**
 * Crash recovery watchdog for the Talome backend.
 *
 * Monitors http://localhost:4000/api/health every 5 seconds.
 * After 6 consecutive failures (30s of downtime), reverts all
 * uncommitted changes via `git stash` so tsx watch can restart
 * with the last known-good code.
 *
 * Writes rollback events to ~/.talome/evolution.log so the Evolution
 * page can show auto-reverts triggered by the watchdog.
 */

import { execSync } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const HEALTH_URL = process.env.HEALTH_URL || "http://localhost:4000/api/health";
const CHECK_INTERVAL = 5_000;
const MAX_FAILURES = 6;
const TALOME_DIR = join(process.env.HOME || "/tmp", ".talome");

let failures = 0;

async function writeEvolutionLog(stashMsg: string) {
  try {
    await mkdir(TALOME_DIR, { recursive: true });
    const logPath = join(TALOME_DIR, "evolution.log");
    const entry = JSON.stringify({
      id: `ev_watchdog_${Date.now()}`,
      timestamp: new Date().toISOString(),
      task: "Watchdog auto-recovery",
      scope: "full",
      filesChanged: [],
      typeErrors: "Server failed to respond after 30s of health checks",
      rolledBack: true,
      duration: MAX_FAILURES * CHECK_INTERVAL,
      stashMessage: stashMsg,
      triggeredBy: "watchdog",
    }) + "\n";
    await appendFile(logPath, entry);
  } catch {
    // Non-fatal — log write failure should never crash the watchdog
  }
}

async function check() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      if (failures > 0) {
        console.log(`[watchdog] Backend recovered after ${failures} failure(s).`);
      }
      failures = 0;
      return;
    }
  } catch {
    // fetch failed or timed out
  }

  failures++;
  console.log(`[watchdog] Health check failed (${failures}/${MAX_FAILURES}).`);

  if (failures >= MAX_FAILURES) {
    console.error(
      `[watchdog] Backend down for ${(failures * CHECK_INTERVAL) / 1000}s — attempting recovery...`,
    );
    recover();
    failures = 0;
  }
}

function recover() {
  try {
    const diff = execSync("git diff --name-only", { encoding: "utf-8" }).trim();
    const untrackedRaw = execSync("git ls-files --others --exclude-standard", {
      encoding: "utf-8",
    }).trim();

    if (!diff && !untrackedRaw) {
      console.log("[watchdog] No uncommitted changes to revert.");
      return;
    }

    const allChanged = [diff, untrackedRaw].filter(Boolean).join("\n");
    console.log(`[watchdog] Reverting:\n${allChanged}`);

    const stashMsg = `watchdog-recovery-${Date.now()}`;
    execSync(`git stash push -u -m "${stashMsg}"`, {
      stdio: "inherit",
    });

    // Record the rollback in evolution.log
    void writeEvolutionLog(stashMsg);

    console.log(
      "[watchdog] Changes stashed. tsx watch should restart with clean code.",
    );
    console.log(
      "[watchdog] To restore: git stash list  →  git stash pop",
    );
  } catch (err) {
    console.error("[watchdog] Recovery failed:", err);
  }
}

// Signal to the server that watchdog protection is active
process.env.TALOME_WATCHDOG = "true";

console.log(`[watchdog] Monitoring ${HEALTH_URL} every ${CHECK_INTERVAL / 1000}s`);
console.log(`[watchdog] Will recover after ${MAX_FAILURES} consecutive failures`);
setInterval(check, CHECK_INTERVAL);
