/**
 * Public API of Talome's app backup engine.
 *
 * Stable entry points (other subsystems may call these):
 *   createAppBackup(appId, opts?)      → CreateAppBackupResult
 *   verifyBackup(backupId, opts?)      → VerifyBackupResult
 *   restoreAppBackup(backupId, opts?)  → RestoreAppBackupResult
 *
 * None of them throw; they return Result-style objects.
 */

export { createAppBackup, deleteBackup, resolveMethod, type CreateAppBackupOptions } from "./engine.js";
export { verifyBackup, loadManifest } from "./verify.js";
export { restoreAppBackup, canStartRestore, type RestoreOptions } from "./restore.js";
export { getAppBackupConfig, setAppBackupConfig, getBackupRow, listAppBackups, listRestores, getRestoreRow } from "./store.js";
export { runScheduledBackup, runBackupMaintenance, applyScheduleRetention, type ScheduleRow } from "./scheduler.js";
export { getBackupProgress, cancelAppBackup, isAppBackupRunning, getAppOperation, listAppOperations, isContainerInBackupWindow } from "./state.js";
export { applyRetentionPolicy } from "./retention.js";
export * from "./types.js";
