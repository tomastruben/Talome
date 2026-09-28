import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useEffect, useState, type ReactNode } from "react";
import { render, renderHook, act, waitFor } from "@testing-library/react";
import useSWR, { SWRConfig } from "swr";
import {
  installedAppsRefreshInterval,
  installedStateSignature,
  optimizationJobsActiveRefreshInterval,
  optimizationJobsRefreshInterval,
  POLL_ACTIVE_MS,
  POLL_FAST_MS,
  POLL_IDLE_MS,
} from "@/lib/polling";
import { NOTIFICATIONS_COUNT_SAFETY_MS, getNotificationSWROptions } from "@/hooks/use-notifications";
import { useWidgetLayout } from "@/hooks/use-widget-layout";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

describe("stable refreshInterval helpers", () => {
  it("optimizationJobsActiveRefreshInterval uses the active cadence only while jobs run", () => {
    expect(optimizationJobsActiveRefreshInterval({ jobs: [{ status: "running" }] })).toBe(POLL_ACTIVE_MS);
    expect(optimizationJobsActiveRefreshInterval({ jobs: [{ status: "completed" }] })).toBe(POLL_IDLE_MS);
    expect(optimizationJobsActiveRefreshInterval(undefined)).toBe(POLL_IDLE_MS);
    // SWR calls the plain helper with (data) only — defaults apply.
    expect(optimizationJobsRefreshInterval({ jobs: [{ status: "queued" }] })).toBe(POLL_FAST_MS);
  });

  it("installedAppsRefreshInterval is fast only while an install/update is in flight", () => {
    expect(installedAppsRefreshInterval([{ installed: { status: "installing" } }])).toBe(POLL_ACTIVE_MS);
    expect(installedAppsRefreshInterval([{ installed: { status: "running" } }])).toBe(POLL_IDLE_MS);
    expect(installedAppsRefreshInterval(undefined)).toBe(POLL_IDLE_MS);
  });
});

describe("SWR polling with a stable interval function", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => ({ jobs: [] }));
  });

  // Mirrors the media page: a sibling poll re-renders the component much more
  // often than the jobs poll interval. With an inline arrow function SWR
  // restarts the timer on every render and never polls; a stable function
  // keeps the timer running.
  const INTERVAL_MS = 80;
  const stableInterval = () => INTERVAL_MS;

  function Poller({ interval }: { interval: (data: unknown) => number }) {
    const [, setTick] = useState(0);
    useEffect(() => {
      const t = setInterval(() => setTick((n) => n + 1), 15);
      return () => clearInterval(t);
    }, []);
    useSWR("jobs", fetchMock, { refreshInterval: interval });
    return null;
  }

  it("keeps polling while the component re-renders faster than the interval", async () => {
    render(<Poller interval={stableInterval} />, { wrapper });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2_000 });
  });
});

describe("installedStateSignature", () => {
  it("is order independent and dedupes apps listed by several stores", () => {
    const a = installedStateSignature([
      { installed: { appId: "sonarr", status: "running" } },
      { installed: null },
      { installed: { appId: "jellyfin", status: "stopped" } },
      { installed: { appId: "sonarr", status: "running" } },
    ]);
    const b = installedStateSignature([
      { installed: { appId: "jellyfin", status: "stopped" } },
      { installed: { appId: "sonarr", status: "running" } },
    ]);
    expect(a).toBe(b);
    expect(a).toBe("jellyfin:stopped|sonarr:running");
  });

  it("changes on install, uninstall and start/stop", () => {
    const before = installedStateSignature([{ installed: { appId: "sonarr", status: "running" } }]);
    expect(installedStateSignature([])).not.toBe(before);
    expect(installedStateSignature([{ installed: { appId: "sonarr", status: "stopped" } }])).not.toBe(before);
    expect(
      installedStateSignature([
        { installed: { appId: "sonarr", status: "running" } },
        { installed: { appId: "radarr", status: "installing" } },
      ]),
    ).not.toBe(before);
  });

  it("can be restricted to ids present in the catalog", () => {
    const installed = [
      { installed: { appId: "sonarr", status: "running" } },
      { installed: { appId: "not-in-catalog", status: "running" } },
    ];
    expect(installedStateSignature(installed, new Set(["sonarr"]))).toBe("sonarr:running");
  });
});

describe("notifications unread-count safety poll", () => {
  it("refreshes the count at a moderate cadence from the poller instance", () => {
    expect(NOTIFICATIONS_COUNT_SAFETY_MS).toBeLessThanOrEqual(60_000);
    expect(getNotificationSWROptions(true).count.refreshInterval).toBe(NOTIFICATIONS_COUNT_SAFETY_MS);
  });
});

describe("widget layout same-tab broadcast", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is dispatched asynchronously (never inside a setLayout updater)", async () => {
    const listener = vi.fn();
    window.addEventListener("talome:widget-layout-change", listener);
    try {
      const { result } = renderHook(() => useWidgetLayout({ remoteSync: false }));
      const snapshot = result.current.layout;
      let calledSync = false;
      act(() => {
        result.current.restoreLayout(snapshot);
        calledSync = listener.mock.calls.length > 0;
      });
      expect(calledSync).toBe(false);
      await waitFor(() => expect(listener).toHaveBeenCalled());
    } finally {
      window.removeEventListener("talome:widget-layout-change", listener);
    }
  });
});
