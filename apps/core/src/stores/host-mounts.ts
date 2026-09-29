/**
 * Host bind mounts requested for an app — add_volume_mount, install_app
 * `volumeMounts` (and Umbrel folder choices), the dashboard install route.
 *
 * Two layers:
 *  - validation: the protected-tree rules of host-folders.ts (system folders,
 *    credential folders, Talome's own data) — refused outright, including
 *    through a symlink;
 *  - approval: the Docker socket, or a folder outside the media/data roots the
 *    owner configured, hands the app far more of the host than a media
 *    folder. For the agent that makes the call destructive (approval in
 *    cautious mode, ai/execution.ts); on the REST route only an admin may.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSetting } from "../utils/settings.js";
import { TALOME_HOME } from "../utils/filesystem.js";
import {
  isDockerSocketPath,
  isSameOrUnder,
  normalizeHostPath,
  validateBindMountSource,
  type HostFolderPolicy,
} from "./host-folders.js";

const APP_DATA_DIR = join(TALOME_HOME, "app-data");
const APP_ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function realPathIfExists(path: string): string | null {
  try {
    return existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

function absolutePaths(values: unknown[]): string[] {
  return values
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.startsWith("/"))
    .map(normalizeHostPath);
}

function settingPathList(key: string): string[] {
  const raw = getSetting(key)?.trim();
  if (!raw) return [];
  if (raw.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? absolutePaths(parsed) : [];
    } catch {
      return [];
    }
  }
  return absolutePaths([raw]);
}

/** The app's own data folder (~/.talome/app-data/<appId>), when the id is a plain folder name. */
function appDataDirFor(appId: string | undefined): string | null {
  return appId && APP_ID_SEGMENT.test(appId) && appId !== "." && appId !== ".." ? join(APP_DATA_DIR, appId) : null;
}

/**
 * Host folders the owner set aside for apps: the media, downloads and books
 * roots, the external drives enabled for the file manager, the optimizer's
 * library paths — plus the app's own data folder.
 */
export function configuredHostRoots(appId?: string): string[] {
  const roots = [
    ...settingPathList("media_root"),
    ...settingPathList("downloads_root"),
    ...settingPathList("books_root"),
    ...settingPathList("file_manager_drives"),
    ...settingPathList("allowed_paths"),
  ].filter((root) => root !== "/");
  const own = appDataDirFor(appId);
  if (own) roots.push(own);
  const withReal = roots.flatMap((root) => {
    const real = realPathIfExists(root);
    return real && real !== root ? [root, real] : [root];
  });
  return [...new Set(withReal)];
}

/** Talome's own state is never an app folder; the app's own data folder is. */
export function hostMountPolicy(appId?: string): HostFolderPolicy {
  const dbDir = dirname(resolve(process.env.DATABASE_PATH || join(process.cwd(), "data", "talome.db")));
  const own = appDataDirFor(appId);
  return { protectedTrees: [TALOME_HOME, dbDir], allowedTrees: own ? [own] : [] };
}

export interface HostMountCheck {
  /** Refused: a protected folder (or a path that resolves to one). */
  error?: string;
  /** Allowed only with the owner's approval: the Docker socket, or outside the configured roots. */
  needsApproval: boolean;
  reason?: string;
}

export function checkHostMount(appId: string | undefined, hostPath: string): HostMountCheck {
  const policy = hostMountPolicy(appId);
  const error = validateBindMountSource(hostPath, policy);
  if (error) return { error, needsApproval: false };

  const candidates = [normalizeHostPath(hostPath)];
  const real = realPathIfExists(candidates[0]);
  if (real && real !== candidates[0]) {
    const realError = validateBindMountSource(real, policy);
    if (realError) return { error: `${hostPath} resolves to ${real} — ${realError}`, needsApproval: false };
    candidates.push(real);
  }

  if (candidates.some(isDockerSocketPath)) {
    return { needsApproval: true, reason: `${hostPath} is the Docker socket — the container would control the host` };
  }
  const roots = configuredHostRoots(appId);
  if (candidates.every((p) => roots.some((root) => isSameOrUnder(p, root)))) return { needsApproval: false };
  return { needsApproval: true, reason: `${hostPath} is outside the media/data folders configured in Settings` };
}

/** Every host path a tool call would bind-mount, with the app it is for. */
function requestedHostMounts(toolName: string, args: Record<string, unknown>): { appId?: string; paths: string[] } {
  const appId = typeof args.appId === "string" ? args.appId : undefined;
  if (toolName === "add_volume_mount") {
    return { appId, paths: typeof args.hostPath === "string" ? [args.hostPath] : [] };
  }
  if (toolName === "install_app") {
    const paths: string[] = [];
    const record = (value: unknown) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const v of Object.values(value as Record<string, unknown>)) if (typeof v === "string" && v.trim()) paths.push(v.trim());
      }
    };
    record(args.volumeMounts);
    const umbrel = args.umbrel as { folders?: unknown; dataRoot?: unknown } | undefined;
    if (umbrel && typeof umbrel === "object") {
      record(umbrel.folders);
      if (typeof umbrel.dataRoot === "string" && umbrel.dataRoot.trim()) paths.push(umbrel.dataRoot.trim());
    }
    return { appId, paths };
  }
  return { appId, paths: [] };
}

/**
 * Whether a tool call mounts the Docker socket or a host folder outside the
 * configured roots (execution.ts escalates it to destructive). Paths that are
 * refused outright are left to the tool, which rejects them.
 */
export function hostMountsNeedApproval(toolName: string, args: Record<string, unknown>): boolean {
  const { appId, paths } = requestedHostMounts(toolName, args);
  return paths.some((path) => {
    const check = checkHostMount(appId, path);
    return !check.error && check.needsApproval;
  });
}

/** First refused mount of an install's volume mapping, as an error message. */
export function volumeMountsError(appId: string, volumeMounts: Record<string, string>): string | null {
  for (const [name, hostPath] of Object.entries(volumeMounts)) {
    if (!hostPath.trim()) continue;
    const check = checkHostMount(appId, hostPath.trim());
    if (check.error) return `Volume "${name}": ${check.error}.`;
  }
  return null;
}

/** Mounts of an install's volume mapping that need the owner (admin) to decide. */
export function volumeMountsNeedingApproval(appId: string, volumeMounts: Record<string, string>): string[] {
  const reasons: string[] = [];
  for (const hostPath of Object.values(volumeMounts)) {
    if (!hostPath.trim()) continue;
    const check = checkHostMount(appId, hostPath.trim());
    if (!check.error && check.needsApproval && check.reason) reasons.push(check.reason);
  }
  return reasons;
}
