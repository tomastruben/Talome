import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({
  loading: vi.fn(() => "toast-1"),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: toastMock,
  Toaster: () => null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

import { StatCard, formatStatValue } from "@/components/dashboard/stat-card";
import {
  shouldRestoreScroll,
  slideExitTransition,
  slideTransition,
  slideVariants,
  stackDirection,
} from "@/components/layout/stack-layout";
import { TOAST_DURATION, promiseToast, toastIcons } from "@/components/ui/sonner";
import { DURATION, TRAVEL } from "@/lib/motion";

describe("StackLayout motion", () => {
  it("pushes deeper, pops back and crossfades siblings", () => {
    const root = "/dashboard/settings";
    expect(stackDirection(root, `${root}/ai`, root)).toBe(1);
    expect(stackDirection(`${root}/ai`, `${root}/ai/models`, root)).toBe(1);
    expect(stackDirection(`${root}/ai/models`, root, root)).toBe(-1);
    expect(stackDirection(`${root}/ai`, `${root}/storage`, root)).toBe(0);
    expect(stackDirection(root, root, root)).toBe(0);
  });

  it("uses short travel (24px in, 12px out), 180ms in and 140ms out, never a full-width slide", () => {
    expect(slideVariants.enter(1)).toMatchObject({ x: TRAVEL.push, opacity: 0 });
    expect(slideVariants.exit(1)).toMatchObject({ x: TRAVEL.pushExit, opacity: 0 });
    expect(slideVariants.enter(-1)).toMatchObject({ x: TRAVEL.pushExit });
    expect(slideVariants.exit(-1)).toMatchObject({ x: TRAVEL.push });
    expect(slideVariants.enter(0)).toMatchObject({ x: 0, opacity: 0 });
    expect(JSON.stringify(slideVariants.enter(1))).not.toContain("%");
    expect(slideTransition.duration).toBe(DURATION.base);
    expect(slideTransition.opacity?.duration).toBeLessThan(DURATION.base);
    expect(slideExitTransition.duration).toBe(DURATION.exit);
  });

  it("does not restore scroll over a deep link", () => {
    expect(shouldRestoreScroll("")).toBe(true);
    expect(shouldRestoreScroll("?tab=general")).toBe(true);
    expect(shouldRestoreScroll("?id=jellyfin")).toBe(false);
  });
});

describe("StatCard", () => {
  it("snaps to the value on mount instead of counting up from 0 (P1-10 regression)", () => {
    render(<StatCard title="CPU" value={42} suffix="%" />);
    expect(screen.getByText("42.0%")).toBeInTheDocument();
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
    expect(screen.getByText("42.0%")).toHaveClass("tabular-nums");
  });

  it("formats values", () => {
    expect(formatStatValue(12.345, "%")).toBe("12.3%");
    expect(formatStatValue(12.6, " GB")).toBe("13 GB");
    expect(formatStatValue(7)).toBe("7");
  });
});

describe("toasts", () => {
  beforeEach(() => {
    toastMock.loading.mockClear();
    toastMock.success.mockClear();
    toastMock.error.mockClear();
  });

  it("gives warning and error different glyphs, with colour only on the icon", () => {
    render(
      <>
        {toastIcons.warning}
        {toastIcons.error}
        {toastIcons.success}
      </>,
    );
    const warning = document.querySelector("[data-toast-icon=warning]");
    const error = document.querySelector("[data-toast-icon=error]");
    expect(warning?.innerHTML).not.toEqual(error?.innerHTML);
    expect(warning?.getAttribute("class")).toContain("text-status-warning");
    expect(error?.getAttribute("class")).toContain("text-status-critical");
    expect(document.querySelector("[data-toast-icon=success]")?.getAttribute("class")).toContain("text-status-healthy");
  });

  it("tracks a long operation in one toast and ends in the receipt", async () => {
    const open = vi.fn();
    await act(async () => {
      await promiseToast(Promise.resolve({ version: "10.9" }), {
        loading: "Updating Jellyfin…",
        success: (result) => `Updated Jellyfin to ${result.version} · verified healthy`,
        error: "Couldn't update Jellyfin.",
        successAction: { label: "Open", onClick: open },
      });
    });
    expect(toastMock.loading).toHaveBeenCalledWith("Updating Jellyfin…");
    expect(toastMock.success).toHaveBeenCalledWith("Updated Jellyfin to 10.9 · verified healthy", {
      id: "toast-1",
      description: undefined,
      duration: TOAST_DURATION.success,
      action: { label: "Open", onClick: open },
    });
  });

  it("keeps an actionable error until dismissed and offers Retry", async () => {
    const retry = vi.fn();
    const ask = { label: "Ask Talome", onClick: vi.fn() };
    const failure = promiseToast(Promise.reject(new Error("port 8096 is already in use")), {
      loading: "Installing Jellyfin…",
      success: "Installed Jellyfin",
      error: (err) => `Couldn't install Jellyfin: ${(err as Error).message}.`,
      onRetry: retry,
      errorAction: ask,
    });
    await act(async () => {
      await failure.catch(() => {});
    });
    expect(toastMock.error).toHaveBeenCalledWith("Couldn't install Jellyfin: port 8096 is already in use.", {
      id: "toast-1",
      duration: Infinity,
      action: { label: "Retry", onClick: retry },
      cancel: ask,
    });
  });
});
