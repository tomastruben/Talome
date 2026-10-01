import { Cron } from "croner";
import { db, schema } from "../db/index.js";
import { eq, inArray } from "drizzle-orm";
import { fireTrigger } from "./engine.js";
import type { AutomationTrigger } from "./engine.js";
import { getSetting, setSetting } from "../utils/settings.js";
import { writeNotification } from "../db/notifications.js";

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

// ── One-time pause of dormant schedule automations ────────────────────────
// Before the parsed-schedule cache landed, the tick asked croner for
// `previousRun()` on a pattern-only instance, which is always null — so no
// schedule automation had ever fired. Fixing that would suddenly start every
// enabled schedule automation in existing databases (some long forgotten,
// some with restart/prune/AI steps), on a UTC clock the user may not expect.
// Instead, the first boot with the fix pauses them once and tells the user;
// re-enabling one is the opt-in. Automations created afterwards run normally.
// Some servers ran a build whose scheduler did work: an automation with runs
// on record has already been acting for the user, so it is left running.

export const SCHEDULE_ACTIVATION_SETTING = "automation_schedules_activated_at";

function isScheduleTrigger(triggerJson: string): boolean {
  try {
    const trigger = JSON.parse(triggerJson) as AutomationTrigger;
    return trigger.type === "schedule" && Boolean(trigger.cron);
  } catch {
    return false;
  }
}

/**
 * Pause enabled schedule automations that predate the scheduler fix and have
 * never run (runs once, guarded by a settings marker). Returns how many were paused.
 */
export function pauseDormantScheduleAutomations(): number {
  try {
    if (getSetting(SCHEDULE_ACTIVATION_SETTING)) return 0;
    const dormant = db
      .select({
        id: schema.automations.id,
        name: schema.automations.name,
        trigger: schema.automations.trigger,
        runCount: schema.automations.runCount,
        lastRunAt: schema.automations.lastRunAt,
      })
      .from(schema.automations)
      .where(eq(schema.automations.enabled, true))
      .all()
      .filter((row) => isScheduleTrigger(row.trigger) && !row.runCount && !row.lastRunAt);

    if (dormant.length > 0) {
      db.update(schema.automations)
        .set({ enabled: false })
        .where(inArray(schema.automations.id, dormant.map((row) => row.id)))
        .run();
      const names = dormant.map((row) => row.name).join(", ");
      writeNotification(
        "info",
        `${dormant.length} scheduled automation${dormant.length === 1 ? "" : "s"} paused for review`,
        `A scheduler bug kept schedule-triggered automations from ever running. It is fixed now, so these were paused instead of starting unexpectedly: ${names}. Re-enable each one you still want. Schedules are evaluated in UTC.`,
      );
      console.log(`[automation-cron] paused ${dormant.length} dormant schedule automation(s) for review`);
    }
    setSetting(SCHEDULE_ACTIVATION_SETTING, new Date().toISOString());
    return dormant.length;
  } catch (err) {
    console.error("[automation-cron] could not pause dormant schedule automations:", err);
    return 0;
  }
}

export function startAutomationCron(): void {
  pauseDormantScheduleAutomations();
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
