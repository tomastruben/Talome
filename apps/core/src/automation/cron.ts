import { Cron } from "croner";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { fireTrigger } from "./engine.js";
import type { AutomationTrigger } from "./engine.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("automation-cron");

// How often the outer loop scans for due schedule automations. Correctness does
// not depend on this value — the (windowStart, now] occurrence check below fires
// each automation exactly once regardless of drift — so a tighter interval only
// reduces firing latency.
const TICK_MS = 30_000;

// If the outer loop hasn't ticked in this long it is considered stalled and the
// watchdog re-arms it. Comfortably above the longest single automation run
// (ai_prompt steps can take ~3 min) so a legitimately busy tick never trips it.
const STALL_MS = 6 * 60_000;

let tickTimer: ReturnType<typeof setInterval> | undefined;
let watchdogTimer: ReturnType<typeof setInterval> | undefined;
let lastTickAt = 0;
let lastCheckAt = 0;
let running = false;

/** Timestamp (ms) of the last completed scheduler scan — surfaced by /api/health. */
export function getLastCronTickAt(): number {
  return lastTickAt;
}

async function tick(): Promise<void> {
  // Never overlap: a tick that fires a long-running ai_prompt automation can
  // exceed one interval, and setInterval would otherwise start a second scan.
  if (running) return;
  running = true;

  const now = Date.now();
  const windowStart = lastCheckAt;
  lastCheckAt = now;

  try {
    const scheduleAutomations = db
      .select()
      .from(schema.automations)
      .where(eq(schema.automations.enabled, true))
      .all()
      .filter((a) => {
        try {
          const trigger = JSON.parse(a.trigger) as AutomationTrigger;
          return trigger.type === "schedule" && Boolean(trigger.cron);
        } catch {
          return false;
        }
      });

    for (const auto of scheduleAutomations) {
      try {
        const trigger = JSON.parse(auto.trigger) as AutomationTrigger;
        if (!trigger.cron) continue;

        // Fire once per scheduled occurrence: the first occurrence strictly after
        // windowStart must have arrived (<= now). Robust to interval drift and to
        // sleep/wake catch-up — after a long sleep this still yields a single
        // occurrence per automation (no catch-up storm). Note: croner's
        // previousRun() tracks actual executions of a scheduled job and is always
        // null for a pattern-only Cron, so it must not be used here (that bug
        // silently disabled all schedule automations while health stayed green).
        const cron = new Cron(trigger.cron, { timezone: "UTC" });
        const next = cron.nextRun(new Date(windowStart));
        if (!next) continue;

        const nextMs = next.getTime();
        if (nextMs <= now) {
          await fireTrigger("schedule", { automationId: auto.id, cron: trigger.cron });
        }
      } catch (err) {
        log.error(`error processing automation ${auto.id}`, err);
      }
    }
  } catch (err) {
    log.error("tick error", err);
  } finally {
    lastTickAt = Date.now();
    running = false;
  }
}

export function startAutomationCron(): void {
  const now = Date.now();
  lastCheckAt = now;
  lastTickAt = now;

  // Use setInterval — NOT croner — for the outer loop. croner's internal
  // setTimeout chain silently stopped across a macOS sleep/wake cycle (observed
  // 2026-07: all schedule automations froze while core stayed healthy). A plain
  // setInterval resumes firing after the host wakes.
  tickTimer = setInterval(() => void tick(), TICK_MS);

  // Watchdog: if the loop stalls (timer killed by a deep sleep, etc.), re-arm it
  // in place rather than exiting the process — recovery without risking the
  // supervisor's crash-escalation path. A separate timer so a hung tick can't
  // mask it.
  watchdogTimer = setInterval(() => {
    if (running) return; // a tick is legitimately in-flight
    if (Date.now() - lastTickAt <= STALL_MS) return;
    log.error(
      `scheduler stalled ${Math.round((Date.now() - lastTickAt) / 1000)}s — re-arming tick timer`,
    );
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => void tick(), TICK_MS);
    void tick();
  }, 60_000);
  watchdogTimer.unref?.();
}

export function stopAutomationCron(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  tickTimer = undefined;
  watchdogTimer = undefined;
}
