// ── Outcome Tracker: verify remediation results after delay ────────────────

import { db, schema } from "../db/index.js";
import { eq, and, isNull } from "drizzle-orm";
import { listContainers } from "../docker/client.js";
import { writeNotification } from "../db/notifications.js";

/**
 * Check pending remediations and verify if they succeeded.
 * Called periodically (e.g. every 5 minutes) to close the feedback loop.
 */
export async function verifyPendingRemediations(): Promise<void> {
  try {
    const pending = db
      .select()
      .from(schema.remediationLog)
      .where(
        and(
          eq(schema.remediationLog.outcome, "pending"),
          isNull(schema.remediationLog.verifiedAt),
        ),
      )
      .all();

    if (pending.length === 0) return;

    // Get current container states for verification
    let containers: Awaited<ReturnType<typeof listContainers>> = [];
    try {
      containers = await listContainers();
    } catch {
      return; // Can't verify without Docker
    }

    const containerMap = new Map(containers.map((c) => [c.name, c]));

    for (const rem of pending) {
      // Look up the original event to know what container was affected
      let event: (typeof schema.systemEvents.$inferSelect) | undefined;
      try {
        event = db
          .select()
          .from(schema.systemEvents)
          .where(eq(schema.systemEvents.id, rem.eventId))
          .get();
      } catch {
        continue;
      }

      if (!event) {
        // Event not found — mark as partial (can't verify)
        db.update(schema.remediationLog)
          .set({ outcome: "partial", verifiedAt: new Date().toISOString() })
          .where(eq(schema.remediationLog.id, rem.id))
          .run();
        continue;
      }

      const eventData = JSON.parse(event.data || "{}");
      const containerName = eventData.containerName as string | undefined;

      if (containerName) {
        const container = containerMap.get(containerName);
        const isRunning = container?.status === "running";

        let outcome: "success" | "failure" | "partial" = isRunning ? "success" : "failure";

        // Deeper check: container is running, but is the app actually healthy?
        if (isRunning && container) {
          const publicPort = container.ports?.[0]?.host;
          if (publicPort) {
            try {
              const probe = await fetch(`http://127.0.0.1:${publicPort}`, {
                signal: AbortSignal.timeout(5000),
              });
              if (!probe.ok) {
                outcome = "partial"; // Running but not serving properly
              }
            } catch {
              outcome = "partial"; // Running but port not responding
            }
          }
        }

        db.update(schema.remediationLog)
          .set({ outcome, verifiedAt: new Date().toISOString() })
          .where(eq(schema.remediationLog.id, rem.id))
          .run();

        if (outcome === "failure") {
          writeNotification(
            "warning",
            `Agent remediation failed: ${containerName}`,
            `Container is still not running after automated fix attempt.`,
            "agent-loop",
          );
        } else if (outcome === "partial") {
          writeNotification(
            "info",
            `Agent remediation partial: ${containerName}`,
            `Container is running but not responding on its HTTP port.`,
            "agent-loop",
          );
        }
      } else {
        // Non-container event — mark as partial (can't auto-verify)
        db.update(schema.remediationLog)
          .set({ outcome: "partial", verifiedAt: new Date().toISOString() })
          .where(eq(schema.remediationLog.id, rem.id))
          .run();
      }
    }
  } catch (err) {
    console.error("[agent-loop] verifyPendingRemediations error:", err);
  }
}
