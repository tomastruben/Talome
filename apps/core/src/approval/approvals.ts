/**
 * Server-issued approvals.
 *
 * Replaces the old "model passes confirmed: true" convention, which let the
 * model approve itself. Lifecycle:
 *
 *   pending ──(admin approves)──▶ approved ──(agent retries w/ approval_id)──▶ consumed
 *      │                            │
 *      ├──(admin denies)──▶ denied  └──(TTL passes)──▶ expired
 *      └──(TTL passes)──▶ expired
 *
 * An approval is bound to actor (kind + id), tool name, and a hash of the
 * canonicalized arguments. Consumption is a single conditional UPDATE, so an
 * approval can authorize exactly one execution even under concurrent retries.
 */

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/** Reserved argument carrying an approval id; stripped before the tool runs. */
export const APPROVAL_ARG = "approval_id";

/**
 * Keys excluded from the args hash. `confirmed` is the legacy model-supplied
 * flag some tools still declare — it is not an operation parameter, so a retry
 * that flips it must still match the approved request.
 */
const HASH_EXCLUDED_KEYS = new Set([APPROVAL_ARG, "confirmed"]);

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";
export type ApprovalRow = typeof schema.approvals.$inferSelect;

export interface ApprovalActorRef {
  kind: string;
  id: string;
  label: string;
}

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (depth === 0 && HASH_EXCLUDED_KEYS.has(key)) continue;
      out[key] = canonicalize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Stable JSON of the arguments: sorted keys, no reserved keys, no undefined. */
export function canonicalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(args ?? {}));
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalizeArgs(args)).digest("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Flip pending/approved rows past their TTL to "expired". */
export function expireStaleApprovals(): void {
  try {
    db.update(schema.approvals)
      .set({ status: "expired" })
      .where(and(inArray(schema.approvals.status, ["pending", "approved"]), lte(schema.approvals.expiresAt, nowIso())))
      .run();
  } catch {
    // best-effort
  }
}

/**
 * Create a pending approval, or return the live one already open for the
 * exact same actor + tool + args (retries must not spam the owner).
 */
export function requestApproval(params: {
  actor: ApprovalActorRef;
  source: string;
  tool: string;
  argsHash: string;
  argsPreview: string;
  summary: string;
}): { approval: ApprovalRow; created: boolean } {
  expireStaleApprovals();
  const now = nowIso();

  const existing = db
    .select()
    .from(schema.approvals)
    .where(
      and(
        eq(schema.approvals.actorKind, params.actor.kind),
        eq(schema.approvals.actorId, params.actor.id),
        eq(schema.approvals.tool, params.tool),
        eq(schema.approvals.argsHash, params.argsHash),
        inArray(schema.approvals.status, ["pending", "approved"]),
        gt(schema.approvals.expiresAt, now),
      ),
    )
    .orderBy(desc(schema.approvals.createdAt))
    .get();
  if (existing) return { approval: existing, created: false };

  const row: ApprovalRow = {
    id: `apr_${randomUUID().replace(/-/g, "")}`,
    actorKind: params.actor.kind,
    actorId: params.actor.id,
    actorLabel: params.actor.label,
    source: params.source,
    tool: params.tool,
    argsHash: params.argsHash,
    argsPreview: params.argsPreview,
    summary: params.summary,
    status: "pending",
    createdAt: now,
    expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
  };
  db.insert(schema.approvals).values(row).run();
  return { approval: row, created: true };
}

export type ConsumeFailure =
  | "not_found"
  | "actor_mismatch"
  | "tool_mismatch"
  | "args_mismatch"
  | "pending"
  | "denied"
  | "consumed"
  | "expired";

export type ConsumeResult = { ok: true; approval: ApprovalRow } | { ok: false; reason: ConsumeFailure };

/**
 * Atomically consume an approved approval for this exact actor/tool/args.
 * Succeeds at most once per approval id.
 */
export function consumeApproval(params: {
  approvalId: string;
  actor: ApprovalActorRef;
  tool: string;
  argsHash: string;
}): ConsumeResult {
  const now = nowIso();
  const result = db
    .update(schema.approvals)
    .set({ status: "consumed", consumedAt: now })
    .where(
      and(
        eq(schema.approvals.id, params.approvalId),
        eq(schema.approvals.status, "approved"),
        gt(schema.approvals.expiresAt, now),
        eq(schema.approvals.actorKind, params.actor.kind),
        eq(schema.approvals.actorId, params.actor.id),
        eq(schema.approvals.tool, params.tool),
        eq(schema.approvals.argsHash, params.argsHash),
      ),
    )
    .run();

  const row = db.select().from(schema.approvals).where(eq(schema.approvals.id, params.approvalId)).get();
  if (result.changes === 1 && row) return { ok: true, approval: row };

  // Explain the failure precisely (after the fact — the UPDATE was the gate).
  if (!row) return { ok: false, reason: "not_found" };
  if (row.actorKind !== params.actor.kind || row.actorId !== params.actor.id) return { ok: false, reason: "actor_mismatch" };
  if (row.tool !== params.tool) return { ok: false, reason: "tool_mismatch" };
  if (row.argsHash !== params.argsHash) return { ok: false, reason: "args_mismatch" };
  if (row.status === "consumed") return { ok: false, reason: "consumed" };
  if (row.status === "denied") return { ok: false, reason: "denied" };
  if (row.status === "expired" || row.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: false, reason: "pending" };
}

export function getApproval(id: string): ApprovalRow | undefined {
  return db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
}

export function listApprovals(options: { status?: ApprovalStatus; limit?: number } = {}): ApprovalRow[] {
  expireStaleApprovals();
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const query = db.select().from(schema.approvals);
  const filtered = options.status ? query.where(eq(schema.approvals.status, options.status)) : query;
  return filtered.orderBy(desc(schema.approvals.createdAt)).limit(limit).all();
}

export type DecideResult =
  | { ok: true; approval: ApprovalRow }
  | { ok: false; reason: "not_found" | "not_pending" | "expired" };

/**
 * Approve or deny a pending approval. Only callable from an authenticated
 * admin session (see routes/approvals.ts). Approving restarts the TTL so the
 * agent has a full window to retry.
 */
export function decideApproval(id: string, decision: "approved" | "denied", decidedBy: string): DecideResult {
  expireStaleApprovals();
  const now = nowIso();
  const row = getApproval(id);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status === "expired") return { ok: false, reason: "expired" };
  if (row.status !== "pending") return { ok: false, reason: "not_pending" };

  const result = db
    .update(schema.approvals)
    .set({
      status: decision,
      decidedBy,
      decidedAt: now,
      ...(decision === "approved" ? { expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString() } : {}),
    })
    .where(and(eq(schema.approvals.id, id), eq(schema.approvals.status, "pending"), gt(schema.approvals.expiresAt, now)))
    .run();
  if (result.changes !== 1) return { ok: false, reason: "not_pending" };
  const updated = getApproval(id);
  return updated ? { ok: true, approval: updated } : { ok: false, reason: "not_found" };
}
