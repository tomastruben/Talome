import { Hono, type Context } from "hono";
import { z } from "zod";
import { serverError } from "../middleware/request-logger.js";
import { decideApproval, getApproval, listApprovals, type ApprovalRow } from "../approval/approvals.js";
import { writeAuditEntry } from "../db/audit.js";

/**
 * Approval decisions for destructive agent actions (mounted at /api/approvals).
 *
 * Admin session only — MCP bearer tokens never reach this router (requireSession
 * rejects them), so an agent cannot approve its own request.
 */
export const approvals = new Hono();

approvals.use("*", async (c, next) => {
  const role = c.get("sessionRole" as never) as string | undefined;
  if (role !== "admin") return c.json({ error: "Forbidden — admin access required" }, 403);
  await next();
});

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "denied", "consumed", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

function serialize(row: ApprovalRow) {
  return {
    id: row.id,
    actor: { kind: row.actorKind, id: row.actorId, label: row.actorLabel },
    source: row.source,
    tool: row.tool,
    summary: row.summary,
    argsPreview: row.argsPreview,
    status: row.status,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    consumedAt: row.consumedAt,
  };
}

approvals.get("/", (c) => {
  try {
    const parsed = listQuerySchema.safeParse({ status: c.req.query("status"), limit: c.req.query("limit") });
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(listApprovals(parsed.data).map(serialize));
  } catch (err) {
    return serverError(c, err, { message: "Failed to list approvals" });
  }
});

approvals.get("/:id", (c) => {
  try {
    const row = getApproval(c.req.param("id"));
    if (!row) return c.json({ error: "Approval not found" }, 404);
    return c.json(serialize(row));
  } catch (err) {
    return serverError(c, err, { message: "Failed to load approval" });
  }
});

function decide(decision: "approved" | "denied") {
  return (c: Context) => {
    try {
      const id = c.req.param("id") ?? "";
      const decidedBy =
        (c.get("sessionUsername" as never) as string | undefined) ??
        (c.get("sessionUser" as never) as string | undefined) ??
        "admin";
      const result = decideApproval(id, decision, decidedBy);
      if (!result.ok) {
        const status = result.reason === "not_found" ? 404 : 409;
        const message =
          result.reason === "not_found"
            ? "Approval not found"
            : result.reason === "expired"
              ? "Approval has expired — ask the agent to request it again"
              : "Approval is no longer pending";
        return c.json({ ok: false, error: message, reason: result.reason }, status);
      }
      writeAuditEntry(
        `Approval ${decision}: ${result.approval.tool}`,
        "modify",
        `${result.approval.summary} (id ${result.approval.id})`,
        true,
        {
          actorKind: "user",
          actorId: (c.get("sessionUser" as never) as string | undefined) ?? decidedBy,
          actorLabel: decidedBy,
          source: "dashboard",
          toolName: result.approval.tool,
          outcome: "success",
        },
      );
      // An escalated agent-loop remediation runs its approved call now, not on a
      // next event that a persistent problem never produces.
      if (decision === "approved" && result.approval.actorKind === "agent_loop") {
        const approvalId = result.approval.id;
        void import("../agent-loop/remediation.js")
          .then(({ resumeApprovedRemediation }) => resumeApprovedRemediation(approvalId))
          .catch((err) => console.warn("[approvals] remediation resume failed:", err instanceof Error ? err.message : err));
      }
      return c.json({ ok: true, approval: serialize(result.approval) });
    } catch (err) {
      return serverError(c, err, { message: `Failed to ${decision === "approved" ? "approve" : "deny"} request` });
    }
  };
}

approvals.post("/:id/approve", decide("approved"));
approvals.post("/:id/deny", decide("denied"));
