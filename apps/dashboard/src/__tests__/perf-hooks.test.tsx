import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import {
  getServiceStacksKey,
  useServiceStacks,
  SERVICE_STACKS_KEY,
} from "@/hooks/use-service-stacks";
import {
  CONTAINER_LOOKUP_SWR_OPTIONS,
  CONTAINERS_KEY,
  useContainerLookup,
} from "@/hooks/use-containers";
import {
  getNotificationSWROptions,
  notificationListSignature,
  NOTIFICATIONS_POLL_MS,
  type AppNotification,
} from "@/hooks/use-notifications";
import { adaptiveDownloadsInterval, isDownloadsDataActive } from "@/hooks/use-downloads";
import { hasTransitionalInstall, isTransitionalInstallStatus, POLL_IDLE_MS } from "@/lib/polling";
import type { DownloadsData } from "@talome/types";

// Fresh SWR cache per test so requests are observable.
function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify([]), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map((c) => String(c[0]));
}

describe("useServiceStacks enabled flag", () => {
  it("uses a null SWR key when disabled", () => {
    expect(getServiceStacksKey(false)).toBeNull();
    expect(getServiceStacksKey(true)).toBe(SERVICE_STACKS_KEY);
  });

  it("does not fetch while disabled and fetches once enabled", async () => {
    const { result, rerender } = renderHook(({ enabled }) => useServiceStacks({ enabled }), {
      wrapper,
      initialProps: { enabled: false },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.stacks).toEqual([]);

    rerender({ enabled: true });
    await waitFor(() => expect(requestedUrls()).toContain(SERVICE_STACKS_KEY));
  });

  it("keeps fetching by default for existing callers", async () => {
    renderHook(() => useServiceStacks(), { wrapper });
    await waitFor(() => expect(requestedUrls()).toContain(SERVICE_STACKS_KEY));
  });
});

describe("useContainerLookup", () => {
  it("never polls or refetches on focus", () => {
    expect(CONTAINER_LOOKUP_SWR_OPTIONS.refreshInterval).toBe(0);
    expect(CONTAINER_LOOKUP_SWR_OPTIONS.revalidateOnFocus).toBe(false);
    expect(CONTAINER_LOOKUP_SWR_OPTIONS.dedupingInterval).toBeGreaterThanOrEqual(30_000);
  });

  it("does not fetch when disabled", async () => {
    renderHook(() => useContainerLookup(false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dedupes many consumers into one request", async () => {
    function Many() {
      useContainerLookup();
      useContainerLookup();
      return useContainerLookup();
    }
    const { result } = renderHook(() => Many(), {
      wrapper: ({ children }) => (
        <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>
      ),
    });
    await waitFor(() => expect(requestedUrls()).toContain(CONTAINERS_KEY));
    expect(requestedUrls().filter((u) => u === CONTAINERS_KEY)).toHaveLength(1);
    expect(result.current.containers).toEqual([]);
  });
});

describe("notifications polling", () => {
  it("only the poller instance starts timers", () => {
    const passive = getNotificationSWROptions(false);
    expect(passive.list.refreshInterval).toBe(0);
    expect(passive.count.refreshInterval).toBe(0);
    expect(passive.mute.refreshInterval).toBe(0);

    const poller = getNotificationSWROptions(true);
    expect(poller.list.refreshInterval).toBe(NOTIFICATIONS_POLL_MS);
    // the count is refreshed on list changes, not on its own 15s poll
    expect(poller.count.refreshInterval).toBeGreaterThan(NOTIFICATIONS_POLL_MS);
    expect(poller.count.revalidateOnFocus).toBe(false);
  });

  it("list signature changes when a notification arrives or is read", () => {
    const base: AppNotification = {
      id: 1, type: "info", title: "t", body: "b", read: false, sourceId: null, createdAt: "",
    };
    const a = notificationListSignature([base]);
    expect(notificationListSignature([base])).toBe(a);
    expect(notificationListSignature([{ ...base, read: true }])).not.toBe(a);
    expect(notificationListSignature([{ ...base, id: 2 }, base])).not.toBe(a);
    expect(notificationListSignature(undefined)).toBe("");
  });
});

describe("adaptive helpers", () => {
  it("detects installs/updates in flight", () => {
    expect(hasTransitionalInstall(undefined)).toBe(false);
    expect(hasTransitionalInstall([{ installed: null }, { installed: { status: "running" } }])).toBe(false);
    expect(hasTransitionalInstall([{ installed: { status: "installing" } }])).toBe(true);
    expect(hasTransitionalInstall([{ installed: { status: "updating" } }])).toBe(true);
    expect(isTransitionalInstallStatus("stopped")).toBe(false);
    expect(isTransitionalInstallStatus("updating")).toBe(true);
  });

  it("polls downloads fast only while something downloads", () => {
    const interval = adaptiveDownloadsInterval(10_000);
    const idle = { torrents: [], queue: [] } as unknown as DownloadsData;
    const active = { torrents: [{ state: "downloading" }], queue: [] } as unknown as DownloadsData;
    expect(isDownloadsDataActive(undefined)).toBe(false);
    expect(isDownloadsDataActive(idle)).toBe(false);
    expect(isDownloadsDataActive(active)).toBe(true);
    expect(interval(idle)).toBe(POLL_IDLE_MS);
    expect(interval(active)).toBe(10_000);
  });
});
