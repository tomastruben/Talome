/**
 * Shared types and Zod schemas for Talome's app backup engine.
 *
 * Every backup is a directory under the backup root:
 *
 *   <root>/<appId>/<timestamp>-<shortId>/
 *     data.tar.gz      — volumes, database dumps and the compose snapshot
 *     manifest.json    — file list with sizes + sha256, method, images, …
 *
 * The manifest is also embedded in the archive (talome-backup/manifest.json,
 * without the archive checksum) so an archive copied on its own is still
 * self-describing.
 */

import { z } from "zod";

export const CONSISTENCY_METHODS = ["dump", "stop", "live"] as const;
export type ConsistencyMethod = (typeof CONSISTENCY_METHODS)[number];

export const CONFIGURED_METHODS = ["auto", ...CONSISTENCY_METHODS] as const;
export type ConfiguredMethod = (typeof CONFIGURED_METHODS)[number];

export const BACKUP_PURPOSES = ["manual", "schedule", "pre-update", "pre-restore"] as const;
export type BackupPurpose = (typeof BACKUP_PURPOSES)[number];

export type DbEngine = "postgres" | "mysql" | "redis";

export type VerifyStatus = "running" | "verified" | "failed";

export const MANIFEST_FORMAT_VERSION = 1;

/** Archive member prefixes */
export const ARCHIVE_VOLUMES_DIR = "volumes";
export const ARCHIVE_DUMPS_DIR = "dumps";
export const ARCHIVE_COMPOSE_DIR = "compose";
export const ARCHIVE_META_DIR = "talome-backup";
export const ARCHIVE_FILE_NAME = "data.tar.gz";
export const MANIFEST_FILE_NAME = "manifest.json";

// ── Manifest ────────────────────────────────────────────────────────────────

export const manifestFileSchema = z.object({
  /** Path inside the archive (POSIX, no leading slash) */
  path: z.string(),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.number().int().nonnegative().optional(),
});
export type ManifestFile = z.infer<typeof manifestFileSchema>;

export const manifestVolumeSchema = z.object({
  /** Archive key — members live under volumes/<key> */
  key: z.string(),
  hostPath: z.string(),
  /** Source as written in the compose file */
  raw: z.string(),
  target: z.string(),
  service: z.string(),
  kind: z.enum(["dir", "file"]),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
export type ManifestVolume = z.infer<typeof manifestVolumeSchema>;

export const manifestDumpSchema = z.object({
  service: z.string(),
  engine: z.enum(["postgres", "mysql", "redis"]),
  /** Archive path of the SQL dump; redis dumps live inside their data volume */
  path: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  /** Host paths of the raw database volumes left out because the dump replaces them */
  replacesVolumes: z.array(z.string()),
});
export type ManifestDump = z.infer<typeof manifestDumpSchema>;

export const manifestImageSchema = z.object({
  service: z.string(),
  container: z.string(),
  image: z.string(),
  imageId: z.string().nullable(),
  repoDigests: z.array(z.string()),
});
export type ManifestImage = z.infer<typeof manifestImageSchema>;

export const backupManifestSchema = z.object({
  formatVersion: z.literal(MANIFEST_FORMAT_VERSION),
  backupId: z.string(),
  appId: z.string(),
  appVersion: z.string().nullable(),
  storeSourceId: z.string().nullable(),
  talomeVersion: z.string(),
  createdAt: z.string(),
  completedAt: z.string(),
  method: z.enum(CONSISTENCY_METHODS),
  requestedMethod: z.enum(CONFIGURED_METHODS),
  purpose: z.enum(BACKUP_PURPOSES),
  compose: z
    .object({
      hostPath: z.string(),
      archivePath: z.string(),
      sha256: z.string(),
    })
    .nullable(),
  volumes: z.array(manifestVolumeSchema),
  skippedVolumes: z.array(z.object({ raw: z.string(), service: z.string(), reason: z.string() })),
  dumps: z.array(manifestDumpSchema),
  images: z.array(manifestImageSchema),
  excludePatterns: z.array(z.string()),
  files: z.array(manifestFileSchema),
  symlinks: z.array(z.object({ path: z.string(), target: z.string() })),
  /** Archive paths (volumes/<key>/<rel>) that were unreadable and are NOT in the archive */
  unreadable: z.array(z.string()).default([]),
  totals: z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
  warnings: z.array(z.string()),
  /** Present in the external manifest.json only */
  archive: z
    .object({
      file: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

// ── Per-app configuration ───────────────────────────────────────────────────

export const appBackupConfigSchema = z.object({
  method: z.enum(CONFIGURED_METHODS).default("auto"),
  excludePatterns: z.array(z.string().trim().min(1).max(512)).max(200).default([]),
  includeVolumes: z.array(z.string().min(1).max(4096)).max(100).nullable().default(null),
  healthUrl: z.string().url().max(2048).nullable().default(null),
});
export type AppBackupConfig = z.infer<typeof appBackupConfigSchema>;

export const appBackupConfigPatchSchema = z.object({
  method: z.enum(CONFIGURED_METHODS).optional(),
  excludePatterns: z.array(z.string().trim().min(1).max(512)).max(200).optional(),
  includeVolumes: z.array(z.string().min(1).max(4096)).max(100).nullable().optional(),
  healthUrl: z.string().url().max(2048).nullable().optional(),
});
export type AppBackupConfigPatch = z.infer<typeof appBackupConfigPatchSchema>;

// ── Retention ───────────────────────────────────────────────────────────────

export interface RetentionPolicy {
  keepLast?: number | null;
  keepDaily?: number | null;
  keepWeekly?: number | null;
  keepMonthly?: number | null;
  /** Used only when no keep* count is set */
  maxAgeDays?: number | null;
}

// ── Results ─────────────────────────────────────────────────────────────────

export type CreateAppBackupResult =
  | {
      success: true;
      backupId: string;
      appId: string;
      archivePath: string;
      manifestPath: string;
      sizeBytes: number;
      method: ConsistencyMethod;
      volumes: string[];
      fileCount: number;
      warnings: string[];
      destination: string | null;
      durationMs: number;
    }
  | { success: false; backupId?: string; appId: string; error: string };

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface VerifyBackupResult {
  success: boolean;
  backupId: string;
  status: "verified" | "failed";
  verifiedAt: string;
  checks: VerifyCheck[];
  errors: string[];
}

export type RestoreAppBackupResult =
  | {
      success: true;
      restoreId: string;
      backupId: string;
      appId: string;
      safetyBackupId: string | null;
      health: HealthReport;
      warnings: string[];
    }
  | {
      success: false;
      restoreId?: string;
      backupId: string;
      appId: string;
      error: string;
      rolledBack: boolean;
      safetyBackupId: string | null;
      health?: HealthReport;
    };

export interface HealthReport {
  healthy: boolean;
  containers: Array<{ name: string; status: string; health?: string | null }>;
  http?: { url: string; ok: boolean; status?: number; error?: string };
  detail: string;
}
