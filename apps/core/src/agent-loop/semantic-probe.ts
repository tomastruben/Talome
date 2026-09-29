// ── Semantic outcome probe for remediations ──────────────────────────────────
//
// Plugs verification/verifyApp(appId) into the outcome tracker: a remediation
// on an app with an outcome probe is judged by whether the app does its job
// again (API reachable, root folders, download client, …), not only by
// whether its container runs.
//
//   verified → success   degraded → partial   failed → failure
//   unknown / no probe / timeout → no verdict (the container probe decides)

import { hasLiveOperation } from "../ops/operations.js";
import { registerOutcomeProbe, type OutcomeProbe, type OutcomeVerdict } from "./outcome-tracker.js";
import { resolveEventAppId } from "./app-scope.js";
import type { VerifyOutcome } from "../verification/index.js";

export interface SemanticProbeDeps {
  isVerifiableApp: (appId: string) => boolean;
  verifyApp: (appId: string, opts: { timeoutMs?: number }) => Promise<VerifyOutcome>;
  resolveAppId: (event: { source: string; data: Record<string, unknown> }) => string | null;
  isBusy: (appId: string) => boolean;
}

/** Overall deadline for one probe run (per-check timeouts are shorter). */
const PROBE_DEADLINE_MS = 45_000;
const CHECK_TIMEOUT_MS = 10_000;

async function defaultDeps(): Promise<SemanticProbeDeps> {
  const verification = await import("../verification/index.js");
  return {
    isVerifiableApp: verification.isVerifiableApp,
    verifyApp: verification.verifyApp,
    resolveAppId: resolveEventAppId,
    isBusy: hasLiveOperation,
  };
}

export function createSemanticOutcomeProbe(
  deps?: Partial<SemanticProbeDeps>,
  deadlineMs = PROBE_DEADLINE_MS,
): OutcomeProbe {
  return async ({ event, eventData }) => {
    const complete = deps?.isVerifiableApp && deps.verifyApp && deps.resolveAppId && deps.isBusy;
    const d: SemanticProbeDeps = complete ? (deps as SemanticProbeDeps) : { ...(await defaultDeps()), ...deps };
    const appId = d.resolveAppId({ source: event?.source ?? "", data: eventData });
    if (!appId) return null;
    const id = appId.toLowerCase();
    if (!d.isVerifiableApp(id)) return null;
    // Mid-operation results say nothing about the remediation — let the next pass judge it.
    if (d.isBusy(appId)) return null;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), deadlineMs);
      timer.unref?.();
    });
    let outcome: VerifyOutcome | null;
    try {
      outcome = await Promise.race([d.verifyApp(id, { timeoutMs: Math.min(CHECK_TIMEOUT_MS, deadlineMs) }), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!outcome || !outcome.ok) return null;

    const r = outcome.result;
    const failing = r.checks.filter((c) => c.status === "fail" || c.status === "timeout").map((c) => c.label);
    const detail = failing.length > 0 ? `${r.summary} (failing: ${failing.slice(0, 3).join(", ")})` : r.summary;
    const verdict = (outcome: OutcomeVerdict["outcome"]): OutcomeVerdict => ({ outcome, reason: detail, probe: "semantic" });
    switch (r.status) {
      case "verified":
        return verdict("success");
      case "degraded":
        return verdict("partial");
      case "failed":
        return verdict("failure");
      default:
        return null;
    }
  };
}

let unregister: (() => void) | null = null;

/** Register the semantic probe once (idempotent). Returns the unregister function. */
export function registerSemanticOutcomeProbe(): () => void {
  if (!unregister) {
    const off = registerOutcomeProbe("semantic", createSemanticOutcomeProbe());
    unregister = () => {
      off();
      unregister = null;
    };
  }
  return unregister;
}
