import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

vi.mock("@/lib/constants", () => ({
  CORE_URL: "http://core",
  getDirectCoreUrl: () => "http://core-direct",
}));

import { useAppOperations } from "@/hooks/use-app-operations";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;
  private listeners = new Map<string, Set<(event: MessageEvent<string>) => void>>();

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials === true;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    const event = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

const fetchMock = vi.fn();

describe("useAppOperations", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/operations?limit=")) {
        return { ok: true, json: async () => [] };
      }
      if (url.endsWith("/api/operations/op-9")) {
        return {
          ok: true,
          json: async () => ({
            id: "op-9",
            appId: "jellyfin",
            kind: "install",
            actor: "assistant",
            status: "running",
            step: "pulling",
            progress: 30,
            detail: null,
            error: null,
            startedAt: "2026-09-29T10:00:00.000Z",
            updatedAt: "2026-09-29T10:00:10.000Z",
            finishedAt: null,
            steps: [],
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    setVisibility("visible");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setVisibility("visible");
  });

  it("streams operations for its app only and reports settled ones", async () => {
    const onSettled = vi.fn();
    const { result, unmount } = renderHook(() => useAppOperations("jellyfin", { onSettled }), { wrapper });

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];
    expect(source.url).toBe("http://core-direct/api/operations/stream?appId=jellyfin");
    expect(source.withCredentials).toBe(true);

    act(() => {
      source.emit("operation", {
        operationId: "op-1",
        appId: "sonarr",
        kind: "update",
        actor: "user",
        status: "running",
        step: "pull",
        progress: 10,
        at: "2026-09-29T10:00:00.000Z",
      });
    });
    expect(result.current.live).toBeNull();

    act(() => {
      source.emit("operation", {
        operationId: "op-2",
        appId: "jellyfin",
        kind: "update",
        actor: "user",
        status: "running",
        step: "pull",
        progress: 10,
        message: "Downloading new images (app keeps running)",
        at: "2026-09-29T10:00:00.000Z",
      });
    });
    expect(result.current.isActive).toBe(true);
    expect(result.current.live).toMatchObject({ operationId: "op-2", step: "pull", progress: 10 });

    act(() => {
      source.emit("operation", {
        operationId: "op-2",
        appId: "jellyfin",
        kind: "update",
        actor: "user",
        status: "succeeded",
        step: "done",
        progress: 100,
        at: "2026-09-29T10:01:00.000Z",
      });
    });
    expect(result.current.isActive).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0][0]).toMatchObject({ operationId: "op-2", status: "succeeded" });

    unmount();
    expect(source.closed).toBe(true);
  });

  it("closes the stream while the tab is hidden and reopens it when visible", () => {
    renderHook(() => useAppOperations("jellyfin"), { wrapper });
    const first = FakeEventSource.instances[0];

    act(() => setVisibility("hidden"));
    expect(first.closed).toBe(true);

    act(() => setVisibility("visible"));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });

  it("recovers from a terminal event missed while the tab was hidden", async () => {
    let historyRows: unknown[] = [];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/operations?limit=")) return { ok: true, json: async () => historyRows };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const onSettled = vi.fn();
    const { result } = renderHook(() => useAppOperations("jellyfin", { onSettled }), { wrapper });
    const first = FakeEventSource.instances[0];

    act(() => {
      first.emit("operation", {
        operationId: "op-5",
        appId: "jellyfin",
        kind: "update",
        actor: "user",
        status: "running",
        step: "recreate",
        progress: 60,
        at: "2026-09-29T10:00:30.000Z",
      });
    });
    expect(result.current.isActive).toBe(true);

    // Hidden: the stream closes and the operation finishes meanwhile.
    act(() => setVisibility("hidden"));
    expect(first.closed).toBe(true);
    historyRows = [
      {
        id: "op-5",
        appId: "jellyfin",
        kind: "update",
        actor: "user",
        status: "succeeded",
        step: "done",
        progress: 100,
        detail: { outcome: "updated" },
        error: null,
        startedAt: "2026-09-29T10:00:00.000Z",
        updatedAt: "2026-09-29T10:01:00.000Z",
        finishedAt: "2026-09-29T10:01:00.000Z",
      },
    ];

    // Visible again: the reopened stream says "ready" and the journal is refetched.
    act(() => setVisibility("visible"));
    const second = FakeEventSource.instances[1];
    await act(async () => {
      second.emit("ready", {});
    });

    await waitFor(() => expect(result.current.isActive).toBe(false));
    expect(result.current.live).toMatchObject({ operationId: "op-5", status: "succeeded", progress: 100 });
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(onSettled.mock.calls[0][0]).toMatchObject({ operationId: "op-5", status: "succeeded" });

    // A late duplicate terminal event is not reported twice.
    act(() => {
      second.emit("operation", {
        operationId: "op-5",
        appId: "jellyfin",
        kind: "update",
        actor: "user",
        status: "succeeded",
        step: "done",
        progress: 100,
        at: "2026-09-29T10:01:00.000Z",
      });
    });
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("settles an adopted operation from the journal when the stream never reports it", async () => {
    let finished = false;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/operations?limit=")) {
        return {
          ok: true,
          json: async () =>
            finished
              ? [{
                  id: "op-9", appId: "jellyfin", kind: "install", actor: "assistant", status: "failed",
                  step: "pulling", progress: 30, detail: null, error: "pull failed",
                  startedAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:40.000Z",
                  finishedAt: "2026-09-29T10:00:40.000Z",
                }]
              : [],
        };
      }
      if (url.endsWith("/api/operations/op-9")) {
        return {
          ok: true,
          json: async () => ({
            id: "op-9", appId: "jellyfin", kind: "install", actor: "assistant", status: "running",
            step: "pulling", progress: 30, detail: null, error: null,
            startedAt: "2026-09-29T10:00:00.000Z", updatedAt: "2026-09-29T10:00:10.000Z", finishedAt: null,
          }),
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });
    const { result } = renderHook(() => useAppOperations("jellyfin"), { wrapper });
    await act(async () => {
      await result.current.adopt("op-9");
    });
    await waitFor(() => expect(result.current.isActive).toBe(true));

    finished = true;
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.isActive).toBe(false));
    expect(result.current.live).toMatchObject({ operationId: "op-9", status: "failed", error: "pull failed" });
  });

  it("opens nothing when disabled", () => {
    renderHook(() => useAppOperations("jellyfin", { enabled: false }), { wrapper });
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("adopts the running operation named by a 409 conflict", async () => {
    const { result } = renderHook(() => useAppOperations("jellyfin"), { wrapper });
    let adopted: Awaited<ReturnType<typeof result.current.adopt>> = null;
    await act(async () => {
      adopted = await result.current.adopt("op-9");
    });
    expect(adopted).toMatchObject({ id: "op-9", kind: "install" });
    await waitFor(() => expect(result.current.live).toMatchObject({ operationId: "op-9", step: "pulling", progress: 30 }));
    expect(result.current.live?.startedAt).toBe("2026-09-29T10:00:00.000Z");
    expect(result.current.isActive).toBe(true);
  });
});
