import { Cron } from "croner";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { fireTrigger } from "./engine.js";
import type { AutomationTrigger } from "./engine.js";

let cronJob: Cron | undefined;

// ── Parsed schedule cache ─────────────────────────────────────────────────
// The tick runs every minute. Parsing each automation's trigger JSON and
// compiling a Cron per row every minute is wasted work: schedules only
// change when the automation's trigger changes. The `automations` table has
// no updated_at column, so the raw trigger JSON itself is the cache key.

interface ParsedSchedule {
  /** Raw trigger JSON this entry was built from. */
  trigger: string;
  /** Compiled pattern, or null when the trigger is not a valid schedule. */
  cron: Cron | null;
  pattern: string | null;
  /** Epoch ms of the last occurrence we fired, to never fire one twice. */
  lastFiredOccurrence: number;
}

const scheduleCache = new Map<string, ParsedSchedule>();

function compileSchedule(triggerJson: string): Pick<ParsedSchedule, "cron" | "pattern"> {
  try {
    const trigger = JSON.parse(triggerJson) as AutomationTrigger;
    if (trigger.type !== "schedule" || !trigger.cron) return { cron: null, pattern: null };
    // No callback: a paused "pattern only" instance used for date maths.
    return { cron: new Cron(trigger.cron, { timezone: "UTC", paused: true }), pattern: trigger.cron };
  } catch {
    return { cron: null, pattern: null };
  }
}

/**
 * Return the cached schedule for an automation, recompiling only when its
 * trigger JSON changed. Exported for tests.
 */
export function getParsedSchedule(id: string, triggerJson: string): ParsedSchedule {
  const cached = scheduleCache.get(id);
  if (cached && cached.trigger === triggerJson) return cached;
  cached?.cron?.stop();
  const entry: ParsedSchedule = { trigger: triggerJson, ...compileSchedule(triggerJson), lastFiredOccurrence: 0 };
  scheduleCache.set(id, entry);
  return entry;
}

/** Drop cache entries for automations that no longer exist or are disabled. */
function pruneScheduleCache(liveIds: Set<string>): void {
  for (const [id, entry] of scheduleCache) {
    if (!liveIds.has(id)) {
      entry.cron?.stop();
      scheduleCache.delete(id);
    }
  }
}

/** Number of cached schedules — exported for tests. */
export function getScheduleCacheSize(): number {
  return scheduleCache.size;
}

export function clearScheduleCache(): void {
  for (const entry of scheduleCache.values()) entry.cron?.stop();
  scheduleCache.clear();
}

/**
 * Most recent occurrence of the schedule at or before `now`, if it fell
 * within the last minute and hasn't been fired yet.
 *
 * Note: croner's `previousRun()` reports when *this instance's callback*
 * last ran — always null for a pattern-only instance — so it can't be used
 * here; `previousRuns(1, now)` enumerates the pattern instead.
 */
export function dueOccurrence(entry: ParsedSchedule, now: Date): Date | null {
  if (!entry.cron) return null;
  // Probe one second ahead so an occurrence exactly at `now` counts.
  const [prev] = entry.cron.previousRuns(1, new Date(now.getTime() + 1_000));
  if (!prev) return null;
  const msAgo = now.getTime() - prev.getTime();
  if (msAgo < -1_000 || msAgo >= 60_000) return null;
  if (prev.getTime() <= entry.lastFiredOccurrence) return null;
  return prev;
}

export async function runScheduleTick(now: Date = new Date()): Promise<void> {
  // Only the columns needed to decide what's due.
  const rows = db
    .select({ id: schema.automations.id, trigger: schema.automations.trigger })
    .from(schema.automations)
    .where(eq(schema.automations.enabled, true))
    .all();

  pruneScheduleCache(new Set(rows.map((r) => r.id)));

  for (const row of rows) {
    try {
      const entry = getParsedSchedule(row.id, row.trigger);
      const due = dueOccurrence(entry, now);
      if (!due) continue;
      entry.lastFiredOccurrence = due.getTime();
      await fireTrigger("schedule", { automationId: row.id, cron: entry.pattern });
    } catch (err) {
      console.error(`[automation-cron] error processing automation ${row.id}:`, err);
    }
  }
}

export function startAutomationCron(): void {
  // Runs every minute, checks for schedule-type automations
  cronJob = new Cron("* * * * *", async () => {
    try {
      await runScheduleTick();
    } catch (err) {
      console.error("[automation-cron] error:", err);
    }
  });
}

export function stopAutomationCron(): void {
  cronJob?.stop();
  cronJob = undefined;
  clearScheduleCache();
}
