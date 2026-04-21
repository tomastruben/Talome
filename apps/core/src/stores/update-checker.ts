/**
 * App update checker — compares installed app versions against the catalog.
 */

import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { writeNotification } from "../db/notifications.js";

interface InstalledRow {
  app_id: string;
  version: string;
  store_source_id: string;
}

interface CatalogRow {
  app_id: string;
  version: string;
  name: string;
}

export interface AppUpdate {
  appId: string;
  name: string;
  installedVersion: string;
  availableVersion: string;
}

/**
 * Check all installed apps for available updates.
 * Returns a list of apps with newer versions in the catalog.
 */
export function checkForUpdates(): AppUpdate[] {
  const installed = db.all(
    sql`SELECT app_id, version, store_source_id FROM installed_apps`,
  ) as InstalledRow[];

  const updates: AppUpdate[] = [];

  for (const app of installed) {
    const catalog = db.get(
      sql`SELECT app_id, version, name FROM app_catalog WHERE app_id = ${app.app_id} AND store_source_id = ${app.store_source_id}`,
    ) as CatalogRow | undefined;

    if (!catalog) continue;

    // Skip "latest" versions — can't compare meaningfully
    if (catalog.version === "latest" || app.version === "latest") continue;

    if (catalog.version !== app.version) {
      updates.push({
        appId: app.app_id,
        name: catalog.name ?? app.app_id,
        installedVersion: app.version,
        availableVersion: catalog.version,
      });
    }
  }

  return updates;
}

/**
 * Run update check and notify if updates are available.
 * Called from the monitor loop on a longer cadence (e.g. every 6 hours).
 */
let lastUpdateCheckAt = 0;
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Track which update sets have been notified to avoid duplicate notifications.
// Key: sorted comma-joined appIds, Value: timestamp of last notification.
let lastNotifiedKey = "";
let lastNotifiedAt = 0;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export function maybeCheckUpdates(): void {
  if (Date.now() - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL_MS) return;
  lastUpdateCheckAt = Date.now();

  try {
    const updates = checkForUpdates();
    if (updates.length === 0) return;

    // Deduplicate: only notify if the set of updatable apps changed or 24h passed
    const key = updates.map((u) => u.appId).sort().join(",");
    if (key === lastNotifiedKey && Date.now() - lastNotifiedAt < DEDUP_WINDOW_MS) {
      return; // Same updates, already notified within window
    }

    lastNotifiedKey = key;
    lastNotifiedAt = Date.now();

    const names = updates.map((u) => u.name).join(", ");
    writeNotification(
      "info",
      `${updates.length} app update${updates.length > 1 ? "s" : ""} available`,
      `Updates available for: ${names}`,
    );
  } catch (err) {
    console.error("[update-checker] Error:", err);
  }
}
