import { Hono, type Context } from "hono";
import { z } from "zod";
import { decideApproval, listApprovals } from "../approval/tool-approvals.js";
import { writeAuditEntry } from "../db/audit.js";
import { serverError } from "../middleware/request-logger.js";
import { resumeAfterApproval } from "../automation/engine.js";

/**
 * Server-issued tool approvals. Admin-only (guarded in index.ts): approving here
 * is what lets a destructive call from MCP, messaging or an automation run.
 */
const approvals = new Hono();

const listQuerySchema = z.object({
  status: z.enum(["pending", "approved", "denied", "used", "expired"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

approvals.get("/", (c) => {
  try {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ ok: false, error: parsed.error.flatten() }, 400);
    return c.json(listApprovals(parsed.data));
  } catch (err) {
    return serverError(c, err, { message: "Failed to list approvals" });
  }
});

function decideRoute(approve: boolean) {
  return (c: Context) => {
    try {
      const id = c.req.param("id") ?? "";
      const username = (c.get("sessionUsername" as never) as string | undefined) ?? "admin";
      const result = decideApproval(id, approve, username);
      if (!result.ok) return c.json({ ok: false, error: result.error }, 409);

      const { approval } = result;
      writeAuditEntry(
        `${approve ? "APPROVED" : "DENIED"}: ${approval.toolName}`,
        approval.tier,
        `request ${approval.code} from ${approval.actorLabel} · decided by ${username}`,
        approve,
      );
      // Automation runs waiting on this request continue (or close) right away
      resumeAfterApproval();
      return c.json({ ok: true, approval });
    } catch (err) {
      return serverError(c, err, { message: "Failed to decide approval", context: { approvalId: c.req.param("id") } });
    }
  };
}

approvals.post("/:id/approve", decideRoute(true));
approvals.post("/:id/deny", decideRoute(false));

export { approvals };
