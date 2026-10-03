import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppNotification } from "@/hooks/use-notifications";
import type { HealthState } from "@/hooks/use-is-online";

const UNCHECKED = new Date(0).toISOString();
const CHECKED = "2026-09-30T12:00:00.000Z";

const state = vi.hoisted(() => ({
  notifications: [] as AppNotification[],
  health: null as unknown as HealthState,
  stats: undefined as { uptime: number; hostname: string } | undefined,
}));

vi.mock("@/hooks/use-is-online", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/use-is-online")>();
  return { ...actual, useIsOnline: () => ({ ...state.health, recheck: vi.fn() }) };
});
vi.mock("@/hooks/use-system-stats", () => ({ useSystemStats: () => ({ stats: state.stats }) }));
vi.mock("@/hooks/use-user", () => ({ useUser: () => ({ user: { username: "owner" } }) }));
vi.mock("@/hooks/use-notifications", () => ({ useNotifications: () => ({ notifications: state.notifications }) }));

import { ClockWidget, clockFooterStatus } from "@/components/widgets/clock-widget";

function health(patch: Partial<HealthState>): HealthState {
  return { status: "online", checks: {}, uptime: 0, checkedAt: CHECKED, since: null, reachable: true, ...patch };
}

const UP_5H = 5 * 3600 + 12 * 60;

describe("clock widget footer health", () => {
  it("is green only once core's health check says the server is up", () => {
    expect(clockFooterStatus(health({}), UP_5H)).toEqual({ tone: "healthy", label: "Up 5h 12m" });
    // Stats loaded but no health answer yet: the uptime, without a health dot.
    expect(clockFooterStatus(health({ checkedAt: UNCHECKED }), UP_5H)).toEqual({ tone: null, label: "Up 5h 12m" });
    expect(clockFooterStatus(health({ checkedAt: UNCHECKED }), undefined)).toEqual({ tone: null, label: null });
  });

  it("names a degraded server in amber and an unreachable one in red", () => {
    expect(clockFooterStatus(health({ status: "degraded", checks: { docker: "error", db: "ok" } }), UP_5H))
      .toEqual({ tone: "warning", label: "Docker isn't responding" });
    expect(clockFooterStatus(health({ status: "degraded" }), UP_5H))
      .toEqual({ tone: "warning", label: "Talome's server reported a problem" });
    expect(clockFooterStatus(health({ status: "degraded", reachable: false }), UP_5H))
      .toEqual({ tone: "critical", label: "Talome can't reach its server" });
    expect(clockFooterStatus(health({ status: "offline", reachable: false }), UP_5H))
      .toEqual({ tone: "critical", label: "Talome can't reach its server" });
  });
});

describe("ClockWidget", () => {
  beforeEach(() => {
    state.stats = { uptime: UP_5H, hostname: "nas" };
    state.notifications = [];
  });

  it("opens the Assistant with a submitted incident question, rather than a palette draft", async () => {
    state.health = health({});
    state.notifications = [{ id: "incident", title: "Disk usage high", body: "Disk is at 90%", type: "warning", sourceId: "disk", createdAt: new Date().toISOString() } as AppNotification];
    render(<ClockWidget />);
    const link = await screen.findByRole("link", { name: "Ask Talome about recent alert: Disk usage high" });
    const url = new URL(link.getAttribute("href")!, "http://localhost");
    expect(url.pathname).toBe("/dashboard/assistant");
    expect(url.searchParams.get("prompt")).toContain("Disk usage high");
    expect(url.searchParams.get("prompt")).toContain("Ask before making changes");
    expect(url.searchParams.get("from")).toBe("/dashboard/desktop");
  });

  it("shows a green dot beside the uptime when core is healthy", () => {
    state.health = health({});
    const { container } = render(<ClockWidget />);
    expect(screen.getByText("Up 5h 12m")).toBeInTheDocument();
    expect(screen.getByText("nas")).toBeInTheDocument();
    expect(container.querySelector("[data-clock-health]")?.getAttribute("data-clock-health")).toBe("healthy");
  });

  it("never shows green while the server is unreachable, even with stats on screen", () => {
    state.health = health({ status: "offline", reachable: false });
    const { container } = render(<ClockWidget />);
    expect(screen.getByText("Talome can't reach its server")).toBeInTheDocument();
    expect(screen.queryByText("Up 5h 12m")).not.toBeInTheDocument();
    expect(container.querySelector("[data-clock-health]")?.getAttribute("data-clock-health")).toBe("critical");
  });

  it("shows no dot before the first health check", () => {
    state.health = health({ checkedAt: UNCHECKED });
    const { container } = render(<ClockWidget />);
    expect(screen.getByText("Up 5h 12m")).toBeInTheDocument();
    expect(container.querySelector("[data-clock-health]")).toBeNull();
  });
});
