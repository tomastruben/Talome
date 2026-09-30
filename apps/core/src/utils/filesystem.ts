import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, renameSync, realpathSync } from "node:fs";
import { getSetting } from "./settings.js";

export const TALOME_HOME = join(homedir(), ".talome");
/**
 * The only Talome-managed directory exposed by the file manager.
 *
 * Keeping this separate from TALOME_HOME prevents users with Files access from
 * browsing secrets, databases, backups, app data, and other operational state.
 */
export const TALOME_FILES_HOME = join(TALOME_HOME, "files");

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

try {
  mkdirSync(TALOME_FILES_HOME, { recursive: true });
} catch (err) {
  // A disconnected external drive may leave ~/.talome as a dangling symlink.
  // Do not fall back to the internal disk; the file manager will fail closed.
  console.error(`[files] Could not initialize ${TALOME_FILES_HOME}:`, err);
}

// Sandboxed root directories the file manager can access.
// External drives require explicit opt-in via settings.
export const CORE_ROOTS = [TALOME_FILES_HOME];

export interface FileManagerRoot {
  id: string;
  path: string;
  label: string;
  kind: "talome-files" | "external";
  isEmpty?: boolean;
  hostMount?: string;
  hostLabel?: string;
}

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

function isPathWithin(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Empty user storage is useful as a secure upload sandbox, but it should not
 * occupy prime UI space. If the directory cannot be inspected, fail visible
 * instead of hiding a potentially populated or unavailable location.
 */
function isDirectoryEmpty(directory: string): boolean {
  try {
    return readdirSync(directory).length === 0;
  } catch {
    return false;
  }
}

/**
 * Canonicalize an existing path, or resolve its closest existing ancestor when
 * the final path does not exist yet. The latter is required for safe uploads,
 * mkdir, and rename operations beneath symlinked roots.
 */
export function canonicalizePath(inputPath: string): string | null {
  if (!inputPath || inputPath.includes("\0")) return null;

  let cursor = resolve(inputPath);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const realAncestor = realpathSync(cursor);
      return resolve(realAncestor, ...missingSegments.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

/** Talome runtime state is never exposed through an enabled parent drive. */
function isProtectedTalomeRuntimePath(canonicalPath: string): boolean {
  const canonicalTalomeHome = canonicalizePath(TALOME_HOME);
  const canonicalFilesHome = canonicalizePath(TALOME_FILES_HOME);
  if (!canonicalTalomeHome || !isPathWithin(canonicalPath, canonicalTalomeHome)) return false;
  return !canonicalFilesHome || !isPathWithin(canonicalPath, canonicalFilesHome);
}

export function isAllowed(absPath: string): boolean {
  const canonicalPath = canonicalizePath(absPath);
  if (!canonicalPath || isProtectedTalomeRuntimePath(canonicalPath)) return false;

  return getAllowedRoots().some((root) => {
    const canonicalRoot = canonicalizePath(root);
    return canonicalRoot ? isPathWithin(canonicalPath, canonicalRoot) : false;
  });
}

/** Exact, canonical root comparison for destructive-operation guards. */
export function isAllowedRoot(absPath: string): boolean {
  const canonicalPath = canonicalizePath(absPath);
  if (!canonicalPath) return false;
  return getAllowedRoots().some((root) => canonicalizePath(root) === canonicalPath);
}

/** Root metadata used by the Files UI without exposing canonical host paths. */
export function getAllowedRootInfos(): FileManagerRoot[] {
  return getAllowedRoots()
    .filter((root) => existsSync(root))
    .map((root) => {
      if (resolve(root) === resolve(TALOME_FILES_HOME)) {
        const canonicalRoot = canonicalizePath(root);
        const hostDrive = canonicalRoot
          ? getDetectedDrives()
            .map((drive) => ({ drive, canonical: canonicalizePath(drive) }))
            .filter((entry): entry is { drive: string; canonical: string } => !!entry.canonical)
            .filter((entry) => isPathWithin(canonicalRoot, entry.canonical))
            .sort((a, b) => b.canonical.length - a.canonical.length)[0]
          : undefined;

        return {
          id: "talome-files",
          path: root,
          label: "Talome Files",
          kind: "talome-files" as const,
          isEmpty: isDirectoryEmpty(root),
          hostMount: hostDrive?.drive,
          hostLabel: hostDrive ? basename(hostDrive.drive) : undefined,
        };
      }

      return {
        id: `external:${root}`,
        path: root,
        label: basename(root) || root,
        kind: "external" as const,
        hostMount: root,
        hostLabel: basename(root) || root,
      };
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
