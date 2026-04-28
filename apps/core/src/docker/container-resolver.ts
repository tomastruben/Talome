import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { docker, listContainers } from "./client.js";

export type ContainerState = "running" | "stopped" | "missing";

export interface ResolvedContainer {
  /** ID that was stored in the DB. May be null if no IDs were tracked. */
  storedId: string | null;
  /** Currently-existing container ID, or null if no replacement could be found. */
  currentId: string | null;
  /** Container name (resolved from inspect, or candidate name when adopted). */
  name: string;
  state: ContainerState;
  /** True when the stored ID was missing and a replacement was located by name. */
  adopted: boolean;
}

interface InspectError {
  statusCode?: number;
}

// Containers Talome creates from compose templates use `container_name: <appId>`.
// When a stored ID is gone (e.g. `docker compose down` from a parallel stack
// destroyed it), we look for a container whose name matches the appId before
// declaring it missing.
function findCandidateByName(
  list: Awaited<ReturnType<typeof listContainers>>,
  appId: string,
): { id: string; name: string; status: string } | null {
  const exact = list.find((c) => c.name === appId);
  if (exact) return exact;
  const prefixed = list.find((c) => c.name.startsWith(`${appId}-`));
  return prefixed ?? null;
}

/**
 * Resolve the current Docker state for an installed app's tracked containers.
 *
 * For each stored container ID:
 *   1. Inspect it. If it exists, record its state.
 *   2. If Docker returns 404, look for a container whose name matches the
 *      app slug. If found, treat the app's container as adopted and rewrite
 *      `installed_apps.container_ids` to the new ID.
 *   3. If neither works, the state is `missing` — the container has been
 *      destroyed and no obvious replacement exists.
 *
 * This heals the common drift case where a parallel docker-compose stack
 * replaces a container with the same `container_name`, leaving Talome's DB
 * pointing at a destroyed ID.
 */
export async function resolveAppContainers(
  appId: string,
  storedIds: string[],
): Promise<ResolvedContainer[]> {
  if (storedIds.length === 0) return [];

  const results: ResolvedContainer[] = [];
  let listCache: Awaited<ReturnType<typeof listContainers>> | null = null;
  let nextIds: string[] | null = null;

  for (const id of storedIds) {
    try {
      const info = await docker.getContainer(id).inspect();
      const running = info.State?.Running === true;
      const name = (info.Name ?? "").replace(/^\//, "") || appId;
      results.push({ storedId: id, currentId: id, name, state: running ? "running" : "stopped", adopted: false });
      continue;
    } catch (err) {
      const statusCode = (err as InspectError).statusCode;
      if (statusCode !== 404) {
        // Daemon hiccup or unexpected error — preserve the stored ID and
        // surface as `stopped` rather than guessing `missing`.
        results.push({ storedId: id, currentId: id, name: appId, state: "stopped", adopted: false });
        continue;
      }
    }

    // 404 — try to adopt a same-named container.
    if (!listCache) {
      try {
        listCache = await listContainers();
      } catch {
        listCache = [];
      }
    }
    const candidate = findCandidateByName(listCache, appId);
    if (candidate) {
      if (!nextIds) nextIds = [...storedIds];
      const idx = nextIds.indexOf(id);
      if (idx !== -1) nextIds[idx] = candidate.id;
      results.push({
        storedId: id,
        currentId: candidate.id,
        name: candidate.name,
        state: candidate.status === "running" ? "running" : "stopped",
        adopted: true,
      });
    } else {
      results.push({ storedId: id, currentId: null, name: appId, state: "missing", adopted: false });
    }
  }

  if (nextIds) {
    try {
      db.update(schema.installedApps)
        .set({ containerIds: JSON.stringify(nextIds), updatedAt: new Date().toISOString() })
        .where(eq(schema.installedApps.appId, appId))
        .run();
    } catch {
      // Non-fatal: the diagnostic is still useful even if the rewrite failed.
    }
  }

  return results;
}
