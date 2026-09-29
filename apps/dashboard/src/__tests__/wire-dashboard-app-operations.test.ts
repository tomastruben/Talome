import { describe, expect, it } from "vitest";
import {
  activeOperationFromHistory,
  describeUpdateResponse,
  operationActorLabel,
  operationStepLabel,
  parseOperationConflict,
  parseOperationEvent,
  parseOperationHistory,
  pickLiveOperation,
  reduceOperationEvent,
  summarizeUpdateOperation,
  type OperationEvent,
  type OperationRecord,
} from "@/lib/app-operations";

function event(overrides: Partial<OperationEvent> = {}): OperationEvent {
  return {
    operationId: "op-1",
    appId: "jellyfin",
    kind: "update",
    actor: "user:u1",
    status: "running",
    step: "pull",
    progress: 10,
    at: "2026-09-29T10:00:00.000Z",
    ...overrides,
  };
}

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: "op-1",
    appId: "jellyfin",
    kind: "update",
    actor: "user:u1",
    status: "running",
    step: "pull",
    progress: 10,
    detail: null,
    error: null,
    startedAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:05.000Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("parseOperationEvent", () => {
  it("accepts a well-formed stream event and clamps progress", () => {
    const parsed = parseOperationEvent({ ...event(), progress: 140, message: "Downloading" });
    expect(parsed).toMatchObject({ operationId: "op-1", progress: 100, message: "Downloading" });
  });

  it("rejects unknown kinds/statuses and missing ids", () => {
    expect(parseOperationEvent({ ...event(), kind: "explode" })).toBeNull();
    expect(parseOperationEvent({ ...event(), status: "done" })).toBeNull();
    expect(parseOperationEvent({ ...event(), operationId: "" })).toBeNull();
    expect(parseOperationEvent("nope")).toBeNull();
  });
});

describe("reduceOperationEvent", () => {
  it("ignores events for other apps", () => {
    expect(reduceOperationEvent(null, event({ appId: "sonarr" }), "jellyfin")).toBeNull();
    const state = reduceOperationEvent(null, event(), "jellyfin");
    expect(reduceOperationEvent(state, event({ appId: "sonarr", progress: 90 }), "jellyfin")).toBe(state);
  });

  it("tracks step, progress and message of the same operation", () => {
    let state = reduceOperationEvent(null, event({ message: "Downloading new images" }), "jellyfin");
    expect(state).toMatchObject({ step: "pull", progress: 10, message: "Downloading new images" });

    state = reduceOperationEvent(state, event({ step: "recreate", progress: 55, at: "2026-09-29T10:01:00.000Z" }), "jellyfin");
    // A new step without a message clears the stale message.
    expect(state).toMatchObject({ step: "recreate", progress: 55, message: null, startedAt: "2026-09-29T10:00:00.000Z" });

    state = reduceOperationEvent(
      state,
      event({ status: "rolled_back", step: "rollback_verify", progress: 90, error: "Health check failed", at: "2026-09-29T10:02:00.000Z" }),
      "jellyfin",
    );
    expect(state).toMatchObject({ status: "rolled_back", error: "Health check failed" });
  });

  it("drops out-of-order events so a finished operation is not resurrected", () => {
    const done = reduceOperationEvent(
      null,
      event({ status: "succeeded", step: "done", progress: 100, at: "2026-09-29T10:05:00.000Z" }),
      "jellyfin",
    );
    const late = reduceOperationEvent(done, event({ status: "running", step: "verify", progress: 70, at: "2026-09-29T10:04:00.000Z" }), "jellyfin");
    expect(late).toBe(done);
  });

  it("a new operation replaces the previous one", () => {
    const first = reduceOperationEvent(null, event({ status: "succeeded", at: "2026-09-29T10:05:00.000Z" }), "jellyfin");
    const next = reduceOperationEvent(first, event({ operationId: "op-2", kind: "restart", step: "starting", progress: 0, at: "2026-09-29T11:00:00.000Z" }), "jellyfin");
    expect(next).toMatchObject({ operationId: "op-2", kind: "restart", status: "running" });
  });
});

describe("history reconciliation", () => {
  it("finds the active operation in history and drops malformed rows", () => {
    const history = parseOperationHistory([
      record({ id: "op-3", status: "running", startedAt: "2026-09-29T12:00:00.000Z" }),
      { bogus: true },
      record({ id: "op-2", status: "succeeded" }),
    ]);
    expect(history).toHaveLength(2);
    expect(activeOperationFromHistory(history)?.operationId).toBe("op-3");
    expect(activeOperationFromHistory([record({ status: "failed" })])).toBeNull();
  });

  it("prefers the fresher view of the same operation", () => {
    const streamed = reduceOperationEvent(null, event({ status: "succeeded", at: "2026-09-29T10:09:00.000Z" }), "jellyfin");
    const polled = activeOperationFromHistory([record({ updatedAt: "2026-09-29T10:03:00.000Z" })]);
    expect(pickLiveOperation(streamed, polled, "jellyfin")?.status).toBe("succeeded");
    expect(pickLiveOperation(null, polled, "jellyfin")?.status).toBe("running");
    expect(pickLiveOperation(streamed, null, "sonarr")).toBeNull();
  });
});

describe("summarizeUpdateOperation", () => {
  it("reports success with the new version", () => {
    const summary = summarizeUpdateOperation(
      record({ status: "succeeded", detail: { toVersion: "10.9.1", outcome: "updated" }, finishedAt: "2026-09-29T10:06:00.000Z" }),
    );
    expect(summary).toMatchObject({ tone: "healthy", title: "Updated to v10.9.1", at: "2026-09-29T10:06:00.000Z" });
  });

  it("reports a rollback with its reason", () => {
    const summary = summarizeUpdateOperation(record({ status: "rolled_back", error: "Web UI did not respond" }));
    expect(summary).toMatchObject({ tone: "warning", title: "Update rolled back", detail: "Web UI did not respond" });
  });

  it("reports failures, unverified updates and no-ops", () => {
    expect(summarizeUpdateOperation(record({ status: "failed", error: "pull failed" }))).toMatchObject({ tone: "critical", title: "Update failed", detail: "pull failed" });
    expect(summarizeUpdateOperation(record({ status: "succeeded", detail: { outcome: "unverified" } }))?.tone).toBe("warning");
    expect(summarizeUpdateOperation(record({ status: "succeeded", detail: { outcome: "no_change" } }))?.title).toBe("Already up to date");
    expect(summarizeUpdateOperation(record({ status: "running" }))?.inProgress).toBe(true);
    expect(summarizeUpdateOperation(null)).toBeNull();
  });
});

describe("lifecycle responses", () => {
  it("parses a 409 operation conflict", () => {
    const body = { error: "Cannot update jellyfin: a install operation (op-9) … is still running", operationId: "op-9", conflict: true };
    expect(parseOperationConflict(409, body)).toEqual({ operationId: "op-9", message: body.error });
    expect(parseOperationConflict(400, body)).toBeNull();
  });

  it("describes update outcomes", () => {
    expect(describeUpdateResponse("Jellyfin", 200, { ok: true, verified: true }).kind).toBe("success");
    expect(describeUpdateResponse("Jellyfin", 200, { ok: true, verified: false }).kind).toBe("warning");
    expect(describeUpdateResponse("Jellyfin", 400, { error: "health failed", rolledBack: true })).toMatchObject({
      kind: "warning",
      title: "Jellyfin update rolled back",
      description: "health failed",
    });
    expect(describeUpdateResponse("Jellyfin", 400, { error: "boom", rolledBack: false }).kind).toBe("error");
    expect(describeUpdateResponse("Jellyfin", 409, { error: "busy", conflict: true, operationId: "x" })).toMatchObject({
      kind: "conflict",
      operationId: "x",
    });
  });
});

describe("labels", () => {
  it("humanises steps and actors", () => {
    expect(operationStepLabel("rollback_verify")).toBe("Verifying the restored version");
    expect(operationStepLabel("some_new_step")).toBe("Some new step");
    expect(operationStepLabel(null)).toBe("Working");
    expect(operationActorLabel("automation:abc")).toBe("an automation");
    expect(operationActorLabel("user:1")).toBe("a user");
  });
});
