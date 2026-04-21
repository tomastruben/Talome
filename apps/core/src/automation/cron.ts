import { Cron } from "croner";
import { db, schema } from "../db/index.js";
import { eq } from "drizzle-orm";
import { fireTrigger } from "./engine.js";
import type { AutomationTrigger } from "./engine.js";

let cronJob: Cron | undefined;

export function startAutomationCron(): void {
  // Runs every minute, checks for schedule-type automations
  cronJob = new Cron("* * * * *", async () => {
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

          // Check if this cron expression would have fired in the last minute
          const cron = new Cron(trigger.cron, { timezone: "UTC" });
          const prev = cron.previousRun();
          if (!prev) continue;

          const msAgo = Date.now() - prev.getTime();
          if (msAgo < 60_000) {
            await fireTrigger("schedule", { automationId: auto.id, cron: trigger.cron });
          }
        } catch (err) {
          console.error(`[automation-cron] error processing automation ${auto.id}:`, err);
        }
      }
    } catch (err) {
      console.error("[automation-cron] error:", err);
    }
  });
}

export function stopAutomationCron(): void {
  cronJob?.stop();
  cronJob = undefined;
}
