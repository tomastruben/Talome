// ── Durable, per-app operations journal ──────────────────────────────────────
//
// Every lifecycle operation on an app (install, update, start, …) runs through
// withAppOperation(). It guarantees:
//   • one operation per app at a time — a conflicting request fails fast with a
//     message naming the operation already running (no silent queueing);
//   • the journal row is written BEFORE any work starts, and updated at every
//     step transition, so progress is honest and survives a restart;
//   • a terminal status is always recorded (succeeded / failed / rolled_back),
//     and operations cut short by a crash are marked "interrupted" on boot
//     (see ops/recovery.ts).

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { and, desc, eq, gt, inArray, asc } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createLogger } from "../utils/logger.js";
import { currentOperationActor, runWithOperationActor } from "../ai/actor-context.js";

const log = createLogger("ops");

// ── Types ─────────────────────────────────────────────────────────────────────

export const OPERATION_KINDS = [
  "install",
  "update",
  "uninstall",
  "start",
  "stop",
  "restart",
  "rollback",
  "backup",
  "restore",
  "configure",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export const OPERATION_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rolled_back",
  "interrupted",
] as const;
export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const ACTIVE_OPERATION_STATUSES: OperationStatus[] = ["queued", "running"];

export const operationKindSchema = z.enum(OPERATION_KINDS);
export const operationStatusSchema = z.enum(OPERATION_STATUSES);

export type TerminalOperationStatus = Extract<OperationStatus, "succeeded" | "failed" | "rolled_back">;

export interface OperationRecord {
  id: string;
  appId: string;
  kind: OperationKind;
  actor: string;
  status: OperationStatus;
  step: string | null;
  progress: number;
  detail: Record<string, unknown> | null;
  error: string | null;
  idempotencyKey: string | null;
  startedAt: string;
  updatedAt: string;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

export interface OperationStepRecord {
  id: number;
  operationId: string;
  status: OperationStatus;
  step: string | null;
  progress: number;
  message: string | null;
  createdAt: string;
}

export interface OperationEvent {
  operationId: string;
  appId: string;
  kind: OperationKind;
  actor: string;
  status: OperationStatus;
  step: string | null;
  progress: number;
  message?: string;
  error?: string;
  at: string;
}

export interface OperationContext {
  readonly id: string;
  readonly appId: string;
  readonly kind: OperationKind;
  readonly actor: string;
  /** Persist a step transition + progress (0-100) and emit it to listeners. */
  step(name: string, progress: number, message?: string): void;
  /** Merge structured detail into the journal row. */
  setDetail(patch: Record<string, unknown>): void;
  /** Record that the operation ended by rolling back (terminal status rolled_back). */
  markRolledBack(reason: string): void;
  /** Force the terminal status to failed, regardless of the returned result. */
  markFailed(reason: string): void;
}

export interface WithAppOperationOptions<T> {
  idempotencyKey?: string;
  detail?: Record<string, unknown>;
  /** Map fn's result to a terminal status. Default: `{ success: false }` → failed. */
  classify?: (result: T) => { status: TerminalOperationStatus; error?: string };
  /** Heartbeat interval while running (default 15s). */
  heartbeatMs?: number;
}

// ── Conflict error ────────────────────────────────────────────────────────────

export interface RunningOperationInfo {
  id: string;
  appId: string;
  kind: OperationKind;
  actor: string;
  step: string | null;
  progress: number;
  startedAt: string;
}

export class OperationConflictError extends Error {
  readonly appId: string;
  readonly requestedKind: OperationKind;
  readonly running: RunningOperationInfo;

  constructor(appId: string, requestedKind: OperationKind, running: RunningOperationInfo) {
    const stepInfo = running.step ? `, step "${running.step}" at ${running.progress}%` : "";
    super(
      `Cannot ${requestedKind} ${appId}: a ${running.kind} operation (${running.id}) started by ${running.actor} ` +
      `at ${running.startedAt} is still running${stepInfo}. Wait for it to finish and try again.`,
    );
    this.name = "OperationConflictError";
    this.appId = appId;
    this.requestedKind = requestedKind;
    this.running = running;
  }
}

// ── Actor context ─────────────────────────────────────────────────────────────
// Lets an entry point (chat, MCP, automation, agent loop) attribute nested
// lifecycle calls without threading an actor argument through every tool.
// Shares one AsyncLocalStorage with the tool execution service
// (ai/actor-context.ts): executeTool() runs each tool as its actor, so an
// operation started from a chat turn, an MCP call, an automation or the agent
// loop is journaled as e.g. "user:<id> (<name> (chat))",
// "mcp_token:<id> (MCP token \"<name>\")", "automation:<id> (Automation: <name>)"
// or "agent_loop:remediation (…)". An explicit runWithActor() string wins
// over the execution actor; the innermost context wins.

export function runWithActor<T>(actor: string, fn: () => T): T {
  return runWithOperationActor(actor, fn);
}

export function currentActor(fallback = "system"): string {
  return currentOperationActor(fallback);
}

// ── Events ────────────────────────────────────────────────────────────────────

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

const OPERATION_EVENT = "operation";

export function onOperationEvent(listener: (event: OperationEvent) => void): () => void {
  emitter.on(OPERATION_EVENT, listener);
  return () => {
    emitter.off(OPERATION_EVENT, listener);
  };
}

export function emitOperationEvent(event: OperationEvent): void {
  try {
    emitter.emit(OPERATION_EVENT, event);
  } catch (err) {
    log.warn("Operation event listener threw", err);
  }
}

// ── In-process per-app mutex ─────────────────────────────────────────────────

const activeOps = new Map<string, RunningOperationInfo>();
/** Settles when the in-process operation on the app finishes (never rejects). */
const activeCompletions = new Map<string, Promise<void>>();

export function getActiveOperation(appId: string): RunningOperationInfo | null {
  return activeOps.get(appId) ?? null;
}

export function listActiveOperationsInProcess(): RunningOperationInfo[] {
  return [...activeOps.values()];
}

// ── Row helpers ───────────────────────────────────────────────────────────────

type OperationRow = typeof schema.appOperations.$inferSelect;

function parseDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toKind(value: string): OperationKind {
  const parsed = operationKindSchema.safeParse(value);
  return parsed.success ? parsed.data : "configure";
}

function toStatus(value: string): OperationStatus {
  const parsed = operationStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : "failed";
}

export function rowToOperation(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    appId: row.appId,
    kind: toKind(row.kind),
    actor: row.actor,
    status: toStatus(row.status),
    step: row.step,
    progress: row.progress,
    detail: parseDetail(row.detail),
    error: row.error,
    idempotencyKey: row.idempotencyKey,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    heartbeatAt: row.heartbeatAt,
    finishedAt: row.finishedAt,
  };
}

function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

function insertEventRow(
  operationId: string,
  appId: string,
  status: OperationStatus,
  step: string | null,
  progress: number,
  message: string | null,
  at: string,
): void {
  db.insert(schema.appOperationEvents)
    .values({ operationId, appId, status, step, progress, message, createdAt: at })
    .run();
}

// ── Cross-process coordination ────────────────────────────────────────────────
// The MCP stdio server is a separate process sharing the same database, so the
// in-process mutex is backed by the journal: an active row whose heartbeat is
// fresh and whose owner is another live process also blocks the app.

export const HEARTBEAT_INTERVAL_MS = 15_000;
/** An active row from another process counts as live while its heartbeat is newer than this. */
export const HEARTBEAT_STALE_MS = 90_000;

export const OWNER_HOST = hostname();

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Is a journal row owned by another process still genuinely running?
 *
 * The heartbeat must be fresh. A PID is only checked when the owner ran on this
 * host (legacy rows without a host are assumed local): across PID namespaces
 * — e.g. the server in a container and the MCP stdio process on the host —
 * `kill(pid, 0)` says nothing, so heartbeat freshness alone decides.
 */
export function isForeignOwnerLive(
  row: { ownerPid: number | null; ownerHost?: string | null; heartbeatAt: string | null; updatedAt: string },
  now: number = Date.now(),
  staleMs: number = HEARTBEAT_STALE_MS,
): boolean {
  const heartbeat = Date.parse(row.heartbeatAt ?? row.updatedAt);
  if (!Number.isFinite(heartbeat) || now - heartbeat >= staleMs) return false;
  const sameHost = !row.ownerHost || row.ownerHost === OWNER_HOST;
  return sameHost ? isPidAlive(row.ownerPid) : true;
}

let schemaEnsured = false;

/** The MCP stdio process never runs migrations — create the journal tables lazily if missing. */
async function ensureJournalSchema(): Promise<void> {
  if (schemaEnsured) return;
  const { runOpsUpdatesMigrations } = await import("../db/migrations/ops-updates.js");
  runOpsUpdatesMigrations();
  schemaEnsured = true;
}

interface JournalInsert {
  id: string;
  appId: string;
  kind: OperationKind;
  actor: string;
  detail: string | null;
  idempotencyKey: string | null;
  startedAt: string;
}

/**
 * Atomically (IMMEDIATE transaction → SQLite write lock, serialized across
 * processes) check for a live operation owned by another process and insert
 * ours. Returns the other process's operation when it blocks us.
 */
function insertJournalRowOnce(row: JournalInsert): RunningOperationInfo | null {
  return db.transaction((tx) => {
    const now = Date.now();
    const freshSince = new Date(now - HEARTBEAT_STALE_MS).toISOString();
    const others = tx
      .select()
      .from(schema.appOperations)
      .where(and(
        eq(schema.appOperations.appId, row.appId),
        inArray(schema.appOperations.status, ACTIVE_OPERATION_STATUSES),
        gt(schema.appOperations.heartbeatAt, freshSince),
      ))
      .all()
      .filter((o) => !isOwnRow(o) && isForeignOwnerLive(o, now));
    const blocking = others[0];
    if (blocking) {
      return {
        id: blocking.id,
        appId: blocking.appId,
        kind: toKind(blocking.kind),
        actor: `${blocking.actor} (process ${blocking.ownerPid}${blocking.ownerHost && blocking.ownerHost !== OWNER_HOST ? ` on ${blocking.ownerHost}` : ""})`,
        step: blocking.step,
        progress: blocking.progress,
        startedAt: blocking.startedAt,
      };
    }

    tx.insert(schema.appOperations)
      .values({
        id: row.id,
        appId: row.appId,
        kind: row.kind,
        actor: row.actor,
        status: "running",
        step: "starting",
        progress: 0,
        detail: row.detail,
        error: null,
        idempotencyKey: row.idempotencyKey,
        startedAt: row.startedAt,
        updatedAt: row.startedAt,
        heartbeatAt: row.startedAt,
        finishedAt: null,
        ownerPid: process.pid,
        ownerHost: OWNER_HOST,
      })
      .run();
    tx.insert(schema.appOperationEvents)
      .values({ operationId: row.id, appId: row.appId, status: "running", step: "starting", progress: 0, message: null, createdAt: row.startedAt })
      .run();
    return null;
  }, { behavior: "immediate" });
}

/** Row written by this very process (same PID on the same host). */
function isOwnRow(row: { ownerPid: number | null; ownerHost?: string | null }): boolean {
  return row.ownerPid === process.pid && (!row.ownerHost || row.ownerHost === OWNER_HOST);
}

function isMissingSchemaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("no such table") || msg.includes("no such column") || msg.includes("has no column named");
}

// ── Core API ──────────────────────────────────────────────────────────────────

function defaultClassify(result: unknown): { status: TerminalOperationStatus; error?: string } {
  if (result && typeof result === "object" && "success" in result) {
    const r = result as { success?: unknown; error?: unknown };
    if (r.success === false) {
      return { status: "failed", error: typeof r.error === "string" ? r.error : "Operation failed" };
    }
  }
  return { status: "succeeded" };
}

/**
 * Run `fn` as a durable, exclusive operation on `appId`.
 *
 * Throws OperationConflictError synchronously-at-first-await when another
 * operation on the same app is in progress in this process. Rethrows anything
 * `fn` throws after recording the operation as failed.
 */
export async function withAppOperation<T>(
  appId: string,
  kind: OperationKind,
  actor: string,
  fn: (ctx: OperationContext) => Promise<T>,
  opts: WithAppOperationOptions<T> = {},
): Promise<T> {
  // Check-and-reserve with no await in between: no race window in-process.
  const running = activeOps.get(appId);
  if (running) throw new OperationConflictError(appId, kind, running);

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const info: RunningOperationInfo = { id, appId, kind, actor, step: "starting", progress: 0, startedAt };
  activeOps.set(appId, info);
  let settle!: () => void;
  const completion = new Promise<void>((resolve) => { settle = resolve; });
  activeCompletions.set(appId, completion);

  let detail: Record<string, unknown> = { ...(opts.detail ?? {}) };
  const outcome: { override: { status: TerminalOperationStatus; error?: string } | null } = { override: null };

  try {
    // Journal row is written BEFORE any work starts. If this fails we refuse
    // to run: an unjournaled operation is exactly what we are preventing.
    const row: JournalInsert = {
      id,
      appId,
      kind,
      actor,
      detail: Object.keys(detail).length > 0 ? JSON.stringify(detail) : null,
      idempotencyKey: opts.idempotencyKey ?? null,
      startedAt,
    };
    let otherProcessOp: RunningOperationInfo | null;
    try {
      otherProcessOp = insertJournalRowOnce(row);
    } catch (err) {
      if (!isMissingSchemaError(err) || schemaEnsured) throw err;
      await ensureJournalSchema();
      otherProcessOp = insertJournalRowOnce(row);
    }
    if (otherProcessOp) throw new OperationConflictError(appId, kind, otherProcessOp);
  } catch (err) {
    activeOps.delete(appId);
    activeCompletions.delete(appId);
    settle();
    throw err;
  }

  emitOperationEvent({ operationId: id, appId, kind, actor, status: "running", step: "starting", progress: 0, at: startedAt });

  const heartbeat = setInterval(() => {
    try {
      db.update(schema.appOperations)
        .set({ heartbeatAt: new Date().toISOString() })
        .where(eq(schema.appOperations.id, id))
        .run();
    } catch {
      // Heartbeat is advisory
    }
  }, opts.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const ctx: OperationContext = {
    id,
    appId,
    kind,
    actor,
    step(name: string, progress: number, message?: string) {
      const pct = clampProgress(progress);
      const at = new Date().toISOString();
      info.step = name;
      info.progress = pct;
      try {
        db.update(schema.appOperations)
          .set({ step: name, progress: pct, updatedAt: at, heartbeatAt: at })
          .where(eq(schema.appOperations.id, id))
          .run();
        insertEventRow(id, appId, "running", name, pct, message ?? null, at);
      } catch (err) {
        log.warn(`Failed to persist step ${name} for operation ${id}`, err);
      }
      emitOperationEvent({ operationId: id, appId, kind, actor, status: "running", step: name, progress: pct, message, at });
    },
    setDetail(patch: Record<string, unknown>) {
      detail = { ...detail, ...patch };
      try {
        db.update(schema.appOperations)
          .set({ detail: JSON.stringify(detail), updatedAt: new Date().toISOString() })
          .where(eq(schema.appOperations.id, id))
          .run();
      } catch (err) {
        log.warn(`Failed to persist detail for operation ${id}`, err);
      }
    },
    markRolledBack(reason: string) {
      outcome.override = { status: "rolled_back", error: reason };
    },
    markFailed(reason: string) {
      outcome.override = { status: "failed", error: reason };
    },
  };

  try {
    const result = await fn(ctx);
    const verdict = outcome.override ?? (opts.classify ? opts.classify(result) : defaultClassify(result));
    finishOperation(id, appId, kind, actor, info, verdict.status, verdict.error ?? null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finishOperation(id, appId, kind, actor, info, "failed", message);
    throw err;
  } finally {
    clearInterval(heartbeat);
    if (activeOps.get(appId)?.id === id) activeOps.delete(appId);
    if (activeCompletions.get(appId) === completion) activeCompletions.delete(appId);
    settle();
  }
}

// ── Waiting on another operation ──────────────────────────────────────────────
// Entry points fail fast on conflicts. Internal callers that genuinely depend
// on another app's operation (e.g. auto-starting a dependency that a parallel
// bulk start is already starting) wait for it instead.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Live operation on the app owned by another process (fresh heartbeat), if any. */
function findForeignLiveOperation(appId: string): OperationRow | null {
  const now = Date.now();
  const freshSince = new Date(now - HEARTBEAT_STALE_MS).toISOString();
  const rows = db
    .select()
    .from(schema.appOperations)
    .where(and(
      eq(schema.appOperations.appId, appId),
      inArray(schema.appOperations.status, ACTIVE_OPERATION_STATUSES),
      gt(schema.appOperations.heartbeatAt, freshSince),
    ))
    .all();
  return rows.find((r) => !isOwnRow(r) && isForeignOwnerLive(r, now)) ?? null;
}

/**
 * True when an operation on the app is genuinely in progress — in this process,
 * or in another live process (fresh heartbeat). Recovery uses this so it never
 * rewrites the status of an app that is mid-install/update.
 */
export function hasLiveOperation(appId: string): boolean {
  if (activeOps.has(appId)) return true;
  try {
    return findForeignLiveOperation(appId) !== null;
  } catch {
    return false;
  }
}

/**
 * Wait until no operation is running on the app (in this process or another
 * live one). Resolves true when the app is free, false on timeout.
 */
export async function waitForAppOperation(
  appId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
  const pollMs = opts.pollMs ?? 1_000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return !hasLiveOperation(appId);
    const local = activeCompletions.get(appId);
    if (local) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        local,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      if (timer) clearTimeout(timer);
      continue;
    }
    let foreign: OperationRow | null = null;
    try {
      foreign = findForeignLiveOperation(appId);
    } catch {
      foreign = null;
    }
    if (!foreign) return true;
    await sleep(Math.min(pollMs, remaining));
  }
}

function finishOperation(
  id: string,
  appId: string,
  kind: OperationKind,
  actor: string,
  info: RunningOperationInfo,
  status: TerminalOperationStatus,
  error: string | null,
): void {
  const at = new Date().toISOString();
  const progress = status === "succeeded" ? 100 : info.progress;
  const step = status === "succeeded" ? "done" : info.step;
  try {
    db.update(schema.appOperations)
      .set({ status, error: error ? error.slice(0, 4000) : null, progress, step, updatedAt: at, finishedAt: at })
      .where(eq(schema.appOperations.id, id))
      .run();
    insertEventRow(id, appId, status, step, progress, error ? error.slice(0, 1000) : null, at);
  } catch (err) {
    log.error(`Failed to record terminal status ${status} for operation ${id}`, err);
  }
  emitOperationEvent({
    operationId: id,
    appId,
    kind,
    actor,
    status,
    step,
    progress,
    ...(error ? { error } : {}),
    at,
  });
}

// ── Queries ───────────────────────────────────────────────────────────────────

export function getOperation(id: string): OperationRecord | null {
  const row = db.select().from(schema.appOperations).where(eq(schema.appOperations.id, id)).get();
  return row ? rowToOperation(row) : null;
}

export function listAppOperations(appId: string, limit = 50): OperationRecord[] {
  return db
    .select()
    .from(schema.appOperations)
    .where(eq(schema.appOperations.appId, appId))
    .orderBy(desc(schema.appOperations.startedAt))
    .limit(Math.max(1, Math.min(limit, 500)))
    .all()
    .map(rowToOperation);
}

export function listOperations(opts: { active?: boolean; limit?: number } = {}): OperationRecord[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const base = db.select().from(schema.appOperations);
  const rows = opts.active
    ? base.where(inArray(schema.appOperations.status, ACTIVE_OPERATION_STATUSES)).orderBy(desc(schema.appOperations.startedAt)).limit(limit).all()
    : base.orderBy(desc(schema.appOperations.startedAt)).limit(limit).all();
  return rows.map(rowToOperation);
}

export function listOperationSteps(operationId: string): OperationStepRecord[] {
  return db
    .select()
    .from(schema.appOperationEvents)
    .where(eq(schema.appOperationEvents.operationId, operationId))
    .orderBy(asc(schema.appOperationEvents.id))
    .all()
    .map((r) => ({
      id: r.id,
      operationId: r.operationId,
      status: toStatus(r.status),
      step: r.step,
      progress: r.progress,
      message: r.message,
      createdAt: r.createdAt,
    }));
}

export function findOperationByIdempotencyKey(appId: string, key: string): OperationRecord | null {
  const row = db
    .select()
    .from(schema.appOperations)
    .where(and(eq(schema.appOperations.appId, appId), eq(schema.appOperations.idempotencyKey, key)))
    .orderBy(desc(schema.appOperations.startedAt))
    .limit(1)
    .get();
  return row ? rowToOperation(row) : null;
}

/** Merge detail into an operation that is no longer running (used by recovery). */
export function patchOperationDetail(id: string, patch: Record<string, unknown>): void {
  const row = db.select().from(schema.appOperations).where(eq(schema.appOperations.id, id)).get();
  if (!row) return;
  const merged = { ...(parseDetail(row.detail) ?? {}), ...patch };
  db.update(schema.appOperations)
    .set({ detail: JSON.stringify(merged), updatedAt: new Date().toISOString() })
    .where(eq(schema.appOperations.id, id))
    .run();
}

/** Test-only: clear the in-process mutex table. */
export function __resetActiveOperationsForTests(): void {
  activeOps.clear();
  activeCompletions.clear();
}
