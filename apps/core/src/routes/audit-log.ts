import { Hono } from "hono";
import { db, schema } from "../db/index.js";
import { desc, eq } from "drizzle-orm";

const auditLog = new Hono();

auditLog.get("/", (c) => {
  try {
    const entries = db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(100)
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
