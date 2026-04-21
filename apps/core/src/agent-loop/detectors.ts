// ── Tier 0: Rule-Based Event Detectors (no AI, zero cost) ──────────────────

import { randomUUID } from "node:crypto";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { listContainers, getContainerLogs } from "../docker/client.js";
import { getSystemStats } from "../docker/client.js";
import { getSetting } from "../utils/settings.js";
import { APP_REGISTRY } from "../app-registry/index.js";
import { db, schema } from "../db/index.js";
import { eq, desc } from "drizzle-orm";
import type { SystemEvent, EventSeverity, AgentLoopConfig } from "./types.js";

const execAsync = promisify(execCb);

// ── State tracking ─────────────────────────────────────────────────────────

interface ContainerRestartRecord {
  timestamps: number[];
}

const restartHistory = new Map<string, ContainerRestartRecord>();
const previousStates = new Map<string, string>();
const lastEventKeys = new Map<string, number>();

// Default 4 hours — overridden by config.eventCooldownMinutes at runtime
let eventCooldownMs = 4 * 60 * 60 * 1000;

/** Update the cooldown duration from config (called each detector cycle). */
export function setEventCooldownMs(ms: number): void {
  eventCooldownMs = ms;
}

function shouldEmit(key: string): boolean {
  const last = lastEventKeys.get(key) ?? 0;
  if (Date.now() - last < eventCooldownMs) return false;
  lastEventKeys.set(key, Date.now());
  return true;
}

function makeEvent(
  type: SystemEvent["type"],
  severity: EventSeverity,
  source: string,
  message: string,
  data: Record<string, unknown> = {},
): SystemEvent {
  return {
    id: randomUUID(),
    type,
    severity,
    source,
    message,
    data,
    detectedAt: new Date().toISOString(),
  };
}

// ── Container health detectors ─────────────────────────────────────────────

async function detectContainerIssues(config: AgentLoopConfig): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  try {
    const containers = await listContainers();
    const currentStates = new Map<string, string>();

    for (const c of containers) {
      currentStates.set(c.name, c.status);
      const prev = previousStates.get(c.name);

      // Container went down
      if (prev && prev === "running" && c.status !== "running") {
        if (shouldEmit(`container_down:${c.name}`)) {
          events.push(
            makeEvent("container_down", "warning", c.name, `Container ${c.name} stopped (was running)`, {
              containerId: c.id,
              containerName: c.name,
              previousState: prev,
              currentState: c.status,
              image: c.image,
            }),
          );
        }

        // Track restart for loop detection
        const record = restartHistory.get(c.name) ?? { timestamps: [] };
        record.timestamps.push(Date.now());
        // Prune old entries outside the window
        record.timestamps = record.timestamps.filter(
          (t) => Date.now() - t < config.restartLoopWindowMs,
        );
        restartHistory.set(c.name, record);

        if (record.timestamps.length >= config.restartLoopThreshold) {
          if (shouldEmit(`restart_loop:${c.name}`)) {
            events.push(
              makeEvent("restart_loop", "critical", c.name,
                `Container ${c.name} restarted ${record.timestamps.length} times in the last hour`, {
                  containerId: c.id,
                  containerName: c.name,
                  restartCount: record.timestamps.length,
                  windowMs: config.restartLoopWindowMs,
                  image: c.image,
                }),
            );

            // Check if this crash-loop happened shortly after an update → suggest rollback
            try {
              const snapshot = db
                .select()
                .from(schema.updateSnapshots)
                .where(eq(schema.updateSnapshots.appId, c.name))
                .orderBy(desc(schema.updateSnapshots.id))
                .limit(1)
                .get();

              if (snapshot && !snapshot.rolledBack) {
                const updateAge = Date.now() - new Date(snapshot.createdAt).getTime();
                const POST_UPDATE_WINDOW = 5 * 60 * 1000; // 5 minutes
                if (updateAge < POST_UPDATE_WINDOW) {
                  events.push(
                    makeEvent("post_update_crash_loop", "critical", c.name,
                      `${c.name} is crash-looping after a recent update (${Math.round(updateAge / 1000)}s ago). ` +
                      `Previous version: ${snapshot.previousVersion}. Consider rolling back.`, {
                        containerId: c.id,
                        containerName: c.name,
                        appId: c.name,
                        previousVersion: snapshot.previousVersion,
                        newVersion: snapshot.newVersion,
                        updateAgeMs: updateAge,
                        snapshotId: snapshot.id,
                      }),
                  );
                }
              }
            } catch {
              // Best-effort — don't block the main detector
            }
          }
        }
      }
    }

    // Update state map
    for (const [name, status] of currentStates) {
      previousStates.set(name, status);
    }
    // Clean up containers that no longer exist
    for (const name of previousStates.keys()) {
      if (!currentStates.has(name)) previousStates.delete(name);
    }
  } catch (err) {
    console.error("[agent-loop] detectContainerIssues error:", err);
  }

  return events;
}

// ── System resource detectors ──────────────────────────────────────────────
// Resource events (high_cpu, high_memory, disk_trend) emit every cycle when
// above threshold — NO cooldown gating. The event-dedup layer in index.ts
// aggregates repeated occurrences within a 5-min sliding window (±2% value
// tolerance) so the user sees "Memory at 99% (15 occurrences in 5 min)"
// instead of 15 separate alerts.

async function detectResourceIssues(config: AgentLoopConfig): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  try {
    const stats = await getSystemStats();

    // High CPU
    const cpuPercent = stats.cpu.usage;
    if (cpuPercent > config.highCpuThreshold) {
      events.push(
        makeEvent("high_cpu", cpuPercent > 95 ? "critical" : "warning", "system",
          `CPU usage at ${cpuPercent.toFixed(1)}%`, {
            cpuPercent,
            threshold: config.highCpuThreshold,
          }),
      );
    }

    // High memory
    const memPercent = stats.memory.percent;
    if (memPercent > config.highMemoryThreshold) {
      events.push(
        makeEvent("high_memory", memPercent > 95 ? "critical" : "warning", "system",
          `Memory usage at ${memPercent.toFixed(1)}%`, {
            memoryPercent: memPercent,
            memoryUsedBytes: stats.memory.usedBytes,
            memoryTotalBytes: stats.memory.totalBytes,
            threshold: config.highMemoryThreshold,
          }),
      );
    }

    // Disk trend — already handled by monitor.ts, but we add a "trend" event
    // at 75% as an early warning (monitor only fires at 80%+)
    if (stats.disk.percent > 75 && stats.disk.percent <= 80) {
      events.push(
        makeEvent("disk_trend", "info", "system",
          `Disk usage at ${stats.disk.percent}% — approaching warning threshold`, {
            diskPercent: stats.disk.percent,
            diskUsedBytes: stats.disk.usedBytes,
            diskTotalBytes: stats.disk.totalBytes,
          }),
      );
    }
  } catch (err) {
    console.error("[agent-loop] detectResourceIssues error:", err);
  }

  return events;
}

// ── Image staleness detector ───────────────────────────────────────────────

async function detectStaleImages(config: AgentLoopConfig): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  try {
    const containers = await listContainers();
    const now = Date.now();
    const staleThresholdMs = config.imageStalenessDays * 24 * 60 * 60 * 1000;

    for (const c of containers) {
      if (c.status !== "running") continue;
      const created = new Date(c.created).getTime();
      if (now - created > staleThresholdMs) {
        if (shouldEmit(`image_stale:${c.name}`)) {
          const daysOld = Math.floor((now - created) / (24 * 60 * 60 * 1000));
          events.push(
            makeEvent("image_stale", "info", c.name,
              `Container ${c.name} image is ${daysOld} days old`, {
                containerId: c.id,
                containerName: c.name,
                image: c.image,
                daysOld,
                createdAt: c.created,
              }),
          );
        }
      }
    }
  } catch (err) {
    console.error("[agent-loop] detectStaleImages error:", err);
  }

  return events;
}

// ── App-level health detectors (Sonarr, Radarr, qBittorrent, Jellyfin) ────
// These hit external APIs so they run less frequently (every 5th cycle = ~5 min).

let appHealthCycleCount = 0;
const APP_HEALTH_EVERY_N_CYCLES = 5;

interface ArrHealthIssue {
  type: string;
  message: string;
  wikiUrl?: string;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function detectAppHealthIssues(): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  // Sonarr / Radarr health endpoints
  for (const app of ["sonarr", "radarr"] as const) {
    const baseUrl = getSetting(`${app}_url`);
    const apiKey = getSetting(`${app}_api_key`);
    if (!baseUrl || !apiKey) continue;

    const url = `${baseUrl.replace(/\/$/, "")}/api/v3/health`;
    const data = await fetchJson(url, { "X-Api-Key": apiKey });
    if (!Array.isArray(data)) continue;

    for (const issue of data as ArrHealthIssue[]) {
      const key = `arr_health:${app}:${issue.type}`;
      if (!shouldEmit(key)) continue;
      events.push(
        makeEvent(
          "service_degraded",
          issue.type.toLowerCase().includes("error") ? "critical" : "warning",
          app,
          `${app.charAt(0).toUpperCase() + app.slice(1)} health: ${issue.message}`,
          { app, issueType: issue.type, wikiUrl: issue.wikiUrl },
        ),
      );
    }
  }

  // qBittorrent — stalled downloads
  const qbtUrl = getSetting("qbittorrent_url");
  if (qbtUrl) {
    const url = `${qbtUrl.replace(/\/$/, "")}/api/v2/torrents/info?filter=stalled`;
    const data = await fetchJson(url);
    if (Array.isArray(data)) {
      const now = Date.now() / 1000;
      const stuck = (data as Array<{ name: string; added_on: number }>).filter(
        (t) => now - t.added_on > 7200, // stalled > 2 hours
      );
      if (stuck.length > 0 && shouldEmit("download_stuck:qbittorrent")) {
        events.push(
          makeEvent("download_stuck", "warning", "qbittorrent",
            `${stuck.length} download${stuck.length > 1 ? "s" : ""} stalled for >2 hours`,
            { count: stuck.length, names: stuck.map((t) => t.name).slice(0, 5) },
          ),
        );
      }
    }
  }

  // Jellyfin — API reachability
  const jellyfinUrl = getSetting("jellyfin_url");
  const jellyfinKey = getSetting("jellyfin_api_key");
  if (jellyfinUrl && jellyfinKey) {
    const url = `${jellyfinUrl.replace(/\/$/, "")}/System/Info`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `MediaBrowser Token="${jellyfinKey}"` },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok && shouldEmit("service_degraded:jellyfin")) {
        events.push(
          makeEvent("service_degraded", "warning", "jellyfin",
            `Jellyfin API returned ${res.status}`,
            { statusCode: res.status },
          ),
        );
      }
    } catch {
      // Container unreachable — container_down detector will catch it
    }
  }

  return events;
}

// ── Log error spike detector ─────────────────────────────────────────────

const ERROR_PATTERN = /\b(error|exception|fatal|panic|critical|crash|segfault|oom|killed)\b/i;
const FALSE_POSITIVE_PREFIX = /^\s*\[?\s*(info|debug|trace|warn(ing)?)\b/i;

async function detectErrorSpikes(): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  try {
    const containers = await listContainers();

    for (const c of containers) {
      if (c.status !== "running") continue;

      try {
        const logText = await getContainerLogs(c.id, 100);
        const lines = logText.split("\n").filter((l) => l.trim().length > 0);
        if (lines.length < 10) continue; // too few lines to judge

        const errorLines = lines.filter(
          (l) => ERROR_PATTERN.test(l) && !FALSE_POSITIVE_PREFIX.test(l),
        );
        const errorRate = errorLines.length / lines.length;

        if (errorRate > 0.3 && shouldEmit(`error_spike:${c.name}`)) {
          events.push(
            makeEvent("error_spike", "warning", c.name,
              `${c.name} has ${Math.round(errorRate * 100)}% error rate in recent logs`,
              {
                errorRate: Math.round(errorRate * 100),
                sampleSize: lines.length,
                sampleErrors: errorLines.slice(0, 3).map((l) => l.slice(0, 200)),
                containerName: c.name,
              },
            ),
          );
        }
      } catch {
        // Skip containers whose logs we can't read
      }
    }
  } catch (err) {
    console.error("[agent-loop] detectErrorSpikes error:", err);
  }

  return events;
}

// ── Inter-app connectivity detector ──────────────────────────────────────
// Checks if Sonarr/Radarr can reach their configured download clients.

let connectivityCycleCount = 0;
const CONNECTIVITY_EVERY_N_CYCLES = 30; // ~30 min at 60s interval

async function detectConnectivityIssues(): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  for (const app of ["sonarr", "radarr"] as const) {
    const baseUrl = getSetting(`${app}_url`);
    const apiKey = getSetting(`${app}_api_key`);
    if (!baseUrl || !apiKey) continue;

    const cleanUrl = baseUrl.replace(/\/$/, "");
    const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

    // Get download clients
    const clients = await fetchJson(`${cleanUrl}/api/v3/downloadclient`, { "X-Api-Key": apiKey });
    if (!Array.isArray(clients)) continue;

    for (const client of clients as Array<{ id: number; name: string; implementation: string }>) {
      try {
        const testRes = await fetch(`${cleanUrl}/api/v3/downloadclient/test`, {
          method: "POST",
          headers,
          body: JSON.stringify(client),
          signal: AbortSignal.timeout(8000),
        });

        if (!testRes.ok && shouldEmit(`connectivity:${app}:${client.name}`)) {
          events.push(
            makeEvent("service_degraded", "critical", app,
              `${app.charAt(0).toUpperCase() + app.slice(1)} cannot reach download client "${client.name}"`,
              {
                app,
                clientName: client.name,
                implementation: client.implementation,
              },
            ),
          );
        }
      } catch {
        // Test endpoint unreachable — app health detector will catch it
      }
    }
  }

  return events;
}

// ── Docker reclaimable space detector ─────────────────────────────────────
// Runs infrequently (~1h). Checks how much Docker space can be reclaimed.

let reclaimCycleCount = 0;
const RECLAIM_EVERY_N_CYCLES = 60; // ~60 min at 60s interval

function parseReclaimableBytes(str: string | undefined): number {
  if (!str) return 0;
  const match = str.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(value * (multipliers[unit] ?? 1));
}

async function detectReclaimableSpace(): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  try {
    const { stdout } = await execAsync("docker system df --format json", { timeout: 15000 });
    const lines = stdout.trim().split("\n").filter(Boolean);

    let totalReclaimable = 0;
    const categories: Record<string, number> = {};

    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        const bytes = parseReclaimableBytes(row.Reclaimable);
        totalReclaimable += bytes;
        if (bytes > 0) categories[row.Type] = bytes;
      } catch { /* skip */ }
    }

    const reclaimableGB = totalReclaimable / (1024 ** 3);

    // Only emit if > 5GB reclaimable
    if (reclaimableGB > 5 && shouldEmit("disk_reclaimable:docker")) {
      const categoryStr = Object.entries(categories)
        .map(([type, bytes]) => `${type}: ${(bytes / (1024 ** 3)).toFixed(1)}GB`)
        .join(", ");

      events.push(
        makeEvent("disk_reclaimable", reclaimableGB > 20 ? "warning" : "info", "docker",
          `${reclaimableGB.toFixed(1)}GB of Docker resources can be reclaimed (${categoryStr})`, {
            totalReclaimableBytes: totalReclaimable,
            totalReclaimableGB: reclaimableGB,
            categories,
          }),
      );
    }
  } catch (err) {
    console.error("[agent-loop] detectReclaimableSpace error:", err);
  }

  return events;
}

// ── Generalized inter-app connectivity detector ──────────────────────────
// Uses the app-registry relatesTo graph to check all configured app pairs.

async function detectGeneralizedConnectivity(): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  for (const [appId, capabilities] of Object.entries(APP_REGISTRY)) {
    const baseUrl = getSetting(capabilities.apiBaseSettingKey);
    if (!baseUrl) continue; // App not configured

    const relatesTo = capabilities.relatesTo ?? [];
    for (const relatedId of relatesTo) {
      const related = APP_REGISTRY[relatedId];
      if (!related) continue;

      const relatedUrl = getSetting(related.apiBaseSettingKey);
      if (!relatedUrl) continue; // Related app not configured

      // Probe the related app's health endpoint
      const cleanUrl = relatedUrl.replace(/\/$/, "");
      const healthUrl = `${cleanUrl}${related.healthEndpoint}`;

      // Get API key if available
      const apiKey = getSetting(related.apiKeySettingKey);
      const headers: Record<string, string> = {};
      if (apiKey) {
        if (related.healthEndpoint.includes("/api/v3")) {
          headers["X-Api-Key"] = apiKey;
        } else if (relatedId === "jellyfin") {
          headers["Authorization"] = `MediaBrowser Token="${apiKey}"`;
        }
      }

      try {
        const res = await fetch(healthUrl, {
          headers,
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
          const key = `connectivity:${appId}:${relatedId}`;
          if (shouldEmit(key)) {
            events.push(
              makeEvent("connectivity_broken", "warning", appId,
                `${capabilities.name} may not be able to reach ${related.name} (health check returned ${res.status})`, {
                  sourceApp: appId,
                  targetApp: relatedId,
                  targetUrl: cleanUrl,
                  httpStatus: res.status,
                }),
            );
          }
        }
      } catch {
        const key = `connectivity:${appId}:${relatedId}`;
        if (shouldEmit(key)) {
          events.push(
            makeEvent("connectivity_broken", "critical", appId,
              `${capabilities.name} cannot reach ${related.name} (connection refused or timeout)`, {
                sourceApp: appId,
                targetApp: relatedId,
                targetUrl: cleanUrl,
              }),
          );
        }
      }
    }
  }

  return events;
}

// ── Connectivity consolidation ──────────────────────────────────────────────
// When multiple apps can't reach the same target, emit a single consolidated
// event instead of one per source→target pair.

function consolidateConnectivityEvents(events: SystemEvent[]): SystemEvent[] {
  const connectivityEvents = events.filter((e) => e.type === "connectivity_broken" || (e.type === "service_degraded" && e.data.clientName));
  const otherEvents = events.filter((e) => !connectivityEvents.includes(e));

  if (connectivityEvents.length <= 1) return events;

  // Group by target app/service
  const byTarget = new Map<string, SystemEvent[]>();
  for (const ev of connectivityEvents) {
    const target = String(ev.data.targetApp || ev.data.clientName || "unknown");
    const group = byTarget.get(target) ?? [];
    group.push(ev);
    byTarget.set(target, group);
  }

  const consolidated: SystemEvent[] = [];
  for (const [target, group] of byTarget) {
    if (group.length === 1) {
      consolidated.push(group[0]);
      continue;
    }

    // Merge into single event
    const sources = group.map((e) => e.source);
    const highestSeverity = group.some((e) => e.severity === "critical") ? "critical" as const : "warning" as const;
    const targetName = String(group[0].data.targetApp || group[0].data.clientName || target);

    consolidated.push(makeEvent(
      group[0].type as SystemEvent["type"],
      highestSeverity,
      `multi:${target}`,
      `${sources.length} apps cannot reach ${targetName} (${sources.join(", ")})`,
      {
        targetApp: targetName,
        sourceApps: sources,
        consolidatedCount: sources.length,
        details: group.map((e) => ({ source: e.source, message: e.message })),
      },
    ));
  }

  return [...otherEvents, ...consolidated];
}

// ── Process health detector (supervisor events) ──────────────────────────

let processHealthCycleCount = 0;
const PROCESS_HEALTH_EVERY_N_CYCLES = 5;

async function detectProcessCrashes(): Promise<SystemEvent[]> {
  const events: SystemEvent[] = [];

  try {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const crashes = db
      .select()
      .from(schema.supervisorEvents)
      .orderBy(desc(schema.supervisorEvents.createdAt))
      .limit(20)
      .all()
      .filter((e) => e.eventType === "crash" && e.createdAt > thirtyMinAgo);

    // Group by process
    const byProcess = new Map<string, typeof crashes>();
    for (const crash of crashes) {
      const group = byProcess.get(crash.process) ?? [];
      group.push(crash);
      byProcess.set(crash.process, group);
    }

    for (const [processName, processCrashes] of byProcess) {
      const key = `process_crash:${processName}`;
      if (!shouldEmit(key)) continue;

      const severity = processCrashes.length >= 3 ? "critical" as const : "warning" as const;
      events.push(
        makeEvent("process_crash", severity, processName,
          `Talome ${processName} crashed ${processCrashes.length} time(s) in the last 30 minutes`, {
            processName,
            crashCount: processCrashes.length,
            latestExitCode: processCrashes[0]?.exitCode,
            latestDiagnosis: processCrashes[0]?.diagnosis,
          }),
      );
    }
  } catch {
    // supervisor_events table may not exist yet — non-fatal
  }

  return events;
}

// ── Main detector runner ───────────────────────────────────────────────────

export async function runDetectors(config: AgentLoopConfig): Promise<SystemEvent[]> {
  // Apply configurable cooldown
  setEventCooldownMs((config.eventCooldownMinutes ?? 240) * 60 * 1000);

  appHealthCycleCount++;
  connectivityCycleCount++;
  reclaimCycleCount++;
  processHealthCycleCount++;

  const detectors: Promise<SystemEvent[]>[] = [
    detectContainerIssues(config),
    detectResourceIssues(config),
    detectStaleImages(config),
  ];

  // App-level checks run every 5th cycle (~5 min)
  if (appHealthCycleCount >= APP_HEALTH_EVERY_N_CYCLES) {
    appHealthCycleCount = 0;
    detectors.push(detectAppHealthIssues());
    detectors.push(detectErrorSpikes());
  }

  // Connectivity checks run every 30th cycle (~30 min)
  // Uses both the original arr-specific checks and the generalized registry-based checks
  if (connectivityCycleCount >= CONNECTIVITY_EVERY_N_CYCLES) {
    connectivityCycleCount = 0;
    detectors.push(detectConnectivityIssues());
    detectors.push(detectGeneralizedConnectivity());
  }

  // Reclaimable space checks run every 60th cycle (~1 hour)
  if (reclaimCycleCount >= RECLAIM_EVERY_N_CYCLES) {
    reclaimCycleCount = 0;
    detectors.push(detectReclaimableSpace());
  }

  // Process health checks run every 5th cycle (~5 min)
  if (processHealthCycleCount >= PROCESS_HEALTH_EVERY_N_CYCLES) {
    processHealthCycleCount = 0;
    detectors.push(detectProcessCrashes());
  }

  const results = await Promise.allSettled(detectors);

  const events: SystemEvent[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      events.push(...result.value);
    }
  }

  // Consolidate connectivity events targeting the same service
  return consolidateConnectivityEvents(events);
}

/** Reset all detector state — useful for testing */
export function resetDetectorState(): void {
  restartHistory.clear();
  previousStates.clear();
  lastEventKeys.clear();
  appHealthCycleCount = 0;
  connectivityCycleCount = 0;
  reclaimCycleCount = 0;
}
