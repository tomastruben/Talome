import type { AppBackupOverview, BackupSummary, ConfiguredMethod, ConsistencyMethod } from "./types";

export type VerificationState = "verified" | "failed" | "verifying" | "unverified" | "none";

export function verificationState(backup: BackupSummary | null | undefined): VerificationState {
  if (!backup || backup.status !== "completed") return "none";
  if (backup.verifyStatus === "running") return "verifying";
  if (backup.verifyStatus === "verified") return "verified";
  if (backup.verifyStatus === "failed") return "failed";
  return "unverified";
}

export const VERIFICATION_LABELS: Record<VerificationState, string> = {
  verified: "Verified",
  failed: "Verification failed",
  verifying: "Verifying",
  unverified: "Not verified",
  none: "No backup",
};

export const METHOD_LABELS: Record<ConsistencyMethod, string> = {
  dump: "Database dump",
  stop: "Brief stop",
  live: "Live copy",
};

export const METHOD_OPTIONS: Array<{ value: ConfiguredMethod; label: string; description: string }> = [
  {
    value: "auto",
    label: "Automatic",
    description: "Database dump when Talome recognises the app's database, otherwise a brief stop.",
  },
  {
    value: "dump",
    label: "Database dump",
    description: "Dumps Postgres, MariaDB/MySQL and Redis while the app keeps running.",
  },
  {
    value: "stop",
    label: "Brief stop",
    description: "Stops the app for the few seconds it takes to copy its files, then starts it again.",
  },
  {
    value: "live",
    label: "Live copy",
    description: "Copies files while the app runs. Databases may be caught mid-write — not recommended.",
  },
];

const STAGE_LABELS: Record<string, string> = {
  preparing: "Preparing",
  dumping: "Dumping databases",
  pausing: "Stopping app",
  archiving: "Archiving data",
  resuming: "Starting app",
  validating: "Checking archive",
  uploading: "Copying to destination",
  verifying: "Verifying backup",
  checking: "Checking backup",
  "safety-backup": "Saving current data",
  stopping: "Stopping app",
  extracting: "Unpacking backup",
  "restoring-files": "Restoring files",
  starting: "Starting app",
  "health-check": "Checking health",
  "rolling-back": "Rolling back",
};

export function stageLabel(stage: string | null | undefined): string {
  if (!stage) return "Working";
  if (stage.startsWith("loading-")) return `Loading ${stage.slice("loading-".length)} database`;
  return STAGE_LABELS[stage] ?? stage;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}

/** One pattern per line; blank lines and surrounding whitespace ignored. */
export function parseExcludePatterns(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function lastAttemptFailed(app: AppBackupOverview): boolean {
  const last = app.lastBackup;
  if (!last || last.status !== "failed") return false;
  const ok = app.lastSuccessfulBackup;
  return !ok || Date.parse(last.startedAt) > Date.parse(ok.completedAt ?? ok.startedAt);
}

/** Apps that need the user's attention, most urgent first. */
export function needsAttention(app: AppBackupOverview): boolean {
  if (verificationState(app.lastSuccessfulBackup) === "failed") return true;
  if (lastAttemptFailed(app)) return true;
  return app.scheduled && !app.lastSuccessfulBackup;
}

export function restorableBackups<T extends BackupSummary>(backups: T[]): T[] {
  return backups.filter((b) => b.status === "completed" && b.hasManifest);
}

/** Default backup to offer for a restore: newest verified, else newest. */
export function defaultRestoreChoice<T extends BackupSummary>(backups: T[]): T | null {
  const list = restorableBackups(backups).filter((b) => b.purpose !== "pre-restore");
  return list.find((b) => b.verifyStatus === "verified") ?? list[0] ?? null;
}

/** Parse "key=value" lines into rclone backend parameters. Returns an error for malformed lines. */
export function parseCredentials(text: string): { ok: true; credentials: Record<string, string> } | { ok: false; error: string } {
  const credentials: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    const key = eq > 0 ? line.slice(0, eq).trim() : "";
    if (!/^[a-z0-9_]{1,64}$/i.test(key)) return { ok: false, error: `Use key=value on each line (problem: "${line.slice(0, 40)}")` };
    credentials[key] = line.slice(eq + 1).trim();
  }
  return { ok: true, credentials };
}

/** Parse a keep-count field: blank = not set, otherwise a whole number 0–1000. */
export function parseKeepCount(value: string): number | null | undefined {
  const v = value.trim();
  if (v === "") return null;
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n <= 1000 ? n : undefined;
}

/** One-line summary of a schedule's retention policy. */
export function retentionSummary(s: {
  keep_last: number | null;
  keep_daily: number | null;
  keep_weekly: number | null;
  keep_monthly: number | null;
  retention_days: number;
}): string {
  const parts: string[] = [];
  if (s.keep_last) parts.push(`last ${s.keep_last}`);
  if (s.keep_daily) parts.push(`${s.keep_daily} daily`);
  if (s.keep_weekly) parts.push(`${s.keep_weekly} weekly`);
  if (s.keep_monthly) parts.push(`${s.keep_monthly} monthly`);
  return parts.length > 0 ? `Keep ${parts.join(", ")}` : `Keep ${s.retention_days} days`;
}
