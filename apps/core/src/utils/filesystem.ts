import { join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { existsSync, readdirSync, statSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { getSetting } from "./settings.js";

export const TALOME_HOME = join(homedir(), ".talome");

// ── Legacy migration: ~/.talon → ~/.talome ─────────────────────────────────
// One-time rename so existing installs keep their data after the rebrand.
const legacyHome = join(homedir(), ".talon");
if (existsSync(legacyHome) && !existsSync(TALOME_HOME)) {
  try {
    renameSync(legacyHome, TALOME_HOME);
    console.log(`[migration] Renamed ${legacyHome} → ${TALOME_HOME}`);
  } catch (err) {
    console.error(`[migration] Failed to rename ${legacyHome}:`, err);
  }
}

// Sandboxed root directories the file manager can access
// Core roots are always available; external drives require explicit opt-in via settings
export const CORE_ROOTS = [TALOME_HOME];

let cachedExternalDrives: string[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30_000; // re-detect every 30s

/** Detect mounted external drives based on platform conventions. */
export function detectExternalDrives(): string[] {
  const drives: string[] = [];
  const os = platform();

  try {
    if (os === "darwin") {
      // macOS: external drives mount under /Volumes/
      // Exclude the boot volume (usually "Macintosh HD")
      if (existsSync("/Volumes")) {
        const entries = readdirSync("/Volumes", { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const fullPath = join("/Volumes", entry.name);
          // Skip the root volume (symlink to /)
          try {
            const volumeDev = statSync(fullPath).dev;
            const rootDev = statSync("/").dev;
            if (volumeDev === rootDev) continue; // same device as root = boot volume
          } catch { /* can't stat — skip */ continue; }
          drives.push(fullPath);
        }
      }
    } else {
      // Linux: common external mount points
      const mountDirs = ["/media", "/mnt", "/run/media"];
      for (const base of mountDirs) {
        if (!existsSync(base)) continue;
        try {
          const entries = readdirSync(base, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const fullPath = join(base, entry.name);
            // /media/<user>/<drive> pattern — go one level deeper
            if (base === "/media" || base === "/run/media") {
              try {
                const subEntries = readdirSync(fullPath, { withFileTypes: true });
                for (const sub of subEntries) {
                  if (sub.isDirectory()) drives.push(join(fullPath, sub.name));
                }
              } catch { /* no access */ }
            } else {
              drives.push(fullPath);
            }
          }
        } catch { /* no access to mount dir */ }
      }
    }
  } catch { /* detection failed — return empty */ }

  return drives;
}

/** All detected external drives (before user filtering). */
export function getDetectedDrives(): string[] {
  const now = Date.now();
  if (!cachedExternalDrives || now - cacheTimestamp > CACHE_TTL_MS) {
    cachedExternalDrives = detectExternalDrives();
    cacheTimestamp = now;
  }
  return cachedExternalDrives;
}

/** Returns allowed root directories: core roots + explicitly enabled external drives.
 *  Secure by default — no external drives until the user enables them in settings. */
export function getAllowedRoots(): string[] {
  const raw = getSetting("file_manager_drives");

  // No setting configured yet — only core roots (secure by default)
  if (!raw) return [...CORE_ROOTS];

  try {
    const allowed: string[] = JSON.parse(raw);
    const detected = getDetectedDrives();
    // Only include drives that are both allowed AND currently detected/existing
    const enabled = allowed.filter((d) => detected.includes(d) || existsSync(d));
    return [...CORE_ROOTS, ...enabled];
  } catch {
    return [...CORE_ROOTS];
  }
}

export function isAllowed(absPath: string): boolean {
  // Resolve symlinks to prevent path traversal via symlinked directories
  let resolved: string;
  try {
    resolved = realpathSync(resolve(absPath));
  } catch {
    // Path doesn't exist yet (e.g., creating a new file) — use logical resolution
    resolved = resolve(absPath);
  }
  return getAllowedRoots().some((root) => {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      realRoot = root;
    }
    return resolved === realRoot || resolved.startsWith(realRoot + "/");
  });
}

/** Clear the drive detection cache so the next call re-detects. */
export function invalidateDriveCache(): void {
  cachedExternalDrives = null;
}

export function sanitizePath(userPath: string): string {
  if (!userPath.startsWith("/")) {
    return resolve(CORE_ROOTS[0], userPath);
  }
  return resolve(userPath);
}

/**
 * Atomic file write: writes to a .tmp file then renames in one operation.
 * If the process crashes mid-write, the original file is untouched.
 * rename() is atomic on POSIX filesystems (same mount point).
 */
export function atomicWriteFileSync(filePath: string, data: string | Buffer, encoding?: BufferEncoding): void {
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, data, encoding ? { encoding } : undefined);
  renameSync(tmpPath, filePath);
}
