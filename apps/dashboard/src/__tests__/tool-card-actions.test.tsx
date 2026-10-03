import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/desktop-navigation", () => ({ requestDesktopNavigation: vi.fn(() => true) }));
vi.mock("@/lib/constants", () => ({ CORE_URL: "http://core" }));

import { ToolOutput, toolCardConfig } from "@/components/ai-elements/tool";
import { ConfirmDialogHost, confirmStore } from "@/components/ui/confirm-dialog";

const fetchMock = vi.fn();

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function lastBody() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as { tool: string; args: Record<string, unknown> } };
}

describe("tool card actions (P0-6)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => confirmStore.reset());

  it("styles an unknown tool as a change, never as a read", () => {
    expect(toolCardConfig("some_custom_tool").tier).toBe("modify");
    expect(toolCardConfig("run_shell").tier).toBe("destructive");
    expect(toolCardConfig("list_containers").tier).toBe("read");
  });

  it("runs Restart through the gated endpoint and shows the outcome", async () => {
    fetchMock.mockResolvedValueOnce(json({ outcome: "success", tier: "modify", result: { success: true } }));
    render(<ToolOutput toolName="list_containers" errorText={undefined} output={[{ id: "abc", name: "sonarr", status: "running" }]} />);

    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(await screen.findByText("Restarted sonarr")).toBeInTheDocument();
    const { url, body } = lastBody();
    expect(url).toBe("http://core/api/chat/actions");
    expect(body).toEqual({ tool: "restart_container", args: { containerId: "abc" } });
  });

  it("shows 'Waiting for approval' with a link when Cautious mode holds the action", async () => {
    fetchMock.mockResolvedValueOnce(json({
      outcome: "approval_required",
      approval: { approvalId: "ap_1", approveUrl: "/dashboard/settings/approvals?id=ap_1", expiresAt: "2099-01-01T00:00:00Z" },
    }));
    render(<ToolOutput toolName="list_containers" errorText={undefined} output={[{ id: "abc", name: "sonarr", status: "running" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(await screen.findByRole("link", { name: "Review" })).toHaveAttribute("href", "/dashboard/settings/approvals?id=ap_1");
  });

  it("pressing the held action again after approval runs it; until then it keeps waiting", async () => {
    const held = {
      outcome: "approval_required",
      approval: { approvalId: "ap_1", approveUrl: "/dashboard/settings/approvals?id=ap_1", expiresAt: "2099-01-01T00:00:00Z", approvalStatus: "pending" },
    };
    fetchMock
      .mockResolvedValueOnce(json(held))
      .mockResolvedValueOnce(json(held))
      .mockResolvedValueOnce(json({ outcome: "success", result: { success: true } }));
    render(<ToolOutput toolName="list_containers" errorText={undefined} output={[{ id: "abc", name: "sonarr", status: "running" }]} />);
    const stop = screen.getByRole("button", { name: "Stop" });
    stop.focus();
    fireEvent.click(stop);
    expect(await screen.findByText(/^Waiting for approval/)).toBeInTheDocument();
    // The button stays (and keeps focus) so the approved request can be used.
    const stopNow = screen.getByRole("button", { name: "Stop now" });
    await waitFor(() => expect(stopNow).toHaveFocus());

    fireEvent.click(stopNow);
    expect(await screen.findByText(/^Still waiting for approval/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop now" }));
    const done = await screen.findByText("Stopped sonarr");
    // Focus moves to the outcome line instead of falling to <body>.
    await waitFor(() => expect(done).toHaveFocus());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(lastBody().body).toEqual({ tool: "stop_container", args: { containerId: "abc" } });
  });

  it("shows the whole failure message, wrapped, instead of truncating the fix", async () => {
    const message = "Talome can't restart the container right now: the tool is turned off or its app isn't set up.";
    fetchMock.mockResolvedValueOnce(json({ error: message }, 404));
    render(<ToolOutput toolName="list_containers" errorText={undefined} output={[{ id: "abc", name: "sonarr", status: "running" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert.className).not.toMatch(/\btruncate\b/);
    expect(screen.getByRole("button", { name: "Retry" }).className).toContain("phone-touch:min-h-11");
  });

  it("names the reason when the action is blocked or fails, and offers Retry", async () => {
    fetchMock.mockResolvedValueOnce(json({ outcome: "blocked", error: { message: "Locked mode allows reading only.", hint: "Switch modes in Settings." } }));
    render(<ToolOutput toolName="list_containers" errorText={undefined} output={[{ id: "abc", name: "sonarr", status: "exited", exitCode: 1 }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Locked mode allows reading only.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("treats a tool that reports { success: false } as a failure, not a success", async () => {
    fetchMock.mockResolvedValueOnce(json({ outcome: "success", result: { success: false, error: "qBittorrent is not configured." } }));
    render(<ToolOutput toolName="audiobook_search_releases" errorText={undefined} output={{ releases: [{ title: "Dune", downloadUrl: "magnet:?x" }] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("qBittorrent is not configured.");
    expect(lastBody().body).toEqual({ tool: "audiobook_download", args: { downloadUrl: "magnet:?x", title: "Dune" } });
  });

  it("requests media with the real TMDB/TVDB id instead of posting to a missing endpoint", async () => {
    fetchMock.mockResolvedValueOnce(json({ outcome: "success", result: { success: true } }));
    render(<ToolOutput toolName="search_media" errorText={undefined} output={{ tv: [{ tvdbId: 81189, title: "Breaking Bad", year: 2008 }], movies: [] }} />);
    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    expect(await screen.findByText("Requested")).toBeInTheDocument();
    expect(lastBody().body).toEqual({ tool: "request_media", args: { type: "tv", tvdbId: 81189, title: "Breaking Bad" } });
  });

  it("hides Request when the result has no request id", () => {
    render(<ToolOutput toolName="search_media" errorText={undefined} output={{ results: [{ id: "x1", title: "Something" }] }} />);
    expect(screen.queryByRole("button", { name: "Request" })).not.toBeInTheDocument();
  });

  it("asks before acting on a card from an earlier turn", async () => {
    fetchMock.mockResolvedValueOnce(json({ outcome: "success", result: { success: true } }));
    render(
      <>
        <ToolOutput stale toolName="list_containers" errorText={undefined} output={[{ id: "abc", name: "sonarr", status: "running" }]} />
        <ConfirmDialogHost />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName("Restart sonarr?");
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Restart" }).at(-1)!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  // A guard, not a regression test: these cards have no hooks after an early
  // return today; this keeps it that way if one gains a hook.
  it("re-renders result cards from empty to full without breaking hook order", () => {
    const { rerender } = render(<ToolOutput toolName="audiobook_search_releases" errorText={undefined} output={{ releases: [] }} />);
    expect(screen.getByText("No releases found")).toBeInTheDocument();
    rerender(<ToolOutput toolName="audiobook_search_releases" errorText={undefined} output={{ releases: [{ title: "Dune", downloadUrl: "u" }] }} />);
    expect(screen.getByText("Dune")).toBeInTheDocument();
    rerender(<ToolOutput toolName="audiobookshelf_search" errorText={undefined} output={{ items: [] }} />);
    rerender(<ToolOutput toolName="audiobookshelf_search" errorText={undefined} output={{ items: [{ id: "1", title: "Dune" }] }} />);
    expect(screen.getByText("Dune")).toBeInTheDocument();
  });
});
