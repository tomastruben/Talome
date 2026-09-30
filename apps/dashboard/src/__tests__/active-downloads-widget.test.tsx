import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDownloadActivity } from "@/lib/download-status";
import type { DownloadQueueItem, DownloadTorrent } from "@talome/types";

const state = vi.hoisted(() => ({ queue: [] as DownloadQueueItem[], torrents: [] as DownloadTorrent[], error: null as Error | null, retry: vi.fn(), success: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/hooks/use-downloads", () => ({ useDownloads: () => ({ ...state, data: { queue: state.queue, torrents: state.torrents }, activity: getDownloadActivity(state.queue, state.torrents), isLoading: false, isValidating: false }) }));
vi.mock("@/components/desktop/desktop-link", () => ({ DesktopLink: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("sonner", () => ({ toast: { success: state.success } }));
import { ActiveDownloadsWidget } from "@/components/widgets/active-downloads-widget";

// Active rows render inside ScrollArea, which watches its size.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const item: DownloadQueueItem = { id: 1, title: "Completed episode", status: "completed", size: 100, sizeleft: 0, progress: 1, type: "tv", estimatedCompletionTime: null };

describe("active download widget", () => {
  beforeEach(() => { state.queue = []; state.torrents = []; state.error = null; state.retry.mockReset(); state.success.mockReset(); state.push.mockReset(); });
  it("shows completed queue entries as a summary, never active rows or a misleading count", () => {
    state.queue = [item, { ...item, id: 2 }];
    render(<ActiveDownloadsWidget />);
    expect(screen.getByText("No active downloads.")).toBeInTheDocument();
    expect(screen.getByText(/2 completed/)).toBeInTheDocument();
    expect(screen.queryByText("2 active")).not.toBeInTheDocument();
    expect(screen.queryByText("Completed episode")).not.toBeInTheDocument();
    expect(state.success).not.toHaveBeenCalled();
  });
  it("offers retry on a fetch error instead of claiming there are no downloads", () => {
    state.error = new Error("Unavailable");
    render(<ActiveDownloadsWidget />);
    expect(screen.queryByText("No active downloads.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.retry).toHaveBeenCalledOnce();
  });
  it("toasts only an item it saw in flight that is now complete, and View navigates without a reload", () => {
    const inFlight: DownloadQueueItem = { ...item, id: 9, title: "Episode 9", status: "downloading", progress: 0.5, sizeleft: 50 };
    state.queue = [inFlight];
    const { rerender } = render(<ActiveDownloadsWidget />);
    expect(state.success).not.toHaveBeenCalled();

    const assign = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    try {
      state.queue = [{ ...inFlight, status: "completed", progress: 1, sizeleft: 0 }];
      rerender(<ActiveDownloadsWidget />);
      expect(state.success).toHaveBeenCalledOnce();
      expect(state.success.mock.calls[0][0]).toBe("Downloaded Episode 9");
      state.success.mock.calls[0][1].action.onClick();
      expect(state.push).toHaveBeenCalledWith("/dashboard/media?tab=downloads");
      expect(assign).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("never toasts an item that disappeared (for example a cancelled download)", () => {
    state.queue = [{ ...item, id: 5, title: "Cancelled", status: "downloading", progress: 0.2, sizeleft: 80 }];
    const { rerender } = render(<ActiveDownloadsWidget />);
    state.queue = [];
    rerender(<ActiveDownloadsWidget />);
    expect(state.success).not.toHaveBeenCalled();
  });
});
