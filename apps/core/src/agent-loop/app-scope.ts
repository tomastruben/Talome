// ── Agent loop ↔ app operations ──────────────────────────────────────────────
//
// Maps system events to the installed app they concern, and decides whether
// the agent loop must keep its hands off: an app with a live operation
// (install, update, rollback, backup, restore, …) or inside a maintenance
// window is being changed on purpose — remediating it (restarting containers,
// rolling back) would fight the operation.

import { db, schema } from "../db/index.js";
import { hasLiveOperation, getActiveOperation } from "../ops/operations.js";
import { getAppMaintenanceReasons, isAppInMaintenance, isContainerInMaintenanceWindow } from "../backup/state.js";

export interface EventLike {
  source: string;
  data: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function belongsTo(name: string, appId: string): boolean {
  const n = name.toLowerCase().replace(/^\//, "");
  const a = appId.toLowerCase();
  return n === a || n.startsWith(`${a}-`) || n.startsWith(`${a}_`);
}

/**
 * The installed app an event concerns, or null. Uses the event's explicit
 * appId/sourceApp when present, otherwise the container id (recorded on the
 * installed app) or the container name (compose/app naming).
 */
export function resolveEventAppId(event: EventLike): string | null {
  let installed: Array<{ appId: string; containerIds: string }>;
  try {
    installed = db.select({ appId: schema.installedApps.appId, containerIds: schema.installedApps.containerIds }).from(schema.installedApps).all();
  } catch {
    installed = [];
  }
  const ids = new Set(installed.map((a) => a.appId));

  for (const key of ["appId", "sourceApp"]) {
    const explicit = str(event.data[key]);
    if (explicit && (ids.has(explicit) || installed.length === 0)) return explicit;
  }

  const containerId = str(event.data.containerId);
  if (containerId) {
    const byId = installed.find((a) =>
      parseIds(a.containerIds).some((id) => id.startsWith(containerId) || containerId.startsWith(id)),
    );
    if (byId) return byId.appId;
  }

  const name = str(event.data.containerName) ?? str(event.source);
  if (!name) return null;
  if (ids.has(name)) return name;
  // Longest matching app id wins ("sonarr-anime" over "sonarr").
  const matches = [...ids].filter((id) => belongsTo(name, id)).sort((x, y) => y.length - x.length);
  return matches[0] ?? null;
}

export interface RemediationGuard {
  blocked: boolean;
  appId: string | null;
  reason?: string;
}

/**
 * Must the agent loop leave this event alone for now? True while the app has
 * a live operation (in this or another process) or is in a maintenance window,
 * and for containers stopped on purpose by a backup/restore/update.
 */
export function checkRemediationGuard(event: EventLike): RemediationGuard {
  const containerName = str(event.data.containerName) ?? str(event.source);
  const containerId = str(event.data.containerId);
  const appId = resolveEventAppId(event);

  if (appId) {
    const running = getActiveOperation(appId);
    if (running) {
      return { blocked: true, appId, reason: `${/^[aeiou]/.test(running.kind) ? "an" : "a"} ${running.kind} operation is running on ${appId}` };
    }
    if (hasLiveOperation(appId)) {
      return { blocked: true, appId, reason: `an operation is running on ${appId} in another Talome process` };
    }
    if (isAppInMaintenance(appId)) {
      const reasons = getAppMaintenanceReasons(appId);
      return { blocked: true, appId, reason: `${appId} is in a maintenance window${reasons.length > 0 ? ` (${reasons.join(", ")})` : ""}` };
    }
  }
  if (isContainerInMaintenanceWindow(containerName, containerId)) {
    return { blocked: true, appId, reason: `${containerName ?? containerId} is stopped on purpose (maintenance window)` };
  }
  return { blocked: false, appId };
}
