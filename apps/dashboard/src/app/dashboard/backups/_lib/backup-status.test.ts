import { describe, it, expect } from "vitest";
import {
  verificationState,
  parseExcludePatterns,
  needsAttention,
  defaultRestoreChoice,
  stageLabel,
  formatBytes,
} from "./backup-status";
import type { AppBackupOverview, BackupSummary } from "./types";

function backup(overrides: Partial<BackupSummary> = {}): BackupSummary {
  return {
    id: "b1",
    status: "completed",
    method: "stop",
    sizeBytes: 1024,
    startedAt: "2026-01-01T02:00:00.000Z",
    completedAt: "2026-01-01T02:01:00.000Z",
    verifyStatus: null,
    verifiedAt: null,
    purpose: "schedule",
    hasManifest: true,
    error: null,
    ...overrides,
  };
}

function app(overrides: Partial<AppBackupOverview> = {}): AppBackupOverview {
  return {
    appId: "sonarr",
    name: "Sonarr",
    icon: null,
    iconUrl: null,
    appStatus: "running",
    config: { method: "auto", excludePatterns: [], includeVolumes: null, healthUrl: null },
    effectiveMethod: "stop",
    databases: [],
    scheduled: true,
    backupCount: 1,
    lastBackup: backup(),
    lastSuccessfulBackup: backup(),
    operation: null,
    running: false,
    ...overrides,
  };
}

describe("backup status helpers", () => {
  it("maps verification states", () => {
    expect(verificationState(null)).toBe("none");
    expect(verificationState(backup())).toBe("unverified");
    expect(verificationState(backup({ verifyStatus: "verified" }))).toBe("verified");
    expect(verificationState(backup({ verifyStatus: "failed" }))).toBe("failed");
    expect(verificationState(backup({ verifyStatus: "running" }))).toBe("verifying");
    expect(verificationState(backup({ status: "failed" }))).toBe("none");
  });

  it("parses exclude patterns one per line", () => {
    expect(parseExcludePatterns("cache/\n\n  *.log  \n")).toEqual(["cache/", "*.log"]);
  });

  it("flags apps that need attention", () => {
    expect(needsAttention(app())).toBe(false);
    expect(needsAttention(app({ lastSuccessfulBackup: backup({ verifyStatus: "failed" }) }))).toBe(true);
    expect(needsAttention(app({ lastBackup: backup({ status: "failed", startedAt: "2026-02-01T00:00:00.000Z" }) }))).toBe(true);
    expect(needsAttention(app({ lastBackup: null, lastSuccessfulBackup: null }))).toBe(true);
    expect(needsAttention(app({ scheduled: false, lastBackup: null, lastSuccessfulBackup: null }))).toBe(false);
  });

  it("prefers the newest verified backup for restores and skips safety copies", () => {
    const list = [
      backup({ id: "safety", purpose: "pre-restore" }),
      backup({ id: "new" }),
      backup({ id: "verified", verifyStatus: "verified" }),
      backup({ id: "legacy", hasManifest: false }),
    ];
    expect(defaultRestoreChoice(list)?.id).toBe("verified");
    expect(defaultRestoreChoice([backup({ id: "only" })])?.id).toBe("only");
    expect(defaultRestoreChoice([])).toBeNull();
  });

  it("labels stages and sizes", () => {
    expect(stageLabel("loading-db")).toBe("Loading db database");
    expect(stageLabel("safety-backup")).toBe("Saving current data");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(null)).toBe("—");
  });
});
