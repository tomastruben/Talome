import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

// ── Per-app backup configuration ────────────────────────────────────────────
// Consistency method, exclude globs and volume selection for app backups.
// Rows are optional: an app without a row uses the defaults (method "auto",
// config volumes only, no excludes).

export const appBackupConfigs = sqliteTable("app_backup_configs", {
  appId: text("app_id").primaryKey(),
  /** "auto" resolves to "dump" for recognised databases, otherwise "stop" */
  method: text("method", { enum: ["auto", "dump", "stop", "live"] }).notNull().default("auto"),
  /** JSON string[] of glob patterns excluded from the archive */
  excludePatterns: text("exclude_patterns").notNull().default("[]"),
  /** JSON string[] of host paths to include; NULL = all config volumes */
  includeVolumes: text("include_volumes"),
  /** Optional HTTP URL probed after a restore to confirm the app is healthy */
  healthUrl: text("health_url"),
  updatedAt: text("updated_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Backup destinations ─────────────────────────────────────────────────────
// Where completed backups are copied to in addition to the local backup root.
// Credentials never live in this table: they are stored as an encrypted
// setting (`backup_destination_<id>_secret`) and handed to rclone through
// RCLONE_CONFIG_* environment variables.

export const backupDestinations = sqliteTable("backup_destinations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type", { enum: ["local", "rclone"] }).notNull(),
  /** Local directory, or rclone path ("remote:bucket/dir" or "bucket/dir" for managed remotes) */
  target: text("target").notNull(),
  /** rclone backend type for managed remotes (s3, b2, sftp, ...); NULL = use an existing remote */
  remoteType: text("remote_type"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
});

// ── Restore runs ────────────────────────────────────────────────────────────

export const backupRestores = sqliteTable("backup_restores", {
  id: text("id").primaryKey(),
  backupId: text("backup_id").notNull(),
  appId: text("app_id").notNull(),
  status: text("status", { enum: ["running", "completed", "failed", "rolled_back"] }).notNull(),
  stage: text("stage"),
  safetyBackupId: text("safety_backup_id"),
  startedAt: text("started_at").notNull().$defaultFn(() => new Date().toISOString()),
  completedAt: text("completed_at"),
  error: text("error"),
  /** JSON detail: health check results, warnings */
  detail: text("detail"),
});
