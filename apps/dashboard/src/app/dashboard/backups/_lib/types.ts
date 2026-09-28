export type ConsistencyMethod = "dump" | "stop" | "live";
export type ConfiguredMethod = "auto" | ConsistencyMethod;
export type VerifyStatus = "running" | "verified" | "failed" | null;

export interface BackupSummary {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  method: ConsistencyMethod | null;
  sizeBytes: number | null;
  startedAt: string;
  completedAt: string | null;
  verifyStatus: VerifyStatus;
  verifiedAt: string | null;
  purpose: "manual" | "schedule" | "pre-update" | "pre-restore" | null;
  hasManifest: boolean;
  error: string | null;
}

export interface AppBackupConfig {
  method: ConfiguredMethod;
  excludePatterns: string[];
  includeVolumes: string[] | null;
  healthUrl: string | null;
}

export interface AppOperation {
  kind: "backup" | "restore";
  id: string;
  stage: string;
  startedAt: string;
}

export interface AppBackupOverview {
  appId: string;
  name: string;
  icon: string | null;
  iconUrl: string | null;
  appStatus: string;
  config: AppBackupConfig;
  effectiveMethod: ConsistencyMethod | null;
  databases: Array<{ service: string; engine: "postgres" | "mysql" | "redis" }>;
  scheduled: boolean;
  backupCount: number;
  lastBackup: BackupSummary | null;
  lastSuccessfulBackup: BackupSummary | null;
  operation: AppOperation | null;
  running: boolean;
}

export interface AppBackupDetail {
  appId: string;
  config: AppBackupConfig;
  effectiveMethod: ConsistencyMethod | null;
  backups: Array<BackupSummary & { triggeredBy: string; warnings: string[]; cloudTarget: string | null }>;
  error: string | null;
}

export interface RestoreRun {
  id: string;
  backup_id: string;
  app_id: string;
  status: "running" | "completed" | "failed" | "rolled_back";
  stage: string | null;
  safety_backup_id: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  detail: { health?: { healthy: boolean; detail: string }; warnings?: string[] } | null;
}
