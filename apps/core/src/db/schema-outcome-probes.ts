import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── Outcome verification results ────────────────────────────────────────────
// Last N semantic verification runs per app/stack ("verified working", not
// just "container running"). Created by db/migrations/outcome-probes.ts.

export const verificationResults = sqliteTable("verification_results", {
  id: text("id").primaryKey(),
  targetType: text("target_type", { enum: ["app", "stack"] }).notNull(),
  targetId: text("target_id").notNull(),
  status: text("status", { enum: ["verified", "degraded", "failed", "unknown"] }).notNull(),
  summary: text("summary").notNull().default(""),
  /** Full VerificationResult as JSON (checks, chain, evidence — secrets already redacted). */
  resultJson: text("result_json").notNull(),
  includeActive: integer("include_active", { mode: "boolean" }).notNull().default(false),
  durationMs: integer("duration_ms").notNull().default(0),
  verifiedAt: text("verified_at").notNull(),
});
