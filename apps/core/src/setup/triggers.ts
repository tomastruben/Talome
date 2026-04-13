/**
 * Setup Triggers — Three paths into the setup loop.
 *
 * 1. Post-install: when an app from the registry is installed
 * 2. Scheduled: 6-hour cadence check in the monitor loop
 * 3. Manual: via API endpoint or AI tool
 */

import { APP_REGISTRY } from "../app-registry/index.js";
import { getSetting } from "../utils/settings.js";
import { isSetupRunning, startSetupRun } from "./loop.js";
import { computeHealthScore } from "./health-score.js";

let lastScheduledCheck = 0;
const SCHEDULED_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function isAutoConfigureEnabled(): boolean {
  const val = getSetting("setup_auto_configure");
  return val === "true" || val === "1";
}

/** Called when an app is installed. Starts setup if auto-configure is enabled. */
export async function onAppInstalled(appId: string): Promise<void> {
  // Only trigger for registry apps
  if (!APP_REGISTRY[appId.toLowerCase()]) return;

  // Check if auto-configure is enabled
  if (!isAutoConfigureEnabled()) return;

  // Don't start if already running
  if (isSetupRunning()) return;

  try {
    await startSetupRun("app_installed");
  } catch {
    // Setup failed to start — not critical
  }
}

/** Called from the monitor loop every 60s. Internally gates to 6-hour cadence. */
export async function maybeRunScheduledSetup(): Promise<void> {
  const now = Date.now();
  if (now - lastScheduledCheck < SCHEDULED_INTERVAL_MS) return;
  lastScheduledCheck = now;

  if (!isAutoConfigureEnabled()) return;
  if (isSetupRunning()) return;

  // Only start if health < 100%
  try {
    const health = await computeHealthScore();
    if (health.overall >= 100) return;
    if (health.total === 0) return; // No registry apps installed

    await startSetupRun("scheduled");
  } catch {
    // Not critical
  }
}
