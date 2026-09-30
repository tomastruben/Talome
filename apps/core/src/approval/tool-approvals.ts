/**
 * Server-issued approvals for destructive tool calls.
 *
 * A model setting `confirmed: true` proves nothing about human consent. Instead,
 * when a non-interactive caller (MCP client, messaging, automation, background
 * loop) asks for a destructive tool in cautious mode, Talome records a pending
 * request bound to that caller, that tool and those exact arguments. A signed-in
 * admin approves it in the dashboard (or the chat owner replies with its code on
 * Telegram/Discord), and the next identical call from the same caller consumes it
 * — once, before it expires.
 */

import { createHash, randomInt, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { writeNotification } from "../db/notifications.js";
import { summarizeForAudit } from "../utils/redact.js";
import { actorKey, describeActor, type ExecutionActor } from "../ai/execution-actor.js";

/** How long a request waits for a decision */
export const PENDING_TTL_MS = 30 * 60 * 1000;
/** How long an approved request stays usable */
export const APPROVED_TTL_MS = 15 * 60 * 1000;

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type ToolApproval = typeof schema.toolApprovals.$inferSelect;
export type ApprovalStatus = ToolApproval["status"];
export type ApprovalResult = { ok: true; approval: ToolApproval } | { ok: false; error: string };

function newCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Digest of a call's arguments, independent of key order. `confirmed` is left out
 * because it no longer carries meaning — the approval record does.
 */
export function digestToolArgs(toolName: string, args: Record<string, unknown>): string {
  const { confirmed: _confirmed, ...rest } = args;
  return createHash("sha256").update(`${toolName}\n${JSON.stringify(canonicalize(rest))}`).digest("hex");
}

/** Mark requests whose window has passed as expired. */
export function expireStaleApprovals(now = new Date()): void {
  db.update(schema.toolApprovals)
    .set({ status: "expired" })
    .where(
      and(
        inArray(schema.toolApprovals.status, ["pending", "approved"]),
        lt(schema.toolApprovals.expiresAt, now.toISOString()),
      ),
    )
    .run();
}

/**
 * Consume an approved request matching this actor, tool and arguments.
 * Returns the approval id, or null when there is nothing to consume.
 */
export function consumeApproval(
  actor: ExecutionActor,
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  expireStaleApprovals();
  const digest = digestToolArgs(toolName, args);
  const candidate = db
    .select({ id: schema.toolApprovals.id })
    .from(schema.toolApprovals)
    .where(
      and(
        eq(schema.toolApprovals.actorKey, actorKey(actor)),
        eq(schema.toolApprovals.toolName, toolName),
        eq(schema.toolApprovals.argsDigest, digest),
        eq(schema.toolApprovals.status, "approved"),
      ),
    )
    .orderBy(schema.toolApprovals.decidedAt)
    .limit(1)
    .get();
  if (!candidate) return null;

  // Conditional update makes consumption single-use even under concurrent calls.
  const result = db
    .update(schema.toolApprovals)
    .set({ status: "used", usedAt: new Date().toISOString() })
    .where(and(eq(schema.toolApprovals.id, candidate.id), eq(schema.toolApprovals.status, "approved")))
    .run();
  return result.changes === 1 ? candidate.id : null;
}

/**
 * Record (or reuse) a pending request for this call and notify admins.
 * Repeating the same blocked call returns the existing request rather than piling up new ones.
 */
export function requestApproval(
  actor: ExecutionActor,
  toolName: string,
  tier: ToolApproval["tier"],
  args: Record<string, unknown>,
): ToolApproval {
  expireStaleApprovals();
  const key = actorKey(actor);
  const digest = digestToolArgs(toolName, args);

  const existing = db
    .select()
    .from(schema.toolApprovals)
    .where(
      and(
        eq(schema.toolApprovals.actorKey, key),
        eq(schema.toolApprovals.toolName, toolName),
        eq(schema.toolApprovals.argsDigest, digest),
        eq(schema.toolApprovals.status, "pending"),
      ),
    )
    .get();
  if (existing) return existing;

  const now = new Date();
  const approval: ToolApproval = {
    id: randomUUID(),
    code: newCode(),
    toolName,
    tier,
    actorKey: key,
    actorLabel: describeActor(actor),
    argsDigest: digest,
    argsPreview: summarizeForAudit(args, 500),
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS).toISOString(),
    decidedAt: null,
    decidedBy: null,
    usedAt: null,
  };
  db.insert(schema.toolApprovals).values(approval).run();

  writeNotification(
    "warning",
    `Approval needed: ${toolName}`,
    `${approval.actorLabel} wants to run ${toolName}. Review it in Settings > Security (code ${approval.code}).`,
    `approval:${approval.id}`,
  );
  return approval;
}

function decide(approval: ToolApproval | undefined, approve: boolean, decidedBy: string): ApprovalResult {
  if (!approval) return { ok: false, error: "Approval request not found" };
  if (approval.status !== "pending") return { ok: false, error: `Request is already ${approval.status}` };

  const now = new Date();
  const result = db
    .update(schema.toolApprovals)
    .set({
      status: approve ? "approved" : "denied",
      decidedAt: now.toISOString(),
      decidedBy,
      ...(approve ? { expiresAt: new Date(now.getTime() + APPROVED_TTL_MS).toISOString() } : {}),
    })
    .where(and(eq(schema.toolApprovals.id, approval.id), eq(schema.toolApprovals.status, "pending")))
    .run();
  if (result.changes !== 1) return { ok: false, error: "Request changed while deciding — refresh and retry" };

  const updated = db.select().from(schema.toolApprovals).where(eq(schema.toolApprovals.id, approval.id)).get();
  return updated ? { ok: true, approval: updated } : { ok: false, error: "Approval request not found" };
}

/** Approve or deny a request by id (dashboard). */
export function decideApproval(id: string, approve: boolean, decidedBy: string): ApprovalResult {
  expireStaleApprovals();
  const approval = db.select().from(schema.toolApprovals).where(eq(schema.toolApprovals.id, id)).get();
  return decide(approval, approve, decidedBy);
}

/**
 * Approve or deny by short code. Only matches requests raised by the same actor,
 * so a code from one chat cannot approve another caller's request.
 */
export function decideApprovalByCode(
  actor: ExecutionActor,
  code: string,
  approve: boolean,
  decidedBy: string,
): ApprovalResult {
  expireStaleApprovals();
  const approval = db
    .select()
    .from(schema.toolApprovals)
    .where(
      and(
        eq(schema.toolApprovals.actorKey, actorKey(actor)),
        eq(schema.toolApprovals.code, code.toUpperCase()),
        eq(schema.toolApprovals.status, "pending"),
      ),
    )
    .get();
  return decide(approval, approve, decidedBy);
}

/** Recent requests, newest first; pending ones first when listing everything. */
export function listApprovals(options: { status?: ApprovalStatus; limit?: number } = {}): ToolApproval[] {
  expireStaleApprovals();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const query = db.select().from(schema.toolApprovals);
  const filtered = options.status ? query.where(eq(schema.toolApprovals.status, options.status)) : query;
  return filtered
    .orderBy(sql`CASE WHEN ${schema.toolApprovals.status} = 'pending' THEN 0 ELSE 1 END`, desc(schema.toolApprovals.createdAt))
    .limit(limit)
    .all();
}
