import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Container, ServiceStack } from "@talome/types";

const mocks = vi.hoisted(() => ({
  pending: [] as unknown[],
  decide: vi.fn(),
  mutate: vi.fn(),
  post: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

vi.mock("@/components/trust/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/trust/api")>()),
  usePendingApprovals: (enabled: boolean) => {
    const pending = enabled ? mocks.pending : [];
    return { pending, count: pending.length, mutate: mocks.mutate };
  },
  decideApproval: mocks.decide,
}));
vi.mock("@/hooks/use-talome-api", () => ({ talomePost: mocks.post }));
vi.mock("sonner", () => ({ toast: mocks.toast }));

import {
  bringDesktopWindowToFront,
  desktopCloseAction,
  desktopWindowMotionKeyframes,
  desktopWindowZIndex,
  frontmostDesktopWindow,
  normalizeDesktopWindowStack,
  DESKTOP_MINIMIZE_SCALE,
} from "@/lib/desktop-window-state";
import { DESKTOP_LAYER } from "@/lib/desktop-layers";
import {
  SERVICE_DOWN_GRACE_MS,
  advanceServiceWindowGates,
  desktopDockItemName,
  desktopServiceStartPath,
  desktopServiceStatusLookup,
  isServiceUnavailable,
  nextServiceWindowGate,
  showsServiceUnavailable,
  withActiveOperation,
} from "@/lib/desktop-service-state";
import { extractLaunchableApps } from "@/components/widgets/launcher-widget";
import { DesktopClock, msUntilNextMinute } from "@/components/desktop/desktop-clock";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DesktopServiceUnavailable } from "@/components/desktop/desktop-service-unavailable";
import {
  DesktopApprovalsButton,
  approvalDetailLine,
  approvalsWaitingLabel,
  splitApprovalSummary,
} from "@/components/desktop/desktop-approvals-button";
import { logOut } from "@/lib/session";
import { modeSaveFailureMessage, reportModeSave } from "@/lib/dashboard-mode-save";
import { launchpadMatchRank } from "@/components/desktop/desktop-launchpad";
import { OPEN_PALETTE_EVENT, paletteRequestFromEvent } from "@/lib/palette";

type W = { id: string; zIndex: number; minimized: boolean };

describe("window stacking (D-P0-4)", () => {
  it("keeps every window below the dock after 2,000 alternating focuses, in order (regression)", () => {
    let windows: W[] = [
      { id: "files", zIndex: 1, minimized: false },
      { id: "media", zIndex: 2, minimized: false },
      { id: "terminal", zIndex: 3, minimized: false },
    ];
    for (let i = 0; i < 2000; i++) windows = bringDesktopWindowToFront(windows, i % 2 ? "files" : "media");
    for (const w of windows) {
      expect(w.zIndex).toBeLessThanOrEqual(windows.length);
      expect(desktopWindowZIndex(w.zIndex)).toBeLessThan(DESKTOP_LAYER.dock);
      expect(desktopWindowZIndex(w.zIndex)).toBeLessThan(DESKTOP_LAYER.widgetEditScrim);
    }
    // The last focus (i = 1999) was Files.
    expect(frontmostDesktopWindow(windows)?.id).toBe("files");
    expect([...windows].sort((a, b) => a.zIndex - b.zIndex).map((w) => w.id)).toEqual(["terminal", "media", "files"]);
  });

  it("is a no-op for the frontmost window, so focus events don't churn state", () => {
    const windows: W[] = [{ id: "a", zIndex: 1, minimized: false }, { id: "b", zIndex: 2, minimized: false }];
    expect(bringDesktopWindowToFront(windows, "b")).toBe(windows);
    expect(bringDesktopWindowToFront(windows, "missing")).toBe(windows);
  });

  it("normalizes layouts persisted by the old counter (zIndex 5000) into ranks", () => {
    const stack = normalizeDesktopWindowStack<W>([
      { id: "a", zIndex: 5000, minimized: false },
      { id: "b", zIndex: 1200, minimized: false },
      { id: "c", zIndex: 4999, minimized: true },
    ]);
    expect(stack.map((w) => [w.id, w.zIndex])).toEqual([["a", 3], ["b", 1], ["c", 2]]);
    expect(frontmostDesktopWindow(stack)?.id).toBe("a");
    expect(frontmostDesktopWindow(stack, "a")?.id).toBe("b");
  });

  it("minimizes with a uniform scale toward the dock, and restores along the same path", () => {
    const minimize = desktopWindowMotionKeyframes({ x: 100, y: 400 }, "minimize");
    expect(minimize.transform.at(-1)).toContain(`scale3d(${DESKTOP_MINIMIZE_SCALE}, ${DESKTOP_MINIMIZE_SCALE}, 1)`);
    // Opacity is gone by 70% of the way.
    expect(minimize.opacity[minimize.times.indexOf(0.7)]).toBe(0);
  });
});

describe("closing a window that is still playing (D-P0-5)", () => {
  it("hides and announces instead of silently minimizing", () => {
    expect(desktopCloseAction("audiobooks", { windowId: "audiobooks", bookTitle: "Dune", isPlaying: true }))
      .toEqual({ kind: "hide", message: "Still playing Dune · window hidden" });
    expect(desktopCloseAction("files", { windowId: "audiobooks", bookTitle: "Dune", isPlaying: true })).toEqual({ kind: "close" });
    expect(desktopCloseAction("audiobooks", { windowId: "audiobooks", bookTitle: null, isPlaying: false })).toEqual({ kind: "close" });
  });

  it("really closes a window whose book is paused, instead of claiming it is still playing (regression)", () => {
    expect(desktopCloseAction("audiobooks", { windowId: "audiobooks", bookTitle: "Dune", isPlaying: false })).toEqual({ kind: "close" });
  });
});

describe("menu-bar clock (D-P0-7)", () => {
  afterEach(() => vi.useRealTimers());

  it("changes within a second of the minute rollover (regression: it ticked every 30s from mount)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 30, 12, 0, 59, 500));
    render(<TooltipProvider><DesktopClock /></TooltipProvider>);
    const before = screen.getByText(/12.00|00.00/);
    expect(before.tagName).toBe("TIME");
    act(() => { vi.advanceTimersByTime(600); });
    expect(screen.getByText(/12.01|00.01/)).toBeInTheDocument();
    expect(msUntilNextMinute(Date.UTC(2026, 0, 1, 0, 0, 30))).toBe(30_000);
  });
});

const container = (name: string, status: Container["status"], extra: Partial<Container> = {}): Container => ({
  id: `${name}-id`, name, image: `${name}:1`, status, ports: [], created: "", labels: {}, ...extra,
});
const stack = (containers: Container[], extra: Partial<ServiceStack> = {}): ServiceStack => ({
  id: containers[0].name, name: containers[0].name, kind: "talome", status: "running",
  primaryContainer: containers[0], containers, ...extra,
} as ServiceStack);

describe("menu-bar clock date", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the full date to keyboard users, not only on hover", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    render(<TooltipProvider delayDuration={0}><DesktopClock /></TooltipProvider>);
    const time = document.querySelector("time")!;
    expect(time).toHaveAttribute("tabindex", "0");
    act(() => { time.focus(); });
    expect(await screen.findByRole("tooltip")).toHaveTextContent(String(new Date().getFullYear()));
  });
});

describe("service state in the dock and Launchpad (D-P0-3)", () => {
  it("reads state from the container, and says missing only when the list loaded", () => {
    const lookup = desktopServiceStatusLookup([
      stack([container("jellyfin", "running")]),
      stack([container("sonarr", "exited", { exitCode: 143 })]),
      stack([container("radarr", "exited", { exitCode: 137 })]),
      stack([container("lidarr", "restarting")]),
      stack([container("bazarr", "created")]),
    ], true);
    expect(lookup("jellyfin").state).toBe("running");
    expect(lookup("sonarr").state).toBe("stopped");
    expect(lookup("radarr").state).toBe("unhealthy");
    expect(lookup("lidarr")).toMatchObject({ state: "working", activity: "Restarting" });
    expect(lookup("bazarr").state).toBe("stopped");
    expect(lookup("gone").state).toBe("missing");
    expect(desktopServiceStatusLookup([], false)("gone").state).toBe("unknown");
    expect(isServiceUnavailable("stopped")).toBe(true);
    expect(isServiceUnavailable("working")).toBe(false);
    expect(isServiceUnavailable("unknown")).toBe(false);
  });

  it("shows a deliberately stopped app as stopped, not unhealthy, when the exit code is unknown (regression)", () => {
    // `docker stop` leaves State "exited"; a core that doesn't report the exit code must not paint it red.
    const lookup = desktopServiceStatusLookup([stack([container("jellyfin", "exited")])], true);
    expect(lookup("jellyfin").state).toBe("stopped");
    expect(desktopDockItemName({ label: "Jellyfin", running: false, serviceState: lookup("jellyfin").state })).toBe("Jellyfin, stopped");
  });

  it("keeps a loaded page through a restart instead of replacing it (regression)", () => {
    const lookup = desktopServiceStatusLookup([stack([container("jellyfin", "restarting")])], true);
    const entry = { windowId: "w1", state: lookup("jellyfin").state, frameLoaded: true };
    expect(showsServiceUnavailable(entry, nextServiceWindowGate(undefined, { ...entry, now: 0 }))).toBe(false);
    expect(desktopDockItemName({ label: "Jellyfin", running: true, serviceState: "working", serviceActivity: "Restarting" }))
      .toBe("Jellyfin, restarting, open");
  });

  it("replaces a loaded page only after its service stays down, and at once for a window opened while down", () => {
    const down = { windowId: "w1", state: "stopped" as const, frameLoaded: true };
    let gates = advanceServiceWindowGates({}, [down], 1_000);
    expect(showsServiceUnavailable(down, gates.w1)).toBe(false);
    // One poll later it is still within the grace period.
    gates = advanceServiceWindowGates(gates, [down], 1_000 + SERVICE_DOWN_GRACE_MS / 2);
    expect(showsServiceUnavailable(down, gates.w1)).toBe(false);
    gates = advanceServiceWindowGates(gates, [down], 1_000 + SERVICE_DOWN_GRACE_MS);
    expect(showsServiceUnavailable(down, gates.w1)).toBe(true);
    // Back up: the page returns at once, and nothing changes while it stays up.
    const up = { ...down, state: "running" as const };
    expect(showsServiceUnavailable(up, gates.w1)).toBe(false);
    const settled = advanceServiceWindowGates(gates, [up], 99_000);
    expect(advanceServiceWindowGates(settled, [up], 99_500)).toBe(settled);
    // Opened while down: no page to keep.
    expect(showsServiceUnavailable({ ...down, frameLoaded: false }, undefined)).toBe(true);
  });

  it("reads an app being updated as working, never as not installed", () => {
    const missing = desktopServiceStatusLookup([], true)("immich_server");
    expect(missing.state).toBe("missing");
    const ops = [{ appId: "immich", kind: "update" as const, status: "running" as const }];
    expect(withActiveOperation(missing, "immich_server", ops)).toMatchObject({ state: "working", activity: "Updating" });
    expect(withActiveOperation(missing, "immich_server", [{ ...ops[0], status: "succeeded" as const }]).state).toBe("missing");
    expect(withActiveOperation(missing, "jellyfin", ops).state).toBe("missing");
  });

  it("starts an app Talome installed through the gated app route, and only unmanaged containers directly", () => {
    const lookup = desktopServiceStatusLookup([
      stack([container("immich_server", "exited"), container("immich_redis", "exited")], { storeId: "talome", appId: "immich" }),
      stack([container("portainer", "exited")], { kind: "standalone" }),
    ], true);
    expect(desktopServiceStartPath(lookup("immich_server"))).toBe("/api/apps/talome/immich/start");
    expect(desktopServiceStartPath(lookup("portainer"))).toBe("/api/containers/portainer-id/start");
    expect(desktopServiceStartPath(lookup("gone"))).toBeNull();
  });

  it("names dock items with their state instead of aria-pressed", () => {
    expect(desktopDockItemName({ label: "Files", running: true })).toBe("Files, open");
    expect(desktopDockItemName({ label: "Files", running: true, minimized: true })).toBe("Files, minimized");
    expect(desktopDockItemName({ label: "Jellyfin", running: false, serviceState: "stopped" })).toBe("Jellyfin, stopped");
    expect(desktopDockItemName({ label: "Books", running: true, minimized: true, stateNote: "playing, window hidden" }))
      .toBe("Books, playing, window hidden");
  });

  it("keeps a stopped app with a known interface in Launchpad instead of dropping it", () => {
    const ui = { port: 8096, protocol: "http" as const, path: "/", title: "Jellyfin", source: "configured" as const };
    const stacks = [stack([container("jellyfin", "stopped", { webUi: ui })])];
    expect(extractLaunchableApps(stacks)).toEqual([]);
    expect(extractLaunchableApps(stacks, { includeStopped: true })).toEqual([
      expect.objectContaining({ id: "jellyfin", running: false }),
    ]);
  });

  it("ranks Launchpad's Enter by exact, then prefix, then contains", () => {
    expect(launchpadMatchRank("Jellyfin", "jellyfin")).toBeLessThan(launchpadMatchRank("Jellyseerr", "jelly"));
    expect(launchpadMatchRank("Jellyseerr", "jelly")).toBeLessThan(launchpadMatchRank("My Jellyfin", "jelly"));
    expect(launchpadMatchRank("Files", "zzz")).toBe(4);
  });
});

describe("a window for a service that isn't running", () => {
  beforeEach(() => {
    mocks.post.mockReset();
  });

  it("offers Start and Ask Talome instead of the browser's error page", async () => {
    mocks.post.mockResolvedValue({ ok: true });
    const onStarted = vi.fn();
    render(<DesktopServiceUnavailable name="Jellyfin" state="stopped" startPath="/api/apps/talome/jellyfin/start" canStart onStarted={onStarted} />);
    expect(screen.getByText("Jellyfin is stopped")).toBeInTheDocument();

    const requests: unknown[] = [];
    const listener = (event: Event) => requests.push(paletteRequestFromEvent(event));
    document.addEventListener(OPEN_PALETTE_EVENT, listener);
    fireEvent.click(screen.getByRole("button", { name: "Ask Talome" }));
    document.removeEventListener(OPEN_PALETTE_EVENT, listener);
    expect(requests).toEqual([{ mode: "chat", prefill: expect.stringContaining("Jellyfin is stopped") }]);

    fireEvent.click(screen.getByRole("button", { name: "Start Jellyfin" }));
    await waitFor(() => expect(onStarted).toHaveBeenCalledOnce());
    expect(mocks.post).toHaveBeenCalledWith("/api/apps/talome/jellyfin/start");
  });

  it("reports a failed start in place", async () => {
    mocks.post.mockRejectedValue(new Error("port 8096 is already in use"));
    render(<DesktopServiceUnavailable name="Jellyfin" state="unhealthy" startPath="/api/containers/abc/start" canStart onStarted={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Start Jellyfin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't start Jellyfin: port 8096 is already in use");
  });

  it("offers no Start without permission, and none for an uninstalled app", () => {
    const { rerender } = render(<DesktopServiceUnavailable name="Jellyfin" state="stopped" startPath="/api/containers/abc/start" canStart={false} onStarted={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Start Jellyfin" })).not.toBeInTheDocument();
    const remove = vi.fn();
    const store = vi.fn();
    rerender(<DesktopServiceUnavailable name="Jellyfin" state="missing" canStart onStarted={vi.fn()} onRemoveFromDock={remove} onOpenAppStore={store} />);
    expect(screen.getByText("Jellyfin isn't installed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Start/ })).not.toBeInTheDocument();
    // The copy names two ways out; both are there.
    fireEvent.click(screen.getByRole("button", { name: "Remove from Dock" }));
    fireEvent.click(screen.getByRole("button", { name: "Open App Store" }));
    expect(remove).toHaveBeenCalledOnce();
    expect(store).toHaveBeenCalledOnce();
  });
});

describe("approvals in the menu bar (D-P0-1)", () => {
  const approval = (id: string, createdAt: string) => ({
    id, actor: { kind: "mcp_token", id: "t1", label: "Cursor" }, source: "mcp", tool: "restart_app",
    summary: `Cursor wants to run "Restart app" on ${id} (modify).`, argsPreview: "{}", status: "pending",
    createdAt, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), decidedBy: null, decidedAt: null, consumedAt: null,
  });

  beforeEach(() => {
    mocks.pending = [];
    mocks.decide.mockReset().mockResolvedValue({ ok: true });
    mocks.mutate.mockReset();
  });

  it("renders nothing when no approval waits or for members", () => {
    const { container: empty } = render(<DesktopApprovalsButton isAdmin onReviewAll={vi.fn()} />);
    expect(empty).toBeEmptyDOMElement();
    mocks.pending = [approval("sonarr", "2026-09-30T10:00:00Z")];
    const { container: memberView } = render(<DesktopApprovalsButton isAdmin={false} onReviewAll={vi.fn()} />);
    expect(memberView).toBeEmptyDOMElement();
  });

  it("shows a pluralized count and approves inline, oldest first as the primary", async () => {
    expect(approvalsWaitingLabel(1)).toBe("1 approval waiting");
    mocks.pending = [approval("radarr", "2026-09-30T10:05:00Z"), approval("sonarr", "2026-09-30T10:00:00Z")];
    render(<DesktopApprovalsButton isAdmin onReviewAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "2 approvals waiting" }));
    const summaries = await screen.findAllByText(/Cursor wants to run/);
    expect(summaries[0]).toHaveTextContent("sonarr");
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]);
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith("sonarr", "approve"));
    expect(mocks.mutate).toHaveBeenCalled();
  });
});

describe("approvals in the menu bar: what will run", () => {
  const approval = (id: string, summary: string) => ({
    id, actor: { kind: "mcp_token", id: "t1", label: "Cursor" }, source: "mcp", tool: "uninstall_app",
    summary, argsPreview: "{}", status: "pending", createdAt: "2026-09-30T10:00:00Z",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), decidedBy: null, decidedAt: null, consumedAt: null,
  });

  beforeEach(() => {
    mocks.decide.mockReset().mockResolvedValue({ ok: true });
  });

  it("says the access level and reversibility, and opens the details before anyone approves blind", async () => {
    expect(splitApprovalSummary('Cursor wants to run "Uninstall app" on sonarr (destructive).'))
      .toEqual({ sentence: 'Cursor wants to run "Uninstall app" on sonarr.', tier: "destructive" });
    expect(approvalDetailLine("modify")).toBe("Everyday change · can be changed back");
    mocks.pending = [approval("apr_1", 'Cursor wants to run "Uninstall app" on sonarr (destructive).')];
    const onReviewAll = vi.fn();
    render(<DesktopApprovalsButton isAdmin onReviewAll={onReviewAll} />);
    fireEvent.click(screen.getByRole("button", { name: "1 approval waiting" }));
    expect(await screen.findByText('Cursor wants to run "Uninstall app" on sonarr.')).toBeInTheDocument();
    expect(screen.getByText("Destructive change · may not be reversible")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Details for Uninstall app" }));
    expect(onReviewAll).toHaveBeenCalledWith("/dashboard/settings/approvals?id=apr_1");
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});

describe("save and log-out honesty (D-P0-6)", () => {
  it("does not report a logout the server refused", async () => {
    await expect(logOut(vi.fn(async () => new Response("{}", { status: 500 })))).resolves.toMatchObject({ ok: false });
    await expect(logOut(vi.fn(async () => { throw new TypeError("offline"); }))).resolves.toMatchObject({ ok: false });
    await expect(logOut(vi.fn(async () => new Response("{}", { status: 200 })))).resolves.toEqual({ ok: true });
  });

  it("says a mode switch was saved on this browser only when the account save failed", () => {
    const retry = vi.fn();
    mocks.toast.warning.mockReset();
    reportModeSave(true, "desktop", retry);
    expect(mocks.toast.warning).not.toHaveBeenCalled();
    reportModeSave(false, "desktop", retry);
    expect(mocks.toast.warning).toHaveBeenCalledWith(modeSaveFailureMessage("desktop"), expect.objectContaining({
      action: expect.objectContaining({ label: "Retry" }),
    }));
  });
});
