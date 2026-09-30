import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/constants", () => ({ CORE_URL: "http://core" }));
vi.mock("@/components/trust/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/trust/api")>();
  return { ...actual, usePendingApprovals: () => ({ count: 0, pending: [], error: undefined, isLoading: false, mutate: vi.fn() }) };
});

import { SecuritySection } from "@/components/settings/sections/security";
import { ConfirmDialogHost, confirmStore } from "@/components/ui/confirm-dialog";
import { useUndoableDelete } from "@/components/chat/use-undoable-delete";
import { renderHook } from "@testing-library/react";

const fetchMock = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
      <ConfirmDialogHost />
    </SWRConfig>
  );
}

function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const PROFILE = {
  mode: "cautious",
  shellAllowlist: ["cat", "ls"],
  approvalTtlMinutes: { interactive: 15, unattended: 1440 },
  claudeCode: { buildsSkipPrompts: false, evolutionSkipsPrompts: false },
};

describe("Security settings (P0-7)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => confirmStore.reset());

  it("shows an error with Retry instead of a default mode when loading fails", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("security-profile")) return json({ error: "Couldn't read settings." }, 500);
      return json({ hasPassword: true });
    });
    render(<SecuritySection />, { wrapper });

    expect(await screen.findByText("Couldn't load the security mode")).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /Cautious/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0);
  });

  it("renders the server's mode and its real shell allowlist", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("security-profile") ? json({ ...PROFILE, mode: "locked" }) : json({ hasPassword: true }),
    );
    render(<SecuritySection />, { wrapper });
    const locked = await screen.findByRole("radio", { name: /Locked/ });
    expect(locked).toHaveAttribute("aria-checked", "true");
    // The allowlist only shows in Cautious mode.
    expect(screen.queryByRole("list", { name: "Allowed shell commands" })).not.toBeInTheDocument();
  });

  it("asks before widening the mode and saves only after confirming", async () => {
    let mode = "cautious";
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("security-profile")) return json({ ...PROFILE, mode });
      if (url === "http://core/api/settings" && init?.method === "POST") {
        mode = JSON.parse(String(init.body)).security_mode;
        return json({ ok: true });
      }
      return json({ hasPassword: true });
    });
    render(<SecuritySection />, { wrapper });
    expect(await screen.findByRole("list", { name: "Allowed shell commands" })).toHaveTextContent("cat");

    fireEvent.click(screen.getByRole("radio", { name: /Permissive/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Switch to Permissive mode?");
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Switch to Permissive" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Permissive/ })).toHaveAttribute("aria-checked", "true"));
    expect(mode).toBe("permissive");
  });

  it("turning off Claude Code prompts for builds asks first; turning them back on doesn't", async () => {
    let builds = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("security-profile")) return json({ ...PROFILE, claudeCode: { buildsSkipPrompts: builds, evolutionSkipsPrompts: false } });
      if (url === "http://core/api/settings" && init?.method === "POST") {
        builds = JSON.parse(String(init.body)).creator_skip_permission_prompts === "true";
        return json({ ok: true });
      }
      return json({ hasPassword: true });
    });
    render(<SecuritySection />, { wrapper });
    const toggle = await screen.findByRole("switch", { name: "Build apps without permission prompts" });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    fireEvent.click(toggle);
    expect(await screen.findByRole("alertdialog")).toHaveAccessibleName("Build apps without permission prompts?");
    fireEvent.click(screen.getByRole("button", { name: "Turn off prompts" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Build apps without permission prompts" })).toHaveAttribute("aria-checked", "true"));
    expect(builds).toBe(true);

    fireEvent.click(screen.getByRole("switch", { name: "Build apps without permission prompts" }));
    await waitFor(() => expect(builds).toBe(false));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});

describe("useUndoableDelete (P0-16)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hides at once, deletes only after the undo window, and Undo cancels", async () => {
    const remove = vi.fn(async () => true);
    const { result, unmount } = renderHook(() => useUndoableDelete(remove));

    act(() => result.current.request("a", "Plan a media server"));
    expect(result.current.pending.has("a")).toBe(true);
    expect(remove).not.toHaveBeenCalled();

    act(() => result.current.undo("a"));
    expect(result.current.pending.has("a")).toBe(false);
    await act(async () => { vi.advanceTimersByTime(7000); });
    expect(remove).not.toHaveBeenCalled();

    act(() => result.current.request("b", "Fix Sonarr"));
    await act(async () => { vi.advanceTimersByTime(6000); });
    expect(remove).toHaveBeenCalledWith("b");
    expect(result.current.pending.has("b")).toBe(false);

    // Leaving the page finishes a pending delete instead of dropping it.
    act(() => result.current.request("c", "Old chat"));
    unmount();
    expect(remove).toHaveBeenCalledWith("c");
  });
});
