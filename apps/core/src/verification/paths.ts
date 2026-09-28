/**
 * Path helpers for cross-container path mapping checks.
 *
 * Apps see the same host directory under different container paths. To prove
 * that e.g. qBittorrent's save path is the folder Sonarr imports from, both
 * container paths are translated to host paths via each container's mounts.
 */

import { posix } from "node:path";
import type { MountInfo } from "./env.js";

export function normalizePath(p: string): string {
  const trimmed = p.trim().replace(/\\/g, "/");
  if (!trimmed) return "";
  const normalized = posix.normalize(trimmed);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** True when `child` is `parent` or lives underneath it. */
export function isSameOrUnder(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (!c || !p) return false;
  if (c === p) return true;
  return c.startsWith(p === "/" ? "/" : `${p}/`);
}

/** True when one path contains the other (either direction). */
export function pathsOverlap(a: string, b: string): boolean {
  return isSameOrUnder(a, b) || isSameOrUnder(b, a);
}

/** Translate a container path to a host path using the longest matching mount. */
export function toHostPath(containerPath: string, mounts: MountInfo[] | null | undefined): string | null {
  if (!mounts || mounts.length === 0) return null;
  const target = normalizePath(containerPath);
  let best: MountInfo | null = null;
  for (const m of mounts) {
    if (!isSameOrUnder(target, m.destination)) continue;
    if (!best || normalizePath(m.destination).length > normalizePath(best.destination).length) best = m;
  }
  if (!best) return null;
  const dest = normalizePath(best.destination);
  const rest = dest === "/" ? target : target.slice(dest.length);
  return normalizePath(`${normalizePath(best.source)}/${rest}`);
}

export interface RemotePathMapping {
  host?: string;
  remotePath: string;
  localPath: string;
}

/** Apply an *arr remote path mapping (download-client path → path inside the *arr). */
export function applyRemotePathMappings(
  path: string,
  mappings: RemotePathMapping[],
  clientHost?: string,
): { path: string; mapping?: RemotePathMapping } {
  const target = normalizePath(path);
  const candidates = mappings
    .filter((m) => !clientHost || !m.host || m.host.toLowerCase() === clientHost.toLowerCase())
    .filter((m) => isSameOrUnder(target, m.remotePath))
    .sort((a, b) => normalizePath(b.remotePath).length - normalizePath(a.remotePath).length);
  const mapping = candidates[0];
  if (!mapping) return { path: target };
  const rest = target.slice(normalizePath(mapping.remotePath).length);
  return { path: normalizePath(`${normalizePath(mapping.localPath)}/${rest}`), mapping };
}
