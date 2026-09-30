/**
 * Host folder rules — which host paths may be handed to an app container.
 *
 * Pure (no DB, no filesystem): shared by the Umbrel 2.0 planner (folder
 * choices, data root), install_app volume mounts and add_volume_mount. The
 * settings-aware checks (configured media/data roots, approvals) live in
 * host-mounts.ts.
 */
import { homedir } from "node:os";
import { posix } from "node:path";

/** System folders an app may never be given — neither the folder itself nor anything below it. */
const PROTECTED_HOST_TREES = [
  "/etc", "/proc", "/sys", "/dev", "/boot", "/root", "/bin", "/sbin", "/usr", "/lib", "/lib32",
  "/lib64", "/libx32", "/var/run", "/run", "/var/lib/docker", "/var/lib/containerd", "/snap",
  "/private/etc", "/private/var/run", "/private/var/root", "/private/var/db", "/System", "/Library",
  "/Applications", "/cores",
];

/** Credential/config folders that must never be handed to an app, wherever they live. */
const PROTECTED_SEGMENTS = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker", ".talome"]);

export function normalizeHostPath(path: string): string {
  const normalized = posix.normalize(path.trim());
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function isSameOrUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
}

/** Folders whose children are user homes (`/home/<user>`, `/Users/<user>`). */
const HOME_PARENTS = ["/home", "/users", "/var/home"];
/** Children of HOME_PARENTS that are shared folders, not a user's home. */
const SHARED_HOME_CHILDREN = new Set(["/users/shared"]);

/**
 * A user's whole home folder, or anything above one. Homes hold credentials
 * and dotfiles (.ssh, .talome, shell history…) that no app may be handed;
 * a folder inside a home (~/Movies) is fine. `folded` is lower-case.
 */
function isHomeOrAbove(folded: string): boolean {
  let home = "";
  try {
    home = normalizeHostPath(homedir()).toLowerCase();
  } catch {
    home = "";
  }
  if (home.startsWith("/") && home !== "/" && isSameOrUnder(home, folded)) return true;
  if (SHARED_HOME_CHILDREN.has(folded)) return false;
  return HOME_PARENTS.some((parent) => folded === parent || posix.dirname(folded) === parent);
}

export interface HostFolderPolicy {
  /** Extra trees to protect (Talome's own data directory, the store cache…). */
  protectedTrees?: string[];
  /** Trees that stay allowed even when inside a protected tree (the app's own data dir). */
  allowedTrees?: string[];
}

/** Problems with how a host path is written, before any folder rule. */
function hostPathSyntaxError(path: string): string | null {
  if (!path.startsWith("/")) return `"${path}" must be an absolute path`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "path contains control characters";
  // ":" and "," change how docker parses a short-syntax volume spec.
  if (/[:,]/.test(path)) return `"${path}" must not contain ":" or ","`;
  if (path.split("/").includes("..")) return `"${path}" must not contain ".."`;
  return null;
}

/** The Docker socket (wherever the runtime puts it): mounting it gives the container the host. */
export function isDockerSocketPath(path: string): boolean {
  return /(^|\/)docker\.sock$/.test(normalizeHostPath(path));
}

/** Validate a user-chosen host folder. Returns an error message or null. */
export function validateHostFolder(path: string, policy: HostFolderPolicy = {}): string | null {
  const syntax = hostPathSyntaxError(path);
  if (syntax) return syntax;
  const normalized = normalizeHostPath(path);
  if (normalized === "/") return `"${path}" is a protected system folder`;
  if (isDockerSocketPath(normalized)) return `"${path}" cannot be mounted`;
  const allowed = (policy.allowedTrees ?? [])
    .filter((root) => root.startsWith("/"))
    .some((root) => isSameOrUnder(normalized, normalizeHostPath(root)));
  if (allowed) return null;
  // Compare case-insensitively: macOS volumes usually are (/home/u/.SSH is
  // ~/.ssh there), and refusing a differently-cased twin costs nothing elsewhere.
  const folded = normalized.toLowerCase();
  if (folded.split("/").some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    return `"${path}" is a protected folder`;
  }
  const extra = (policy.protectedTrees ?? []).filter((root) => root.startsWith("/")).map(normalizeHostPath);
  const roots = [...PROTECTED_HOST_TREES, ...extra].map((root) => root.toLowerCase());
  if (roots.some((root) => isSameOrUnder(folded, root))) {
    return `"${path}" is a protected system folder`;
  }
  // A folder above a protected tree hands the app that tree too (/var holds
  // /var/lib/docker, Talome's home holds its database and secrets).
  if (roots.some((root) => isSameOrUnder(root, folded))) {
    return `"${path}" contains a protected folder`;
  }
  if (isHomeOrAbove(folded)) {
    return `"${path}" is a home folder, which holds protected credentials — choose a folder inside it`;
  }
  return null;
}

/**
 * Validate the host side of a bind mount the owner (or an agent acting for
 * them) asks for: the same rules as validateHostFolder, except that the Docker
 * socket may be mounted — never silently, it always needs the owner's
 * approval (host-mounts.ts). Returns an error message or null.
 */
export function validateBindMountSource(path: string, policy: HostFolderPolicy = {}): string | null {
  const syntax = hostPathSyntaxError(path);
  if (syntax) return syntax;
  if (isDockerSocketPath(path)) return null;
  return validateHostFolder(path, policy);
}
