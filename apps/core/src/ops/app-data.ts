/**
 * An uninstalled app's own data folder (~/.talome/app-data/<appId>).
 *
 * Uninstall keeps it by default, so a reinstall picks up where the app left
 * off. The owner may ask to erase it too ("Keep app data" off); this module
 * does that, and only that: it never follows a symlink out of the folder,
 * never touches host folders an app mounted (media, downloads, drives), and
 * refuses while the app is still installed.
 */
import { lstat, rm, unlink } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { APP_DATA_DIR } from "../stores/compose-exec.js";

/** A plain folder name: what an app id must be before it is joined onto a path. */
const APP_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The data folder for an app id, or null when the id is not a plain folder name. */
export function appDataDirFor(appId: string): string | null {
  if (!APP_ID_SEGMENT.test(appId) || appId === "." || appId === "..") return null;
  const dir = join(APP_DATA_DIR, appId);
  // Belt and braces: the folder must sit directly under APP_DATA_DIR.
  return dirname(resolve(dir)) === resolve(APP_DATA_DIR) ? dir : null;
}

export type RemoveAppDataResult =
  | { removed: true; path: string }
  | { removed: false; path: string | null; reason: "invalid_id" | "still_installed" | "not_found" | "failed"; error?: string };

/** Erase an uninstalled app's data folder. Never throws. */
export async function removeAppData(appId: string): Promise<RemoveAppDataResult> {
  const dir = appDataDirFor(appId);
  if (!dir) return { removed: false, path: null, reason: "invalid_id" };

  const installed = db
    .select({ appId: schema.installedApps.appId })
    .from(schema.installedApps)
    .where(eq(schema.installedApps.appId, appId))
    .get();
  if (installed) return { removed: false, path: dir, reason: "still_installed" };

  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink()) {
      // Remove the link itself, never what it points at.
      await unlink(dir);
    } else {
      await rm(dir, { recursive: true, force: true });
    }
    return { removed: true, path: dir };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: false, path: dir, reason: "not_found" };
    return { removed: false, path: dir, reason: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
