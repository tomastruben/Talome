import { Hono } from "hono";
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

auditLog.get("/", (c) => {
  try {
    const parsed = listQuerySchema.safeParse(c.req.query());
    const q = parsed.success ? parsed.data : {};
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
    return c.json(entries);
  } catch (err) {
    return c.json([], 200);
  }
});

auditLog.get("/recent", (c) => {
  try {
    const limit = Number(c.req.query("limit")) || 10;
    const entries = db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(limit)
      .all();
    return c.json(entries);
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

    const fallback = entries
      .map((e) => `${e.action} ${e.details}`)
      .join("\n");

    return c.json({ summary: fallback, generatedAt: null, source: "raw" });
  } catch {
    return c.json({ summary: null, generatedAt: null, source: "error" });
  }
});

export { auditLog };
