/**
 * Public API of Talome's app backup engine.
 *
 * Stable entry points (other subsystems may call these):
 *   createAppBackup(appId, opts?)      → CreateAppBackupResult
 *   verifyBackup(backupId, opts?)      → VerifyBackupResult
 *   restoreAppBackup(backupId, opts?)  → RestoreAppBackupResult
 *
 * None of them throw; they return Result-style objects.
 *
 * User-facing entry points (REST, assistant tools, schedules) go through the
 * journaled wrappers instead — runBackupOperation / runRestoreOperation — so a
 * backup or restore is an app operation that conflicts cleanly with a running
 * update/install. createAppBackup is called directly only from inside an
 * operation that already holds the app (the pre-update backup).
 */

export { createAppBackup, deleteBackup, resolveMethod, type CreateAppBackupOptions } from "./engine.js";
export { verifyBackup, loadManifest } from "./verify.js";
export { restoreAppBackup, canStartRestore, type RestoreOptions } from "./restore.js";
export { getAppBackupConfig, setAppBackupConfig, getBackupRow, listAppBackups, listRestores, getRestoreRow } from "./store.js";
export { runScheduledBackup, runBackupMaintenance, applyScheduleRetention, type ScheduleRow } from "./scheduler.js";
export {
  getBackupProgress,
  cancelAppBackup,
  isAppBackupRunning,
  getAppOperation,
  listAppOperations,
  isContainerInBackupWindow,
  isContainerInMaintenanceWindow,
  isAppInMaintenance,
  holdAppMaintenance,
} from "./state.js";
export { applyRetentionPolicy } from "./retention.js";
export { runBackupOperation, runRestoreOperation, backupBlockedReason } from "./operation.js";
export * from "./types.js";
