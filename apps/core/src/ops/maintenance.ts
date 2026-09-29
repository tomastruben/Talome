// ── Containers under an operation (any process) ──────────────────────────────
//
// backup/state.ts maintenance windows are in-process: an update, rollback or
// restore run from the MCP stdio server (a separate process) holds its window
// there, not here. The operations journal is shared, so monitors and detectors
// also treat a container as "changing on purpose" while its app has a live
// container-changing operation in the journal (fresh heartbeat), and for a
// short settling grace after it finished.
//
// Callers that track state transitions must not advance their "previous state"
// for containers skipped here: a container still down once the operation is
// over is then reported as down.

import { and, gt, inArray, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { ACTIVE_OPERATION_STATUSES, isForeignOwnerLive, listActiveOperationsInProcess, type OperationKind } from "./operations.js";
import { HOLD_GRACE_MS, installedAppIdsCached, isContainerInMaintenanceWindow, owningAppId } from "../backup/state.js";

/** Operations that stop, recreate or replace an app's containers on purpose. */
const CONTAINER_CHANGING_KINDS: OperationKind[] = ["install", "update", "rollback", "backup", "restore"];
const CACHE_TTL_MS = 5_000;

let cache: { at: number; apps: Set<string> } | null = null;

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Apps with a container-changing operation running in this or another live
 * process, or one that finished within the settling grace. Cached briefly:
 * monitors ask once per container per tick.
 */
export function appsUnderOperation(now: number = Date.now()): Set<string> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.apps;
  const apps = new Set<string>();
  for (const op of listActiveOperationsInProcess()) {
    if (CONTAINER_CHANGING_KINDS.includes(op.kind)) apps.add(op.appId);
  }
  try {
    const graceSince = new Date(now - HOLD_GRACE_MS).toISOString();
    const rows = db
      .select()
      .from(schema.appOperations)
      .where(and(
        inArray(schema.appOperations.kind, CONTAINER_CHANGING_KINDS),
        or(
          inArray(schema.appOperations.status, ACTIVE_OPERATION_STATUSES),
          gt(schema.appOperations.finishedAt, graceSince),
        ),
      ))
      .all();
    for (const row of rows) {
      const active = ACTIVE_OPERATION_STATUSES.includes(row.status as (typeof ACTIVE_OPERATION_STATUSES)[number]);
      if (!active || isForeignOwnerLive(row, now)) apps.add(row.appId);
    }
  } catch {
    // Journal unavailable — the in-process windows still apply
  }
  cache = { at: now, apps };
  return apps;
}

/** The installed app a container belongs to (recorded container id, else app naming). */
function containerAppId(name: string | null | undefined, id: string | null | undefined, candidates: Set<string>): string | null {
  if (id) {
    try {
      const rows = db
        .select({ appId: schema.installedApps.appId, containerIds: schema.installedApps.containerIds })
        .from(schema.installedApps)
        .all();
      const byId = rows.find((r) => parseIds(r.containerIds).some((c) => c.startsWith(id) || id.startsWith(c)));
      if (byId) return byId.appId;
    } catch {
      // Fall back to naming
    }
  }
  if (!name) return null;
  return owningAppId(name, [...installedAppIdsCached(), ...candidates]);
}

/**
 * True when a container is stopped or recreated on purpose: inside an
 * in-process maintenance window, or its app has a container-changing operation
 * live in the journal (any process) or just finished.
 */
export function isContainerUnderOperation(name?: string | null, id?: string | null): boolean {
  if (isContainerInMaintenanceWindow(name, id)) return true;
  const apps = appsUnderOperation();
  if (apps.size === 0) return false;
  const appId = containerAppId(name?.replace(/^\//, "") ?? null, id ?? null, apps);
  return appId !== null && apps.has(appId);
}

/** Test-only: drop the cached journal read. */
export function __resetOperationWindowCacheForTests(): void {
  cache = null;
}
