// ── Outcome Tracker: verify remediation results after delay ────────────────
//
// Remediations are recorded as "pending" (diagnosis only) or
// "pending_verification" (the agent ran a write tool). Only this tracker may
// turn an attempted fix into "fixed" — after a probe confirms it. Anything the
// probes cannot confirm is reported as "attempted, not verified".
//
// Extension point: registerOutcomeProbe() — richer verification (e.g. the
// verification/verifyApp(appId) module) plugs in here without changing the
// tracker. Probes run in registration order before the built-in container
// probe; the first probe that returns a verdict wins. The agent loop registers
// the semantic probe (agent-loop/semantic-probe.ts) on start.
//
// Remediations on an app with a live operation or in a maintenance window are
// not judged until the operation is over (the app is changing on purpose).

import { db, schema } from "../db/index.js";
import { eq, and, isNull, inArray } from "drizzle-orm";
import type { Container } from "@talome/types";
import { listContainers } from "../docker/client.js";
import { writeNotification } from "../db/notifications.js";
import { checkRemediationGuard } from "./app-scope.js";

export type VerifiedOutcome = "success" | "failure" | "partial";

export interface OutcomeVerdict {
  outcome: VerifiedOutcome;
  /** Human-readable reason, shown in notifications */
  reason: string;
  /** Which probe produced the verdict */
  probe: string;
}

export interface OutcomeProbeContext {
  remediation: typeof schema.remediationLog.$inferSelect;
  event: typeof schema.systemEvents.$inferSelect | undefined;
  eventData: Record<string, unknown>;
  /** Live containers keyed by name (fetched once per verification pass) */
  containers: Map<string, Container>;
}

/** Return a verdict, or null when the probe does not apply to this event. */
export type OutcomeProbe = (ctx: OutcomeProbeContext) => Promise<OutcomeVerdict | null>;

const extraProbes: { name: string; probe: OutcomeProbe }[] = [];

/**
 * Register an additional outcome probe (e.g. an app-level verifier). Returns an
 * unregister function. Probes registered here run before the built-in ones.
 */
export function registerOutcomeProbe(name: string, probe: OutcomeProbe): () => void {
  const entry = { name, probe };
  extraProbes.push(entry);
  return () => {
    const idx = extraProbes.indexOf(entry);
    if (idx >= 0) extraProbes.splice(idx, 1);
  };
}

/** Built-in probe: the affected container is running and its first public port answers. */
export const containerProbe: OutcomeProbe = async ({ eventData, containers }) => {
  const containerName = typeof eventData.containerName === "string" ? eventData.containerName : undefined;
  if (!containerName) return null;

  const container = containers.get(containerName);
  if (container?.status !== "running") {
    return { outcome: "failure", reason: "Container is still not running", probe: "container" };
  }

  // Deeper check: container is running, but is the app actually serving?
  const publicPort = container.ports?.[0]?.host;
  if (publicPort) {
    try {
      const probe = await fetch(`http://127.0.0.1:${publicPort}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!probe.ok) {
        return { outcome: "partial", reason: `Container is running but its HTTP port answered ${probe.status}`, probe: "container" };
      }
    } catch {
      return { outcome: "partial", reason: "Container is running but not responding on its HTTP port", probe: "container" };
    }
  }
  return { outcome: "success", reason: "Container is running and responding", probe: "container" };
};

/** Fallback when no probe applies: can't auto-verify (kept as "partial"). */
const NO_PROBE_VERDICT: OutcomeVerdict = {
  outcome: "partial",
  reason: "No automated check is available for this kind of event",
  probe: "none",
};

export async function evaluateRemediationOutcome(ctx: OutcomeProbeContext): Promise<OutcomeVerdict> {
  if (!ctx.event) {
    return { outcome: "partial", reason: "Original event not found", probe: "none" };
  }
  for (const { name, probe } of [...extraProbes, { name: "container", probe: containerProbe }]) {
    try {
      const verdict = await probe(ctx);
      if (verdict) return verdict;
    } catch (err) {
      console.warn(`[agent-loop] outcome probe ${name} failed:`, err);
    }
  }
  return NO_PROBE_VERDICT;
}

/** Attempted fixes are given this long to take effect before being judged. */
const MIN_VERIFY_AGE_MS = 60_000;

function parseEventData(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function notifyVerdict(
  rem: typeof schema.remediationLog.$inferSelect,
  subject: string,
  verdict: OutcomeVerdict,
): void {
  const attemptedFix = rem.outcome === "pending_verification";

  if (attemptedFix) {
    if (verdict.outcome === "success") {
      writeNotification("info", `Agent fixed: ${subject}`, `Verified: ${verdict.reason}.`, "agent-loop");
    } else {
      writeNotification(
        "warning",
        `Agent attempted fix, not verified: ${subject}`,
        `${verdict.reason}. The automated fix could not be confirmed — check the app.`,
        "agent-loop",
      );
    }
    return;
  }

  // Diagnosis-only remediations: same notifications as before.
  if (verdict.probe !== "container") return;
  if (verdict.outcome === "failure") {
    writeNotification(
      "warning",
      `Agent remediation failed: ${subject}`,
      `Container is still not running after automated fix attempt.`,
      "agent-loop",
    );
  } else if (verdict.outcome === "partial") {
    writeNotification(
      "info",
      `Agent remediation partial: ${subject}`,
      `Container is running but not responding on its HTTP port.`,
      "agent-loop",
    );
  }
}

/**
 * Check pending remediations and verify if they succeeded.
 * Called periodically (e.g. every 5 minutes) to close the feedback loop.
 */
export async function verifyPendingRemediations(opts: { now?: number } = {}): Promise<void> {
  try {
    const now = opts.now ?? Date.now();
    const pending = db
      .select()
      .from(schema.remediationLog)
      .where(
        and(
          inArray(schema.remediationLog.outcome, ["pending", "pending_verification"]),
          isNull(schema.remediationLog.verifiedAt),
        ),
      )
      .all()
      .filter((rem) =>
        rem.outcome !== "pending_verification" ||
        now - Date.parse(rem.createdAt) >= MIN_VERIFY_AGE_MS,
      );

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
      // Look up the original event to know what was affected
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

      const eventData = parseEventData(event?.data);
      // An app being updated/restored/backed up right now cannot be judged —
      // leave the remediation pending until the operation is over.
      if (event && checkRemediationGuard({ source: event.source, data: eventData }).blocked) continue;
      const verdict = await evaluateRemediationOutcome({ remediation: rem, event, eventData, containers: containerMap });

      db.update(schema.remediationLog)
        .set({ outcome: verdict.outcome, verifiedAt: new Date().toISOString() })
        .where(eq(schema.remediationLog.id, rem.id))
        .run();

      const subject = (typeof eventData.containerName === "string" && eventData.containerName) || event?.source || rem.eventId;
      notifyVerdict(rem, subject, verdict);
    }
  } catch (err) {
    console.error("[agent-loop] verifyPendingRemediations error:", err);
  }
}
