/**
 * Container → host path mapping utilities.
 * Shared between media routes, optimization, and streaming.
 */

import { stat } from "node:fs/promises";
import { inspectContainer, listContainers } from "../docker/client.js";

export interface PathMount { source: string; destination: string }

let cachedMounts: PathMount[] | null = null;
let mountsCacheTime = 0;
const MOUNTS_TTL = 120_000; // 2 minutes

/** Get volume mounts for Sonarr/Radarr containers to map container paths → host paths. */
export async function getArrMounts(): Promise<PathMount[]> {
  const now = Date.now();
  if (cachedMounts && now - mountsCacheTime < MOUNTS_TTL) return cachedMounts;

  const mounts: PathMount[] = [];
  try {
    const containers = await listContainers();
    const arrNames = ["sonarr", "radarr"];
    const arrContainers = containers.filter((c) =>
      arrNames.some((name) => c.name.toLowerCase().includes(name))
    );

    for (const c of arrContainers) {
      try {
        const info = await inspectContainer(c.id);
        for (const m of info.mounts) {
          if (m.type === "bind" && m.source && m.destination) {
            mounts.push({ source: m.source, destination: m.destination });
          }
        }
      } catch { /* container inspect failed */ }
    }
  } catch { /* docker not available */ }

  cachedMounts = mounts;
  mountsCacheTime = now;
  return mounts;
}

/** Translate a container-internal path to a host path using Docker bind mounts. */
export function containerToHostPath(containerPath: string, mounts: PathMount[]): string | null {
  // Sort by destination length descending — longest prefix match first
  const sorted = [...mounts].sort((a, b) => b.destination.length - a.destination.length);
  for (const m of sorted) {
    const dest = m.destination.replace(/\/$/, "");
    if (containerPath === dest || containerPath.startsWith(dest + "/")) {
      return m.source + containerPath.slice(dest.length);
    }
  }
  return null;
}

/** Translate a host path back to a container-internal path using Docker bind mounts. */
export function hostToContainerPath(hostPath: string, mounts: PathMount[]): string | null {
  const sorted = [...mounts].sort((a, b) => b.source.length - a.source.length);
  for (const m of sorted) {
    const src = m.source.replace(/\/$/, "");
    if (hostPath === src || hostPath.startsWith(src + "/")) {
      return m.destination + hostPath.slice(src.length);
    }
  }
  return null;
}

export interface TaggedMediaPath {
  path: string;
  source: "movies" | "tv";
}

/** Get media root paths tagged with their source (movies from Radarr, TV from Sonarr). */
export async function getTaggedMediaRootPaths(): Promise<TaggedMediaPath[]> {
  const { db } = await import("../db/index.js");
  const { sql } = await import("drizzle-orm");
  const getSetting = (key: string): string | undefined => {
    const row = db.get(sql`SELECT value FROM settings WHERE key = ${key}`) as { value: string } | undefined;
    return row?.value;
  };

  const result: TaggedMediaPath[] = [];
  const seen = new Set<string>();
  const mounts = await getArrMounts();

  const services: Array<{ url: string | undefined; key: string | undefined; source: "movies" | "tv" }> = [
    { url: getSetting("radarr_url"), key: getSetting("radarr_api_key"), source: "movies" },
    { url: getSetting("sonarr_url"), key: getSetting("sonarr_api_key"), source: "tv" },
  ];

  for (const svc of services) {
    if (!svc.url || !svc.key) continue;
    try {
      const res = await fetch(`${svc.url}/api/v3/rootfolder`, {
        headers: { "X-Api-Key": svc.key },
      });
      if (!res.ok) continue;
      const folders = (await res.json()) as Array<{ path: string }>;
      for (const f of folders) {
        const mapped = containerToHostPath(f.path, mounts);
        const direct = f.path.replace(/\/$/, "");
        const resolved = mapped ? mapped.replace(/\/$/, "") : null;

        if (resolved && !seen.has(resolved)) {
          try { await stat(resolved); result.push({ path: resolved, source: svc.source }); seen.add(resolved); continue; } catch { /* mapped path not accessible */ }
        }
        if (!seen.has(direct)) {
          try { await stat(direct); result.push({ path: direct, source: svc.source }); seen.add(direct); } catch {
            console.warn(`[media-paths] ${svc.source} root folder ${f.path} not accessible (mapped: ${resolved ?? "none"}, direct: ${direct})`);
          }
        }
      }
    } catch { /* service not available */ }
  }

  return result;
}

/** Get all media root folder paths from Radarr and Sonarr, resolved to host paths. */
export async function getMediaRootPaths(): Promise<string[]> {
  const { db } = await import("../db/index.js");
  const { sql } = await import("drizzle-orm");
  const getSetting = (key: string): string | undefined => {
    const row = db.get(sql`SELECT value FROM settings WHERE key = ${key}`) as { value: string } | undefined;
    return row?.value;
  };

  const paths = new Set<string>();
  const mounts = await getArrMounts();

  const services = [
    { url: getSetting("radarr_url"), key: getSetting("radarr_api_key"), name: "radarr" },
    { url: getSetting("sonarr_url"), key: getSetting("sonarr_api_key"), name: "sonarr" },
  ];

  for (const svc of services) {
    if (!svc.url || !svc.key) continue;
    try {
      const res = await fetch(`${svc.url}/api/v3/rootfolder`, {
        headers: { "X-Api-Key": svc.key },
      });
      if (!res.ok) continue;
      const folders = (await res.json()) as Array<{ path: string }>;
      for (const f of folders) {
        // Try mapped path first, then direct path — validate each actually exists
        const mapped = containerToHostPath(f.path, mounts);
        const direct = f.path.replace(/\/$/, "");
        const resolved = mapped ? mapped.replace(/\/$/, "") : null;

        if (resolved) {
          try { await stat(resolved); paths.add(resolved); continue; } catch { /* mapped path not accessible */ }
        }
        // Fallback: try the container path directly (works in non-Docker setups)
        try { await stat(direct); paths.add(direct); } catch {
          // Neither path works — log for debugging
          console.warn(`[media-paths] ${svc.name} root folder ${f.path} not accessible (mapped: ${resolved ?? "none"}, direct: ${direct})`);
        }
      }
    } catch { /* service not available */ }
  }

  return [...paths];
}

/** Resolve a file path from arr APIs — try as-is first, then map from container paths. */
export async function resolveMediaFilePath(arrPath: string): Promise<string | null> {
  // First check if path exists directly on host (non-Docker or matching mount)
  try {
    await stat(arrPath);
    return arrPath;
  } catch { /* not found on host — need mapping */ }

  // Map container path → host path via Docker volume mounts
  const mounts = await getArrMounts();
  const hostPath = containerToHostPath(arrPath, mounts);
  if (hostPath) {
    try {
      await stat(hostPath);
      return hostPath;
    } catch { /* mapped path doesn't exist either */ }
  }

  return null;
}
