/**
 * Persistence for verification results (verification_results table).
 * Best-effort: storage problems never break a verification run.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "../db/index.js";
import { createLogger } from "../utils/logger.js";
import { CHECK_STATUSES, VERIFICATION_STATUSES, type VerificationResult, type VerificationTargetType } from "./types.js";

const log = createLogger("verification");

/** How many runs to keep per target. */
export const HISTORY_LIMIT = 20;

const checkResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(CHECK_STATUSES),
  evidence: z.string(),
  durationMs: z.number(),
  remediation: z.string().optional(),
  critical: z.boolean(),
  active: z.boolean(),
  appId: z.string().optional(),
});

export const verificationResultSchema = z.object({
  targetType: z.enum(["app", "stack"]),
  targetId: z.string(),
  status: z.enum(VERIFICATION_STATUSES),
  summary: z.string(),
  checks: z.array(checkResultSchema),
  chain: z
    .array(z.object({ id: z.string(), label: z.string(), status: z.enum(CHECK_STATUSES), checkIds: z.array(z.string()) }))
    .optional(),
  includeActive: z.boolean(),
  durationMs: z.number(),
  verifiedAt: z.string(),
});

function parseRow(json: string): VerificationResult | null {
  try {
    const parsed = verificationResultSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveVerificationResult(result: VerificationResult): void {
  const t = schema.verificationResults;
  try {
    db.insert(t)
      .values({
        id: randomUUID(),
        targetType: result.targetType,
        targetId: result.targetId,
        status: result.status,
        summary: result.summary,
        resultJson: JSON.stringify(result),
        includeActive: result.includeActive,
        durationMs: result.durationMs,
        verifiedAt: result.verifiedAt,
      })
      .run();

    // Keep only the newest HISTORY_LIMIT rows for this target.
    const keep = db
      .select({ id: t.id })
      .from(t)
      .where(and(eq(t.targetType, result.targetType), eq(t.targetId, result.targetId)))
      .orderBy(desc(t.verifiedAt), desc(sql`rowid`))
      .limit(HISTORY_LIMIT)
      .all()
      .map((r) => r.id);
    if (keep.length >= HISTORY_LIMIT) {
      db.delete(t)
        .where(and(eq(t.targetType, result.targetType), eq(t.targetId, result.targetId), notInArray(t.id, keep)))
        .run();
    }
  } catch (err: unknown) {
    log.warn(`Could not persist verification result for ${result.targetType} ${result.targetId}`, err instanceof Error ? err.message : String(err));
  }
}

export function getVerificationHistory(targetType: VerificationTargetType, targetId: string, limit = 1): VerificationResult[] {
  const t = schema.verificationResults;
  try {
    const rows = db
      .select({ resultJson: t.resultJson })
      .from(t)
      .where(and(eq(t.targetType, targetType), eq(t.targetId, targetId)))
      .orderBy(desc(t.verifiedAt), desc(sql`rowid`))
      .limit(Math.max(1, Math.min(limit, HISTORY_LIMIT)))
      .all();
    return rows.map((r) => parseRow(r.resultJson)).filter((r): r is VerificationResult => r !== null);
  } catch {
    return [];
  }
}

export function getLatestVerificationResult(targetType: VerificationTargetType, targetId: string): VerificationResult | null {
  return getVerificationHistory(targetType, targetId, 1)[0] ?? null;
}
