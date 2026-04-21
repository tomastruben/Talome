// ── Agent Loop: The Background Intelligence Engine ─────────────────────────
//
// Three-tier architecture:
//   Tier 0 — Rule-based detectors (free, every 60s)
//   Tier 1 — Haiku triage (cheap, only when events detected)
//   Tier 2 — Sonnet remediation (expensive, only when triage says "act")
//
// Cost target: <$1/month for typical usage

import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { runDetectors } from "./detectors.js";
import { triageEvents } from "./triage.js";
import { remediateEvent } from "./remediation.js";
import { verifyPendingRemediations } from "./outcome-tracker.js";
import { isInStartupGrace, getBudgetZone, getEffectiveRate } from "./budget.js";
import { deduplicate, formatOccurrenceLabel } from "./event-dedup.js";
import { writeNotification } from "../db/notifications.js";
import { subscribeDockerEvents, connectContainerToNetwork, type DockerEvent } from "../docker/client.js";
import { ensureTalomeNetwork } from "../docker/talome-network.js";
import type { AgentLoopConfig, SystemEvent } from "./types.js";
import { DEFAULT_AGENT_LOOP_CONFIG } from "./types.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-loop");

let loopTimer: ReturnType<typeof setInterval> | null = null;
let verifyTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let eventStreamCleanup: (() => void) | null = null;
let running = false;

// ── Crash isolation state ────────────────────────────────────────────────────
let consecutiveFailures = 0;
let lastCycleAt = 0;
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_BASE_MS = 5_000; // 5s → 10s → 20s → 40s → 80s

function getConfig(): AgentLoopConfig {
  try {
    const raw = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "agent_loop_config"))
      .get();
    if (raw?.value) {
      return { ...DEFAULT_AGENT_LOOP_CONFIG, ...JSON.parse(raw.value) };
    }
  } catch {
    // Use defaults
  }
  return { ...DEFAULT_AGENT_LOOP_CONFIG };
}

/** Isolated cycle wrapper — catches crashes, tracks failures, backs off */
async function runCycleGuarded(): Promise<void> {
  if (running) return;

  // Backoff if too many consecutive failures
  if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    const backoff = BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - MAX_CONSECUTIVE_FAILURES);
    const cap = 5 * 60 * 1000; // 5-minute max backoff
    const delay = Math.min(backoff, cap);
    if (Date.now() - lastCycleAt < delay) return;
    log.warn(`Retrying after ${consecutiveFailures} consecutive failures (backoff ${Math.round(delay / 1000)}s)`);
  }

  lastCycleAt = Date.now();

  try {
    await runCycle();
    consecutiveFailures = 0; // Reset on success
  } catch (err) {
    consecutiveFailures++;
    log.error(`Cycle crash #${consecutiveFailures}`, err);
    if (consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
      writeNotification(
        "warning",
        "Agent loop degraded",
        `Background agent has crashed ${MAX_CONSECUTIVE_FAILURES} times in a row — entering backoff mode. Check server logs.`,
        "agent-loop",
      );
    }
  }
}

async function runCycle(): Promise<void> {
  if (running) return; // Prevent overlapping cycles
  running = true;

  try {
    const config = getConfig();
    if (!config.enabled) return;
    if (isInStartupGrace()) return; // Skip AI calls during startup grace period

    // ── Tier 0: Detect events (no AI, no cost) ────────────────────────
    const events = await runDetectors(config);

    if (events.length === 0) return;

    log.info(`Tier 0 detected ${events.length} event(s)`);

    // Persist events — deduplicate similar alerts within a 5-min window
    const newEvents: SystemEvent[] = [];

    for (const event of events) {
      const result = deduplicate(event.id, event.type, event.source, event.data);

      if (result.isDuplicate) {
        // Merge into existing event: bump count + lastSeen + latest data
        // Store raw message — displayMessage is computed at read time by the API
        try {
          db.update(schema.systemEvents)
            .set({
              occurrenceCount: result.count,
              lastSeen: event.detectedAt,
              message: event.message,
              data: JSON.stringify(event.data),
            })
            .where(eq(schema.systemEvents.id, result.canonicalEventId))
            .run();
        } catch {
          // Non-fatal
        }

        // Emit consolidated notification at threshold crossings (5, 15, 30, 60)
        if (result.shouldNotify && event.severity !== "info") {
          writeNotification(
            event.severity === "critical" ? "critical" : "warning",
            `Agent: ${formatOccurrenceLabel(event.message, result.count)}`,
            `Repeated ${event.type} alert — ongoing issue`,
            "agent-loop",
          );
        }

        log.debug(
          `Deduplicated ${event.type}:${event.source} (${result.count} occurrences)`,
        );
      } else {
        // New event — insert
        try {
          db.insert(schema.systemEvents)
            .values({
              id: event.id,
              type: event.type,
              severity: event.severity,
              source: event.source,
              message: event.message,
              data: JSON.stringify(event.data),
              occurrenceCount: 1,
              lastSeen: event.detectedAt,
              createdAt: event.detectedAt,
            })
            .run();
          newEvents.push(event);
        } catch {
          // Non-fatal — duplicate or schema issue
        }
      }
    }

    // ── Tier 1: Triage with Haiku (cheap) ─────────────────────────────
    // Only triage new warning+ events — info events and deduped events skip triage
    const triageWorthy = newEvents.filter((e) => e.severity !== "info");

    if (triageWorthy.length === 0) return;

    // Zone-aware filtering: in red zone, only triage critical events
    const zone = getBudgetZone();
    let eventsToTriage = triageWorthy;
    if (zone === "red") {
      eventsToTriage = triageWorthy.filter((e) => e.severity === "critical");
      if (eventsToTriage.length < triageWorthy.length) {
        log.info(`Red zone: filtered ${triageWorthy.length - eventsToTriage.length} non-critical events from triage`);
      }
    }

    if (eventsToTriage.length === 0) return;

    const effectiveTriageRate = getEffectiveRate(config.maxTriagePerHour, "triage");
    const triageResults = await triageEvents(eventsToTriage, effectiveTriageRate);

    // Update events with triage verdicts
    for (const result of triageResults) {
      try {
        db.update(schema.systemEvents)
          .set({ triageVerdict: result.verdict })
          .where(eq(schema.systemEvents.id, result.eventId))
          .run();
      } catch {
        // Non-fatal
      }
    }

    // Handle notifications for "notify" verdicts
    const notifyResults = triageResults.filter((r) => r.verdict === "notify");
    for (const result of notifyResults) {
      const event = newEvents.find((e) => e.id === result.eventId);
      if (event) {
        writeNotification(
          event.severity === "critical" ? "critical" : "warning",
          `Agent: ${event.message}`,
          result.reason,
          "agent-loop",
        );
      }
    }

    // ── Tier 2: Remediate "act" verdicts with Sonnet ──────────────────
    const actResults = triageResults.filter((r) => r.verdict === "act");

    if (actResults.length === 0) return;

    log.info(`Tier 1 flagged ${actResults.length} event(s) for remediation`);

    for (const result of actResults) {
      const event = newEvents.find((e) => e.id === result.eventId);
      if (!event) continue;

      // Update event with remediation link
      try {
        const remResult = await remediateEvent(
          event,
          result,
          config.maxRemediationPerHour,
          config.autoRemediate,
        );

        db.update(schema.systemEvents)
          .set({ remediationId: remResult.eventId })
          .where(eq(schema.systemEvents.id, event.id))
          .run();
      } catch (err) {
        log.error(`Remediation for ${event.id} failed`, err);
      }
    }
  } catch (err) {
    log.error("Cycle error", err);
  } finally {
    running = false;
  }
}

// ── Reactive Network Repair ────────────────────────────────────────────────
// When a container starts, immediately ensure it's connected to the talome
// network. This eliminates the 60-second gap from the polling-based monitor.

async function repairContainerNetwork(containerName: string): Promise<void> {
  // Skip infrastructure containers that use host networking
  if (containerName === "talome-dns" || containerName === "talome-avahi" || containerName === "talome-tailscale") return;

  try {
    await ensureTalomeNetwork();
    await connectContainerToNetwork("talome", containerName);
  } catch {
    // Already connected or non-fatal — expected for most containers
  }
}

// ── Real-time Docker Event Handler ──────────────────────────────────────────
// Converts Docker daemon events into SystemEvents for the triage pipeline.
// This provides near-instant detection (seconds) vs the 60s polling interval.

function handleDockerEvent(event: DockerEvent): void {
  try {
    handleDockerEventUnsafe(event);
  } catch (err) {
    // Never let a handler crash kill the Docker event stream
    log.error("Docker event handler error (isolated)", err);
  }
}

function handleDockerEventUnsafe(event: DockerEvent): void {
  if (isInStartupGrace()) return;

  const config = getConfig();
  if (!config.enabled) return;

  const containerName = event.actorName || event.actorId;
  const now = new Date().toISOString();

  let systemEvent: SystemEvent | null = null;

  switch (event.action) {
    case "die":
    case "oom": {
      const severity = event.action === "oom" ? "critical" : "warning";
      systemEvent = {
        id: randomUUID(),
        type: "container_down",
        severity,
        source: containerName,
        message: event.action === "oom"
          ? `${containerName} was killed by OOM (out of memory)`
          : `${containerName} exited unexpectedly`,
        data: {
          action: event.action,
          image: event.actorImage,
          containerId: event.actorId,
          detectedVia: "docker_events",
        },
        detectedAt: now,
      };
      break;
    }
    case "restart": {
      // Ensure restarted container rejoins talome network
      if (containerName) void repairContainerNetwork(containerName);

      systemEvent = {
        id: randomUUID(),
        type: "restart_loop",
        severity: "warning",
        source: containerName,
        message: `${containerName} restarted`,
        data: {
          action: "restart",
          image: event.actorImage,
          containerId: event.actorId,
          detectedVia: "docker_events",
        },
        detectedAt: now,
      };
      break;
    }
    case "health_status": {
      // health_status events include "health_status: unhealthy" in the action
      // but the raw event has status field — we check actorName for simplicity
      break;
    }
    default:
      // start — reactive network repair: ensure container joins talome network
      if (event.action === "start" && containerName) {
        void repairContainerNetwork(containerName);
      }
      // start, stop, destroy — informational, no alert needed
      return;
  }

  if (!systemEvent) return;

  // Feed through the same dedup + persist pipeline as polling-detected events
  const result = deduplicate(systemEvent.id, systemEvent.type, systemEvent.source, systemEvent.data);

  if (result.isDuplicate) {
    try {
      db.update(schema.systemEvents)
        .set({
          occurrenceCount: result.count,
          lastSeen: now,
          message: systemEvent.message,
          data: JSON.stringify(systemEvent.data),
        })
        .where(eq(schema.systemEvents.id, result.canonicalEventId))
        .run();
    } catch { /* non-fatal */ }
    return;
  }

  // New event — persist and notify
  try {
    db.insert(schema.systemEvents)
      .values({
        id: systemEvent.id,
        type: systemEvent.type,
        severity: systemEvent.severity,
        source: systemEvent.source,
        message: systemEvent.message,
        data: JSON.stringify(systemEvent.data),
        occurrenceCount: 1,
        lastSeen: now,
        createdAt: now,
      })
      .run();
  } catch { /* non-fatal */ }

  // Immediate notification for critical events (OOM, crash)
  if (systemEvent.severity === "critical") {
    writeNotification("critical", `Container: ${systemEvent.message}`, "Detected via real-time Docker events", "docker-events");
  }

  log.info(`${systemEvent.type}: ${systemEvent.message}`);
}

/**
 * Start the background agent loop.
 * Returns a cleanup function to stop it.
 */
export function startAgentLoop(): () => void {
  const config = getConfig();

  if (!config.enabled) {
    log.info("Agent loop disabled — skipping");
    return () => {};
  }

  log.info(
    `Starting background agent (interval=${config.checkIntervalMs}ms, ` +
    `triage=${config.maxTriagePerHour}/hr, remediation=${config.maxRemediationPerHour}/hr, ` +
    `autoRemediate=${config.autoRemediate})`,
  );

  // Run first cycle after a short delay (let other systems initialize)
  setTimeout(() => void runCycleGuarded(), 10_000);

  // Main detection loop (kept as fallback — catches issues event stream might miss)
  loopTimer = setInterval(() => void runCycleGuarded(), config.checkIntervalMs);

  // Outcome verification loop (every 5 minutes) — also guarded
  verifyTimer = setInterval(() => {
    verifyPendingRemediations().catch((err) => {
      log.error("Outcome verification error (isolated)", err);
    });
  }, 5 * 60 * 1000);

  // Subscribe to real-time Docker events for near-instant crash detection
  eventStreamCleanup = subscribeDockerEvents(handleDockerEvent);

  // ── Heartbeat: detect and recover dead timers ──────────────────────
  // If the main loop timer stops firing (cleared by a bug, GC'd, etc.),
  // the heartbeat detects the gap and restarts it. Checks every 2 minutes.
  const HEARTBEAT_INTERVAL = 2 * 60 * 1000;
  const HEARTBEAT_TOLERANCE = 3; // Allow 3x the check interval before restarting

  heartbeatTimer = setInterval(() => {
    const elapsed = Date.now() - lastCycleAt;
    const maxGap = config.checkIntervalMs * HEARTBEAT_TOLERANCE;

    if (lastCycleAt > 0 && elapsed > maxGap && !running) {
      log.warn(`Heartbeat: no cycle in ${Math.round(elapsed / 1000)}s — restarting loop timer`);
      consecutiveFailures = 0; // Reset backoff for fresh start

      if (loopTimer) clearInterval(loopTimer);
      loopTimer = setInterval(() => void runCycleGuarded(), config.checkIntervalMs);

      // Trigger an immediate cycle
      void runCycleGuarded();
    }
  }, HEARTBEAT_INTERVAL);

  return () => {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = null;
    }
    if (verifyTimer) {
      clearInterval(verifyTimer);
      verifyTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (eventStreamCleanup) {
      eventStreamCleanup();
      eventStreamCleanup = null;
    }
    log.info("Stopped");
  };
}

/** Force a single cycle — useful for testing or manual triggers */
export async function runAgentCycleOnce(): Promise<void> {
  await runCycleGuarded();
}
