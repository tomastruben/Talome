import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDownloadActivity } from "@/lib/download-status";
import type { DownloadQueueItem, DownloadTorrent } from "@talome/types";

const state = vi.hoisted(() => ({ queue: [] as DownloadQueueItem[], torrents: [] as DownloadTorrent[], error: null as Error | null, retry: vi.fn(), success: vi.fn() }));
vi.mock("@/hooks/use-downloads", () => ({ useDownloads: () => ({ ...state, data: { queue: state.queue, torrents: state.torrents }, activity: getDownloadActivity(state.queue, state.torrents), isLoading: false, isValidating: false }) }));
vi.mock("@/components/desktop/desktop-link", () => ({ DesktopLink: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("sonner", () => ({ toast: { success: state.success } }));
import { ActiveDownloadsWidget } from "@/components/widgets/active-downloads-widget";

const item: DownloadQueueItem = { id: 1, title: "Completed episode", status: "completed", size: 100, sizeleft: 0, progress: 1, type: "tv", estimatedCompletionTime: null };

describe("active download widget", () => {
  beforeEach(() => { state.queue = []; state.torrents = []; state.error = null; state.retry.mockReset(); state.success.mockReset(); });
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
});
