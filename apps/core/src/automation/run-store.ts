/**
 * Durable automation run records.
 *
 * Every transition is written before the work it describes happens: a run row
 * exists before its first step, and a step row is marked "running" before the
 * step's side effect. After a crash the records say exactly how far a run got,
 * so it can be resumed without repeating completed or possibly-completed steps.
 *
 * Runs are held with a lease that the executing process renews. A run whose
 * lease has expired belongs to a process that stopped; reconciliation picks it
 * up. Leases are never taken over while still valid, so a second process (for
 * example the MCP stdio server) cannot steal a run from the live server.
 */

import { randomUUID } from "node:crypto";
import { and, asc, eq, lt, or, isNull, gt } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/** Identifies this process as a lease holder. */
export const INSTANCE_ID = randomUUID();
export const LEASE_MS = 2 * 60_000;
export const HEARTBEAT_MS = 30_000;
/** Give up resuming a run that keeps getting interrupted */
export const MAX_RESUMES = 3;

export type RunRow = typeof schema.automationRuns.$inferSelect;
export type StepRunRow = typeof schema.automationStepRuns.$inferSelect;
export type RunStatus = NonNullable<RunRow["status"]>;

function leaseUntil(now = Date.now()): string {
  return new Date(now + LEASE_MS).toISOString();
}

export function createRun(params: {
  automationId: string;
  workflowVersion: number;
  triggerType: string;
  triggerData: Record<string, unknown>;
  steps?: unknown[];
}): string {
  const id = randomUUID();
  db.insert(schema.automationRuns)
    .values({
      id,
      automationId: params.automationId,
      triggeredAt: new Date().toISOString(),
      success: false,
      status: "running",
      leaseOwner: INSTANCE_ID,
      leaseExpiresAt: leaseUntil(),
      workflowVersion: params.workflowVersion,
      triggerType: params.triggerType,
      triggerData: JSON.stringify(params.triggerData),
      stepsSnapshot: params.steps ? JSON.stringify(params.steps) : null,
      context: "{}",
    })
    .run();
  return id;
}

export function getRun(runId: string): RunRow | undefined {
  return db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId)).get();
}

export function getStepRuns(runId: string): StepRunRow[] {
  return db
    .select()
    .from(schema.automationStepRuns)
    .where(eq(schema.automationStepRuns.runId, runId))
    .orderBy(asc(schema.automationStepRuns.stepIndex), asc(schema.automationStepRuns.startedAt))
    .all();
}

/**
 * Take the lease on a run this process does not hold yet. Succeeds only when the
 * run is resumable and its lease has expired (or was released), so exactly one
 * process wins.
 */
export function acquireRun(runId: string, fromStatuses: RunStatus[]): boolean {
  const now = new Date().toISOString();
  const result = db
    .update(schema.automationRuns)
    .set({ status: "running", leaseOwner: INSTANCE_ID, leaseExpiresAt: leaseUntil() })
    .where(
      and(
        eq(schema.automationRuns.id, runId),
        or(...fromStatuses.map((s) => eq(schema.automationRuns.status, s))),
        or(isNull(schema.automationRuns.leaseExpiresAt), lt(schema.automationRuns.leaseExpiresAt, now), eq(schema.automationRuns.leaseOwner, INSTANCE_ID)),
      ),
    )
    .run();
  return result.changes === 1;
}

/** Extend this process's lease; returns false if the run was taken or finished. */
export function renewLease(runId: string): boolean {
  const result = db
    .update(schema.automationRuns)
    .set({ leaseExpiresAt: leaseUntil() })
    .where(
      and(
        eq(schema.automationRuns.id, runId),
        eq(schema.automationRuns.leaseOwner, INSTANCE_ID),
        eq(schema.automationRuns.status, "running"),
      ),
    )
    .run();
  return result.changes === 1;
}

/** True when another run of this automation is executing under a live lease. */
export function hasActiveRun(automationId: string): boolean {
  const now = new Date().toISOString();
  const row = db
    .select({ id: schema.automationRuns.id })
    .from(schema.automationRuns)
    .where(
      and(
        eq(schema.automationRuns.automationId, automationId),
        eq(schema.automationRuns.status, "running"),
        gt(schema.automationRuns.leaseExpiresAt, now),
      ),
    )
    .get();
  return !!row;
}

/** Record intent to run a step — written before the step's side effect. */
export function beginStep(runId: string, automationId: string, stepIndex: number, stepId: string, stepType: string): string {
  const id = randomUUID();
  db.insert(schema.automationStepRuns)
    .values({
      id,
      runId,
      automationId,
      stepId,
      stepType,
      stepIndex,
      status: "running",
      startedAt: new Date().toISOString(),
      success: false,
    })
    .run();
  return id;
}

export function finishStep(
  stepRunId: string,
  result: { success: boolean; blocked?: boolean; output?: string; error?: string; durationMs: number; approvalId?: string },
): void {
  db.update(schema.automationStepRuns)
    .set({
      status: result.blocked ? "blocked" : result.success ? "succeeded" : "failed",
      success: result.success,
      blocked: result.blocked ?? false,
      output: result.output ?? null,
      error: result.error ?? null,
      durationMs: result.durationMs,
      approvalId: result.approvalId ?? null,
      finishedAt: new Date().toISOString(),
    })
    .where(eq(schema.automationStepRuns.id, stepRunId))
    .run();
}

export function markStep(stepRunId: string, status: "unknown" | "retried", note: string): void {
  db.update(schema.automationStepRuns)
    .set({ status, error: note, finishedAt: new Date().toISOString() })
    .where(eq(schema.automationStepRuns.id, stepRunId))
    .run();
}

export function saveContext(runId: string, stepOutputs: Record<string, string>, actionsRun: number): void {
  db.update(schema.automationRuns)
    .set({ context: JSON.stringify(stepOutputs), actionsRun, leaseExpiresAt: leaseUntil() })
    .where(and(eq(schema.automationRuns.id, runId), eq(schema.automationRuns.leaseOwner, INSTANCE_ID)))
    .run();
}

export function finishRun(
  runId: string,
  status: Exclude<RunStatus, "running">,
  outcome: { error: string | null; actionsRun: number; resultSummary: unknown },
): void {
  db.update(schema.automationRuns)
    .set({
      status,
      success: status === "succeeded",
      error: outcome.error,
      actionsRun: outcome.actionsRun,
      resultSummary: JSON.stringify(outcome.resultSummary),
      finishedAt: status === "waiting_approval" ? null : new Date().toISOString(),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(eq(schema.automationRuns.id, runId))
    .run();
}

export function incrementResumeCount(runId: string): number {
  const run = getRun(runId);
  const next = (run?.resumeCount ?? 0) + 1;
  db.update(schema.automationRuns).set({ resumeCount: next }).where(eq(schema.automationRuns.id, runId)).run();
  return next;
}

/** Runs whose executing process stopped renewing its lease. */
export function listAbandonedRuns(now = new Date()): RunRow[] {
  return db
    .select()
    .from(schema.automationRuns)
    .where(and(eq(schema.automationRuns.status, "running"), lt(schema.automationRuns.leaseExpiresAt, now.toISOString())))
    .all();
}

export function listRunsWaitingForApproval(): RunRow[] {
  return db.select().from(schema.automationRuns).where(eq(schema.automationRuns.status, "waiting_approval")).all();
}
