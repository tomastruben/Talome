import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { canAutoConfirm, confirmTierOf, useConfirmAction } from "@/hooks/use-confirm-action";

describe("useConfirmAction", () => {
  it("never skips a destructive confirmation, even in Auto mode (P0-2 regression)", async () => {
    const { result } = renderHook(() => useConfirmAction(true));
    let settled = false;
    let outcome: Promise<boolean> | undefined;
    act(() => {
      outcome = result.current.confirmAction({
        title: "Delete conversation?",
        description: "This conversation and all its messages will be permanently deleted.",
        confirmLabel: "Delete",
        variant: "destructive",
      });
      void outcome.then(() => {
        settled = true;
      });
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const { ConfirmDialog } = result.current;
    render(<ConfirmDialog />);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleName("Delete conversation?");
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await expect(outcome).resolves.toBe(true);
  });

  it("lets Auto mode skip only the soft tier", async () => {
    const { result } = renderHook(() => useConfirmAction(true));
    await expect(
      result.current.confirmAction({
        title: "Start new conversation?",
        description: "The current response will be stopped.",
        variant: "default",
      }),
    ).resolves.toBe(true);
  });

  it("asks for soft confirmations when Auto mode is off", async () => {
    const { result } = renderHook(() => useConfirmAction(false));
    let outcome: Promise<boolean> | undefined;
    act(() => {
      outcome = result.current.confirmAction({ title: "Stop sonarr?", description: "Downloads pause." });
    });
    const { ConfirmDialog } = result.current;
    render(<ConfirmDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(outcome).resolves.toBe(false);
  });
});

describe("confirm tiers", () => {
  it("maps legacy variants onto tiers, with an explicit tier winning", () => {
    expect(confirmTierOf({ variant: "destructive" })).toBe("destructive");
    expect(confirmTierOf({ variant: "default" })).toBe("soft");
    expect(confirmTierOf({})).toBe("soft");
    expect(confirmTierOf({ variant: "default", tier: "destructive" })).toBe("destructive");
  });

  it("allows auto-confirm only for soft confirmations in Auto mode", () => {
    expect(canAutoConfirm(true, { variant: "default" })).toBe(true);
    expect(canAutoConfirm(true, { variant: "destructive" })).toBe(false);
    expect(canAutoConfirm(true, { tier: "destructive" })).toBe(false);
    expect(canAutoConfirm(false, { variant: "default" })).toBe(false);
  });
});
