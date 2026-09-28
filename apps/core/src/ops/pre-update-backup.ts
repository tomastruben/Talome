// ── Pre-update backup (best-effort) ───────────────────────────────────────────
//
// Uses the existing app backup tool (config volumes, live, recorded in the
// backups table) so the backup shows up in the Backups UI and can be restored
// with restore_app. Never throws: the result says whether a backup happened.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export interface PreUpdateBackupResult {
  attempted: boolean;
  success: boolean;
  backupFile?: string;
  sizeBytes?: number;
  error?: string;
  /** Why no backup was attempted */
  reason?: string;
}

const backupToolResultSchema = z.object({
  success: z.boolean(),
  backupFile: z.string().optional(),
  sizeBytes: z.number().optional(),
  error: z.string().optional(),
});

/**
 * Opt-in: only an explicit update policy with preBackup enables it (matches
 * GET /api/updates/policies/:appId, whose default is preBackup: false).
 * Pre-update archives are full config-volume tarballs with no retention yet,
 * so taking one on every (bulk) update by default could fill the disk that
 * also holds Talome's database.
 */
export function isPreUpdateBackupEnabled(appId: string): boolean {
  try {
    const policy = db
      .select({ preBackup: schema.appUpdatePolicies.preBackup })
      .from(schema.appUpdatePolicies)
      .where(eq(schema.appUpdatePolicies.appId, appId))
      .get();
    return policy?.preBackup ?? false;
  } catch {
    return false;
  }
}

export async function takePreUpdateBackup(appId: string): Promise<PreUpdateBackupResult> {
  let mod: typeof import("../ai/tools/backup-tools.js");
  try {
    mod = await import("../ai/tools/backup-tools.js");
  } catch (err) {
    return { attempted: false, success: false, reason: `Backup module unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const execute = mod.backupAppTool?.execute;
  if (!execute) return { attempted: false, success: false, reason: "Backup function not available" };

  try {
    const raw: unknown = await execute(
      { appId, stopFirst: false, label: "pre-update", triggeredBy: "manual" },
      { toolCallId: randomUUID(), messages: [], abortSignal: undefined as unknown as AbortSignal },
    );
    const parsed = backupToolResultSchema.safeParse(raw);
    if (!parsed.success) return { attempted: true, success: false, error: "Backup returned an unexpected result" };
    if (!parsed.data.success) return { attempted: true, success: false, error: parsed.data.error ?? "Backup failed" };
    return {
      attempted: true,
      success: true,
      ...(parsed.data.backupFile ? { backupFile: parsed.data.backupFile } : {}),
      ...(parsed.data.sizeBytes !== undefined ? { sizeBytes: parsed.data.sizeBytes } : {}),
    };
  } catch (err) {
    return { attempted: true, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
