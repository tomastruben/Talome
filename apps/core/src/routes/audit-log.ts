import { Hono, type Context } from "hono";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { and, desc, eq, type SQL } from "drizzle-orm";

const auditLog = new Hono();

// Entries include actor (actorKind/actorId/actorLabel), source, toolName,
// outcome and durationMs when written by the execution service (null on
// older rows). `details` holds a redacted, truncated args preview.
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  actorKind: z.string().max(32).optional(),
  actorId: z.string().max(128).optional(),
  source: z.string().max(32).optional(),
  outcome: z.enum(["success", "error", "blocked", "approval_required"]).optional(),
  tool: z.string().max(128).optional(),
});

type AuditRow = typeof schema.auditLog.$inferSelect;

function isAdminSession(c: Context): boolean {
  return (c.get("sessionRole" as never) as string | undefined) === "admin";
}

/**
 * Members keep the activity feed (what happened, when, outcome) but not the
 * forensic detail: args previews and which token/user acted are admin-only.
 * Same response shape; the withheld fields are blank/null.
 */
function forViewer(c: Context, rows: AuditRow[]): AuditRow[] {
  if (isAdminSession(c)) return rows;
  return rows.map((r) => ({ ...r, details: "", actorId: null, actorLabel: null }));
}

auditLog.get("/", (c) => {
  try {
    const parsed = listQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "Invalid audit-log query", issues: parsed.error.flatten() }, 400);
    const q = parsed.data;
    if (!isAdminSession(c) && (q.actorId || q.actorKind)) {
      return c.json({ error: "Forbidden — admin access required to filter by actor" }, 403);
    }
    const filters: SQL[] = [];
    if (q.actorKind) filters.push(eq(schema.auditLog.actorKind, q.actorKind));
    if (q.actorId) filters.push(eq(schema.auditLog.actorId, q.actorId));
    if (q.source) filters.push(eq(schema.auditLog.source, q.source));
    if (q.outcome) filters.push(eq(schema.auditLog.outcome, q.outcome));
    if (q.tool) filters.push(eq(schema.auditLog.toolName, q.tool));
    const entries = db
      .select()
      .from(schema.auditLog)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(schema.auditLog.id))
      .limit(q.limit ?? 100)
      .all();
    return c.json(forViewer(c, entries));
  } catch (err) {
    return c.json([], 200);
  }
});

auditLog.get("/recent", (c) => {
  try {
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 10, 1), 100);
    const entries = db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(limit)
      .all();
    return c.json(forViewer(c, entries));
  } catch (err) {
    return c.json([], 200);
  }
});

// Returns the AI-generated activity summary (stored by the hourly background job)
// Falls back to last 5 raw entries if no summary has been generated yet
auditLog.get("/summary", (c) => {
  try {
    const summary = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "activity_summary"))
      .get()?.value;
    const generatedAt = db
      .select()
      .from(schema.settings)
      .where(eq(schema.settings.key, "activity_summary_at"))
      .get()?.value;

    if (summary && generatedAt) {
      return c.json({ summary, generatedAt, source: "ai" });
    }

    // Fallback: return last 5 entries as plain text lines
    const entries = db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(5)
      .all();

    const admin = isAdminSession(c);
    const fallback = entries
      .map((e) => (admin ? `${e.action} ${e.details}` : e.action))
      .join("\n");

    return c.json({ summary: fallback, generatedAt: null, source: "raw" });
  } catch {
    return c.json({ summary: null, generatedAt: null, source: "error" });
  }
});

export { auditLog };
