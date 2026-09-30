import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const health = vi.hoisted(() => ({
  /** When true, useIsOnline returns `value`; the hook's own tests turn it off. */
  mocked: false,
  value: { status: "online", checks: {}, since: null, recheck: vi.fn() } as {
    status: "online" | "offline" | "degraded";
    checks: Record<string, "ok" | "error">;
    since: string | null;
    recheck: () => void;
  },
}));
const viewer = vi.hoisted(() => ({ isAdmin: true, chat: true }));

vi.mock("@/hooks/use-user", () => ({
  useUser: () => ({
    isAdmin: viewer.isAdmin,
    hasPermission: (feature: string) => (feature === "chat" ? viewer.chat : true),
  }),
}));

vi.mock("@/hooks/use-is-online", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-is-online")>();
  return { ...actual, useIsOnline: () => (health.mocked ? health.value : actual.useIsOnline()) };
});

import { SystemHealthBanner, HEALTH_STATUS_HREF } from "@/components/system-health-banner";
import { planNotificationToasts, type ToastBridgeState } from "@/components/notifications/notification-toast-bridge";
import { NotificationRow, notificationTimeAgo } from "@/components/notifications/notification-row";
import { failingChecksLabel, parseDegradedBody, useIsOnline } from "@/hooks/use-is-online";
import { OPEN_PALETTE_EVENT, paletteRequestFromEvent } from "@/lib/palette";

type N = { id: number; read: boolean; type: "info" | "warning" | "critical" };
const fresh = (): ToastBridgeState => ({ initialized: false, seenIds: new Set() });

describe("notification toast bridge seeding (P0-14)", () => {
  it("toasts the first notification that arrives after an empty first load (regression)", () => {
    const state = fresh();
    expect(planNotificationToasts<N>(state, [], true)).toEqual([]);
    const critical: N = { id: 7, read: false, type: "critical" };
    // Before the fix an empty first load never seeded, so this arrival was
    // treated as "already there" and swallowed.
    expect(planNotificationToasts(state, [critical], true)).toEqual([critical]);
  });

  it("never toasts what existed at the first successful load", () => {
    const state = fresh();
    const old: N = { id: 1, read: false, type: "critical" };
    expect(planNotificationToasts(state, [old], true)).toEqual([]);
    expect(planNotificationToasts(state, [old], true)).toEqual([]);
  });

  it("waits for a successful load, skips read arrivals, and toasts each arrival once", () => {
    const state = fresh();
    expect(planNotificationToasts<N>(state, [], false)).toEqual([]);
    expect(state.initialized).toBe(false);
    planNotificationToasts<N>(state, [], true);
    const read: N = { id: 2, read: true, type: "warning" };
    const unread: N = { id: 3, read: false, type: "warning" };
    expect(planNotificationToasts(state, [read, unread], true)).toEqual([unread]);
    expect(planNotificationToasts(state, [read, unread], true)).toEqual([]);
  });
});

describe("notification rows", () => {
  it("keeps Dismiss a sibling of the row button, never nested inside it", () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(
      <NotificationRow
        notification={{ id: 1, type: "critical", title: "Backup failed", body: "Disk full", read: false, createdAt: new Date().toISOString() }}
        onOpen={onOpen}
        onDismiss={onDismiss}
      />,
    );
    const dismiss = screen.getByRole("button", { name: "Dismiss Backup failed" });
    const row = screen.getByRole("button", { name: /Critical:\s*Backup failed/ });
    expect(row.contains(dismiss)).toBe(false);
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("says Never for an invalid date instead of NaN", () => {
    expect(notificationTimeAgo("not a date")).toBe("Never");
    expect(notificationTimeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 min ago");
  });
});

describe("health checks", () => {
  it("reads core's degraded 503 body with its failing checks", () => {
    expect(parseDegradedBody({ status: "degraded", checks: { db: "error", docker: "ok" }, uptime: 12 }))
      .toEqual({ checks: { db: "error", docker: "ok" }, uptime: 12 });
    expect(parseDegradedBody({ error: "Bad gateway" })).toBeNull();
    expect(parseDegradedBody(null)).toBeNull();
    expect(failingChecksLabel({ db: "error", docker: "error" })).toBe("the database and Docker");
    expect(failingChecksLabel({ docker: "ok" })).toBeNull();
  });

  describe("useIsOnline", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("treats a degraded 503 from core as degraded with named checks, never offline (regression)", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(
        JSON.stringify({ status: "degraded", checks: { db: "error", docker: "ok" }, uptime: 5 }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      )));
      const { result } = renderHook(() => useIsOnline());
      // Well past the 5 failures that used to flip a reachable core to "offline".
      for (let i = 0; i < 8; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      }
      expect(result.current.status).toBe("degraded");
      expect(result.current.checks).toEqual({ db: "error", docker: "ok" });
      expect(result.current.since).not.toBeNull();
    });

    it("still goes offline when the server doesn't answer at all", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
      const { result } = renderHook(() => useIsOnline());
      for (let i = 0; i < 8; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      }
      expect(result.current.status).toBe("offline");
    });
  });
});

describe("system health banner (P0-15)", () => {
  beforeEach(() => {
    viewer.isAdmin = true;
    viewer.chat = true;
    health.value = { status: "online", checks: {}, since: null, recheck: vi.fn() };
  });

  async function renderBanner() {
    health.mocked = true;
    render(<SystemHealthBanner />);
    return { HEALTH_STATUS_HREF };
  }

  afterEach(() => { health.mocked = false; });

  it("names the failing check and offers Diagnose with Talome and View status", async () => {
    health.value = { status: "degraded", checks: { docker: "error", db: "ok" }, since: null, recheck: vi.fn() };
    const { HEALTH_STATUS_HREF } = await renderBanner();
    expect(screen.getByText("Docker isn't responding")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View status" })).toHaveAttribute("href", HEALTH_STATUS_HREF);

    const requests: unknown[] = [];
    const listener = (event: Event) => requests.push(paletteRequestFromEvent(event));
    document.addEventListener(OPEN_PALETTE_EVENT, listener);
    fireEvent.click(screen.getByRole("button", { name: "Diagnose with Talome" }));
    document.removeEventListener(OPEN_PALETTE_EVENT, listener);
    expect(requests).toEqual([{ mode: "chat", prefill: expect.stringContaining("Docker isn't responding") }]);
  });

  it("offers Retry while offline, and no Assistant (it runs on the unreachable server)", async () => {
    const recheck = vi.fn();
    health.value = { status: "offline", checks: {}, since: null, recheck };
    await renderBanner();
    expect(screen.getByText(/Talome can't reach its server/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Diagnose with Talome" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(recheck).toHaveBeenCalledOnce();
  });

  it("hides View status from members and Diagnose from people without the Assistant", async () => {
    viewer.isAdmin = false;
    viewer.chat = false;
    health.value = { status: "degraded", checks: {}, since: null, recheck: vi.fn() };
    await renderBanner();
    expect(screen.getByText("Talome is running with problems")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "View status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Diagnose with Talome" })).not.toBeInTheDocument();
  });
});
