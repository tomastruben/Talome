import { describe, it, expect, vi, afterEach } from "vitest";
import {
  describeOperationConflict,
  describeUpdateResponse,
  operationFailureCopy,
  operationFixPrompt,
  runningFromConflictBody,
  settledFailureFrom,
  type LiveOperation,
  type OperationRecord,
} from "@/lib/app-operations";
import { appOpenUrl } from "@/lib/app-open-url";
import { formatBytes, relativeTime } from "@/lib/format";
import { fetchJson, fetchErrorStatus, FetchJsonError } from "@/lib/fetch-json";
import {
  folderErrorCopy,
  isOverTextPreviewLimit,
  shouldHandleQuickLookKey,
  uniqueName,
} from "@/components/files/file-helpers";

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
    error: "pull access denied for jellyfin/jellyfin",
    startedAt: "2026-09-30T11:50:00.000Z",
    updatedAt: "2026-09-30T11:51:00.000Z",
    finishedAt: "2026-09-30T11:51:00.000Z",
    ...overrides,
  };
}

function live(overrides: Partial<LiveOperation> = {}): LiveOperation {
  return {
    operationId: "op-1",
    appId: "jellyfin",
    kind: "install",
    actor: "user:abc",
    status: "failed",
    step: "pulling",
    progress: 40,
    message: null,
    error: "pull access denied",
    startedAt: "2026-09-30T11:50:00.000Z",
    updatedAt: "2026-09-30T11:51:00.000Z",
    ...overrides,
  };
}

describe("conflict copy", () => {
  it("says what is running, who started it and when, without ids or ISO dates", () => {
    const copy = describeOperationConflict(
      "Jellyfin",
      { kind: "update", actor: "assistant", startedAt: "2026-09-30T11:58:00.000Z" },
      NOW,
    );
    expect(copy.title).toBe("Jellyfin is already updating");
    expect(copy.description).toContain("Started 2 min ago by the assistant");
    expect(copy.description).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("reads naturally for every kind (regression: 'a install', 'busy: removing')", () => {
    const at = "2026-09-30T11:59:30.000Z";
    expect(describeOperationConflict("Sonarr", { kind: "uninstall", actor: "user:1", startedAt: at }, NOW).title).toBe(
      "Sonarr is already being uninstalled",
    );
    expect(describeOperationConflict("Sonarr", { kind: "backup", actor: "scheduler", startedAt: at }, NOW).description).toContain(
      "just now by the update scheduler",
    );
    expect(describeOperationConflict("Sonarr", null).title).toBe("Sonarr is busy");
  });

  it("reads the running operation from a 409 body", () => {
    expect(runningFromConflictBody({ running: { kind: "install", actor: "mcp_token:1", startedAt: "x" } })).toEqual({
      kind: "install",
      actor: "mcp_token:1",
      startedAt: "x",
    });
    expect(runningFromConflictBody({ running: { kind: "dance" } })).toBeNull();
    expect(runningFromConflictBody(null)).toBeNull();
  });

  it("never passes the engine message through the update toast", () => {
    const body = {
      error: "Cannot update jellyfin: an install operation (3f1c9a2e-uuid) started by user:abc at 2026-09-30T11:58:00.000Z is still running",
      operationId: "3f1c9a2e-uuid",
      conflict: true,
      running: { kind: "install", actor: "user:abc", startedAt: "2026-09-30T11:58:00.000Z" },
    };
    const outcome = describeUpdateResponse("Jellyfin", 409, body);
    expect(outcome.kind).toBe("conflict");
    expect(outcome.title).toBe("Jellyfin is already installing");
    expect(`${outcome.title} ${outcome.description}`).not.toContain("3f1c9a2e");
    expect(outcome.description).not.toContain("2026-09-30T");
  });
});

describe("settledFailureFrom", () => {
  it("keeps the newest failed operation in the slot", () => {
    expect(settledFailureFrom(null, [record()])?.operationId).toBe("op-1");
  });

  it("keeps an interrupted or rolled-back operation too", () => {
    expect(settledFailureFrom(null, [record({ status: "interrupted" })])?.status).toBe("interrupted");
    expect(settledFailureFrom(null, [record({ kind: "update", status: "rolled_back" })])?.status).toBe("rolled_back");
  });

  it("clears once a newer operation succeeded", () => {
    const later = record({ id: "op-2", status: "succeeded", error: null, startedAt: "2026-09-30T11:55:00.000Z" });
    expect(settledFailureFrom(null, [later, record()])).toBeNull();
  });

  it("uses the streamed state, including a failure the journal hasn't caught up with", () => {
    const running = record({ id: "op-3", status: "running", error: null, startedAt: "2026-09-30T11:40:00.000Z" });
    const streamed = live({ operationId: "op-9", startedAt: "2026-09-30T11:58:00.000Z" });
    expect(settledFailureFrom(streamed, [running])?.operationId).toBe("op-9");
  });

  it("respects a dismissal", () => {
    expect(settledFailureFrom(null, [record()], new Set(["op-1"]))).toBeNull();
  });

  it("is null with no history", () => {
    expect(settledFailureFrom(null, undefined)).toBeNull();
  });
});

describe("failure copy and the Ask Talome prompt", () => {
  it("names the action and keeps the reason", () => {
    expect(operationFailureCopy(live(), "Jellyfin")).toEqual({
      tone: "critical",
      title: "Couldn't install Jellyfin",
      detail: "pull access denied",
    });
  });

  it("treats a rollback as a warning", () => {
    const copy = operationFailureCopy(live({ kind: "update", status: "rolled_back", error: null }), "Jellyfin");
    expect(copy.tone).toBe("warning");
    expect(copy.title).toContain("previous version");
  });

  it("falls back to the step when there is no error text", () => {
    expect(operationFailureCopy(live({ error: null }), "Jellyfin").detail).toBe('It stopped at "Downloading images".');
    expect(operationFailureCopy(live({ status: "interrupted", error: null }), "Jellyfin").title).toBe("Couldn't finish installing Jellyfin");
  });

  it("gives the Assistant the step and error", () => {
    const prompt = operationFixPrompt(live(), "Jellyfin");
    expect(prompt).toContain("Talome couldn't install Jellyfin");
    expect(prompt).toContain('"Downloading images" (40%)');
    expect(prompt).toContain("pull access denied");
  });
});

describe("appOpenUrl", () => {
  const loc = { hostname: "Talome.Local" };

  it("uses the detected web UI's scheme and path (regression: always http://)", () => {
    expect(appOpenUrl({ port: 8443, webUi: { port: 8443, protocol: "https", path: "/admin" } }, loc)).toBe(
      "https://talome.local:8443/admin",
    );
  });

  it("uses https for conventional TLS container ports", () => {
    expect(appOpenUrl({ port: 9443, containerPort: 9443 }, loc)).toBe("https://talome.local:9443");
  });

  it("stays on http for a plain port, whatever the dashboard uses", () => {
    expect(appOpenUrl({ port: 8096, containerPort: 8096 }, loc)).toBe("http://talome.local:8096");
  });

  it("ignores a web UI on another port and brackets IPv6 hosts", () => {
    expect(appOpenUrl({ port: 8096, webUi: { port: 9000, protocol: "https" } }, { hostname: "::1" })).toBe("http://[::1]:8096");
  });
});

describe("format", () => {
  it("never renders NaN for bytes", () => {
    expect(formatBytes(Number.NaN)).toBe("—");
    expect(formatBytes(-5)).toBe("—");
    expect(formatBytes(0.5)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  it('says "Never" for a missing or invalid time', () => {
    expect(relativeTime(null)).toBe("Never");
    expect(relativeTime("not a date")).toBe("Never");
  });
});

describe("fetchJson", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(status: number, body: unknown, json = true) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (!json) throw new SyntaxError("bad json");
          return body;
        },
      })),
    );
  }

  it("throws with the status and server message on a failed request (regression: skeleton forever)", async () => {
    stub(404, { error: "App not found" });
    const err = await fetchJson("/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetchJsonError);
    expect(fetchErrorStatus(err)).toBe(404);
    expect((err as Error).message).toBe("App not found");
  });

  it("throws on a JSON { error } even with a 200", async () => {
    stub(200, { error: "Access denied" });
    await expect(fetchJson("/x")).rejects.toThrow("Access denied");
  });

  it("throws on a body that isn't JSON", async () => {
    stub(200, null, false);
    await expect(fetchJson("/x")).rejects.toBeInstanceOf(FetchJsonError);
  });

  it("returns the body on success", async () => {
    stub(200, [1, 2]);
    await expect(fetchJson<number[]>("/x")).resolves.toEqual([1, 2]);
  });

  it("reports a network error as status null", () => {
    expect(fetchErrorStatus(new TypeError("Failed to fetch"))).toBeNull();
  });
});

describe("file helpers", () => {
  it("picks a free folder name (regression: New did nothing the second time)", () => {
    expect(uniqueName("New Folder", ["a", "b"])).toBe("New Folder");
    expect(uniqueName("New Folder", ["New Folder"])).toBe("New Folder 2");
    expect(uniqueName("New Folder", ["new folder", "New Folder 2"])).toBe("New Folder 3");
  });

  it("writes folder errors that name the folder and the fix", () => {
    expect(folderErrorCopy(403, "/mnt/media/Movies").title).toBe("Talome can't open Movies");
    expect(folderErrorCopy(404, "/mnt/media/Movies").title).toBe("Movies isn't there any more");
    expect(folderErrorCopy(null, null).title).toBe("Couldn't open this folder");
  });

  it("flags text over the 5MB preview limit", () => {
    expect(isOverTextPreviewLimit(5 * 1024 * 1024)).toBe(true);
    expect(isOverTextPreviewLimit(1024)).toBe(false);
    expect(isOverTextPreviewLimit(undefined)).toBe(false);
  });

  it("leaves arrow keys to whatever already handled them (regression: paging while seeking)", () => {
    const div = document.createElement("div");
    expect(shouldHandleQuickLookKey({ defaultPrevented: true, target: div })).toBe(false);
    expect(shouldHandleQuickLookKey({ defaultPrevented: false, target: div })).toBe(true);
    expect(shouldHandleQuickLookKey({ defaultPrevented: false, target: document.createElement("input") })).toBe(false);
  });
});
