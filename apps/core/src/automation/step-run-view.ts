// ── Legacy view of automation step rows ───────────────────────────────────────
//
// The engine journals every planned step up front as "pending" (see
// createRunJournal in engine.ts) and marks the ones that never ran "skipped".
// Readers built before that (run-history API, get_automation_runs tool, the
// dashboard) only understand executed steps with a success flag, so they list
// executed steps only, in execution order.

/** Step statuses that mean the step never executed. */
export const NOT_EXECUTED_STEP_STATUSES: readonly string[] = ["pending", "skipped"];

interface StepRunLike {
  status?: string | null;
  stepIndex?: number | null;
  startedAt: string;
}

/**
 * Executed steps only, ordered by step index (legacy rows without an index
 * fall back to their start time, after indexed rows).
 */
export function executedStepRuns<T extends StepRunLike>(rows: T[]): T[] {
  return rows
    .filter((r) => !r.status || !NOT_EXECUTED_STEP_STATUSES.includes(r.status))
    .sort((a, b) => {
      const ai = a.stepIndex ?? Number.POSITIVE_INFINITY;
      const bi = b.stepIndex ?? Number.POSITIVE_INFINITY;
      if (ai !== bi) return ai - bi;
      return a.startedAt.localeCompare(b.startedAt);
    });
}
