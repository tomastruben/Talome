/**
 * W4 review fixes: pure logic behind the app detail primary slot, conflict
 * copy, the created-app delete dialog, the App Store empty state, Files'
 * "is this data for this folder" check and the Backups "Back up now" receipt.
 */
import { describe, it, expect } from "vitest";
import {
  describeOperationConflict,
  describeUpdateResponse,
  settledFailureFrom,
  type OperationRecord,
} from "@/lib/app-operations";
import { deleteCreatedAppCopy, emptyCatalogCopy } from "@/lib/app-store-copy";
import { listDataIsFor, samePath } from "@/components/files/file-helpers";
import {
  PENDING_BACKUP_MAX_MS,
  nextPendingBackupStep,
  operationEndedReceipt,
  type PendingBackup,
} from "@/app/dashboard/backups/_lib/pending-backup";
import type { AppBackupOverview, BackupSummary } from "@/app/dashboard/backups/_lib/types";

const NOW = Date.parse("2026-09-30T12:00:00.000Z");

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "op-1",
    appId: "jellyfin",
    kind: "install",
    actor: "user:abc",
    status: "failed",
    step: "pulling",
    progress: 40,
    detail: null,
    error: "boom",
    startedAt: "2026-09-30T11:50:00.000Z",
    updatedAt: "2026-09-30T11:51:00.000Z",
    finishedAt: "2026-09-30T11:51:00.000Z",
    ...overrides,
  };
}

describe("settledFailureFrom only pins lifecycle failures", () => {
  it("ignores a failed scheduled backup (regression: it hid Open)", () => {
    const backup = record({ id: "op-b", kind: "backup", actor: "system", startedAt: "2026-09-30T11:55:00.000Z" });
    const start = record({ id: "op-s", kind: "start", status: "succeeded", error: null, startedAt: "2026-09-30T10:00:00.000Z" });
    expect(settledFailureFrom(null, [backup, start])).toBeNull();
  });

  it("ignores restore and configure failures too, but keeps a rollback", () => {
    expect(settledFailureFrom(null, [record({ kind: "restore" })])).toBeNull();
    expect(settledFailureFrom(null, [record({ kind: "configure" })])).toBeNull();
    expect(settledFailureFrom(null, [record({ kind: "rollback" })])?.kind).toBe("rollback");
  });

  it("still finds the lifecycle failure under a newer background operation", () => {
    const update = record({ id: "op-u", kind: "update", status: "rolled_back" });
    const backup = record({ id: "op-b", kind: "backup", status: "succeeded", error: null, startedAt: "2026-09-30T11:58:00.000Z" });
    expect(settledFailureFrom(null, [backup, update])?.operationId).toBe("op-u");
  });

  it("can be asked for the background kinds instead (the quiet notice)", () => {
    const backup = record({ id: "op-b", kind: "backup" });
    expect(settledFailureFrom(null, [backup], new Set(), { kinds: new Set(["backup"]) })?.operationId).toBe("op-b");
  });

  it("ages out an old failure (regression: a week-old failure came back every session)", () => {
    const old = record({ updatedAt: "2026-09-20T11:51:00.000Z" });
    expect(settledFailureFrom(null, [old], new Set(), { maxAgeMs: 3 * 86_400_000, now: NOW })).toBeNull();
    expect(settledFailureFrom(null, [record()], new Set(), { maxAgeMs: 3 * 86_400_000, now: NOW })?.operationId).toBe("op-1");
  });
});

describe("conflict copy only promises progress where it is shown", () => {
  const running = { kind: "update" as const, actor: "assistant", startedAt: "2026-09-30T11:58:00.000Z" };

  it("says 'Try again when it finishes' by default (regression: Settings > Updates and the uninstall dialog)", () => {
    const copy = describeOperationConflict("Jellyfin", running, { now: NOW });
    expect(copy.description).toBe("Started 2 min ago by the assistant. Try again when it finishes.");
    expect(copy.description).not.toContain("shown here");
  });

  it("mentions the progress on the app page, which shows it", () => {
    expect(describeOperationConflict("Jellyfin", running, { progressShown: true, now: NOW }).description).toContain(
      "Its progress is shown here",
    );
  });

  it("the update toast (Settings > Updates) doesn't promise progress", () => {
    const outcome = describeUpdateResponse("Jellyfin", 409, { conflict: true, operationId: "x", running });
    expect(outcome.description).not.toContain("shown here");
  });
});

describe("delete created app copy matches what core does", () => {
  it("says an installed app is uninstalled, and that its files stay (regression: 'stays installed', 'with the files')", () => {
    const copy = deleteCreatedAppCopy("Notes", "notes", true);
    expect(copy.consequence).toContain("Notes is uninstalled (its containers stop and are removed)");
    expect(copy.consequence).toContain("removed from My Apps");
    expect(copy.recovery).toContain("source files stay in ~/.talome/user-apps/apps/notes");
    expect(`${copy.consequence} ${copy.recovery}`).not.toMatch(/stays installed|with the files/);
    expect(copy.receipt).toBe("Uninstalled and deleted Notes");
  });

  it("doesn't mention uninstalling an app that isn't installed", () => {
    const copy = deleteCreatedAppCopy("Notes", "notes", false);
    expect(copy.consequence).toBe("Notes is removed from My Apps.");
    expect(copy.recovery).toContain("source files stay");
    expect(copy.receipt).toBe("Deleted Notes");
  });
});

describe("App Store empty catalog copy", () => {
  it("only says 'No app sources yet' when the list of sources loaded empty (regression)", () => {
    expect(emptyCatalogCopy([]).title).toBe("No app sources yet");
    expect(emptyCatalogCopy([{ id: "talome" }]).title).toBe("No apps listed yet");
    const unknown = emptyCatalogCopy(undefined);
    expect(unknown.title).toBe("No apps listed yet");
    expect(unknown.action).toBe("Open app sources");
  });
});

describe("Files: is the data on screen for this folder?", () => {
  it("compares normalized paths (regression: trailing slash turned a failed refresh into a full error)", () => {
    expect(samePath("/root/docs/", "/root/docs")).toBe(true);
    expect(samePath("/root//docs", "/root/docs")).toBe(true);
    expect(samePath("/", "/")).toBe(true);
    expect(samePath("/root/docs", "/root/doc")).toBe(false);
    expect(listDataIsFor({ path: "/root/docs" }, "/root/docs/", false)).toBe(true);
  });

  it("trusts the cache for this exact request (a legacy path the server maps elsewhere)", () => {
    expect(listDataIsFor({ path: "/data/files" }, "/home/me/.talome/files", true)).toBe(true);
  });

  it("never passes the previous folder off as this one", () => {
    expect(listDataIsFor({ path: "/root" }, "/root/docs", false)).toBe(false);
    expect(listDataIsFor(undefined, "/root/docs", true)).toBe(false);
    expect(listDataIsFor({ path: "/root" }, null, false)).toBe(false);
  });
});

function summary(overrides: Partial<BackupSummary> = {}): BackupSummary {
  return {
    id: "b1",
    status: "completed",
    method: "stop",
    sizeBytes: 1024,
    startedAt: "2026-09-30T11:00:00.000Z",
    completedAt: "2026-09-30T11:01:00.000Z",
    verifyStatus: null,
    verifiedAt: null,
    purpose: "manual",
    hasManifest: true,
    error: null,
    ...overrides,
  };
}

function overview(overrides: Partial<AppBackupOverview> = {}): AppBackupOverview {
  return {
    appId: "sonarr",
    name: "Sonarr",
    icon: null,
    iconUrl: null,
    appStatus: "running",
    config: { method: "auto", excludePatterns: [], includeVolumes: null, healthUrl: null },
    effectiveMethod: null,
    databases: [],
    scheduled: false,
    backupCount: 1,
    lastBackup: summary(),
    lastSuccessfulBackup: summary(),
    operation: null,
    running: false,
    ...overrides,
  };
}

describe("Back up now settles on the operation too", () => {
  const pending: PendingBackup = { name: "Sonarr", previousBackupId: "b1", operationId: "op-9", startedAt: NOW };

  it("waits while the operation runs", () => {
    const running = overview({ operation: { kind: "backup", id: "op-9", stage: "archiving", startedAt: "x" } });
    expect(nextPendingBackupStep(pending, running, NOW + 1000).kind).toBe("wait");
  });

  it("settles on a new backup row", () => {
    const step = nextPendingBackupStep(pending, overview({ lastBackup: summary({ id: "b2", status: "failed", error: "disk full" }) }), NOW);
    expect(step).toEqual({ kind: "row", backup: expect.objectContaining({ id: "b2", status: "failed" }) });
  });

  it("asks the journal when the operation ended without a row (regression: no toast, 2.5s polling forever)", () => {
    expect(nextPendingBackupStep(pending, overview(), NOW + 3000)).toEqual({ kind: "check-operation", operationId: "op-9" });
    expect(
      operationEndedReceipt("Sonarr", { status: "failed", error: "Could not resolve the app's compose file", detail: null }),
    ).toEqual({ kind: "error", title: "Couldn't back up Sonarr", description: "Could not resolve the app's compose file" });
    expect(operationEndedReceipt("Sonarr", { status: "succeeded", error: null, detail: { error: "busy", code: "busy" } })?.kind).toBe(
      "error",
    );
    expect(operationEndedReceipt("Sonarr", { status: "running", error: null, detail: null })).toBeNull();
  });

  it("gives up after a cap instead of pinning fast polling", () => {
    const noOp = { ...pending, operationId: null };
    expect(nextPendingBackupStep(noOp, overview(), NOW + 5000).kind).toBe("wait");
    expect(nextPendingBackupStep(noOp, overview(), NOW + PENDING_BACKUP_MAX_MS + 1).kind).toBe("expire");
  });

  it("drops an app that left the overview", () => {
    expect(nextPendingBackupStep(pending, undefined, NOW).kind).toBe("drop");
  });
});
