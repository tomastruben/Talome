import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args) } }));

import {
  ConfirmDialog,
  ConfirmDialogHost,
  confirmRunError,
  confirmStore,
  useConfirm,
  type ConfirmOptions,
} from "@/components/ui/confirm-dialog";

const uninstall: ConfirmOptions = {
  tier: "destructive",
  title: "Uninstall Jellyfin?",
  consequence: "Jellyfin stops and its container is removed.",
  recovery: "Your media and Jellyfin settings are kept in /data/jellyfin.",
  confirmLabel: "Uninstall Jellyfin",
};

const stop: ConfirmOptions = {
  tier: "soft",
  title: "Stop sonarr?",
  consequence: "Downloads and imports pause until you start it again.",
  recovery: "Nothing is deleted. Start it any time.",
  confirmLabel: "Stop sonarr",
};

beforeEach(() => {
  toastSuccess.mockReset();
});

afterEach(() => {
  act(() => confirmStore.reset());
});

describe("ConfirmDialog", () => {
  it("states the consequence and the recovery as separate lines", () => {
    render(<ConfirmDialog open onResult={() => {}} {...uninstall} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveAccessibleName("Uninstall Jellyfin?");
    expect(screen.getByText(uninstall.consequence)).toBeInTheDocument();
    expect(screen.getByText(uninstall.recovery)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Uninstall Jellyfin" })).toBeInTheDocument();
  });

  it("focuses Cancel for the destructive tier, so Enter never confirms by accident", async () => {
    render(<ConfirmDialog open onResult={() => {}} {...uninstall} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Uninstall Jellyfin" })).toHaveAttribute("data-variant", "destructive");
  });

  it("focuses the confirm button for the soft tier", async () => {
    render(<ConfirmDialog open onResult={() => {}} {...stop} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop sonarr" })).toHaveFocus());
    expect(screen.getByRole("button", { name: "Stop sonarr" })).toHaveAttribute("data-variant", "default");
  });

  it("reports the option's state with the result", () => {
    const onResult = vi.fn();
    render(
      <ConfirmDialog
        open
        onResult={onResult}
        {...uninstall}
        option={{ label: "Keep app data", defaultChecked: true }}
      />,
    );
    const option = screen.getByRole("checkbox", { name: "Keep app data" });
    expect(option).toBeChecked();
    fireEvent.click(option);
    expect(option).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Jellyfin" }));
    expect(onResult).toHaveBeenCalledWith({ confirmed: true, optionChecked: false });
  });

  it("requires the exact name before a type-to-confirm action", () => {
    const onResult = vi.fn();
    render(<ConfirmDialog open onResult={onResult} {...uninstall} typeToConfirm="media-hub" />);
    const confirm = screen.getByRole("button", { name: "Uninstall Jellyfin" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "media-hu" } });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "media-hub" } });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);
    expect(onResult).toHaveBeenCalledWith({ confirmed: true, optionChecked: false });
  });

  it("cancels with Cancel", () => {
    const onResult = vi.fn();
    render(<ConfirmDialog open onResult={onResult} {...stop} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onResult).toHaveBeenCalledWith({ confirmed: false, optionChecked: false });
  });

  it("owns the busy state while run() works, and cannot be dismissed", async () => {
    let finish: (value: unknown) => void = () => {};
    const run = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const onResult = vi.fn();
    render(
      <ConfirmDialog open onResult={onResult} {...uninstall} run={run} busyLabel="Uninstalling Jellyfin…" receipt="Uninstalled Jellyfin" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Jellyfin" }));
    const busy = await screen.findByRole("button", { name: "Uninstalling Jellyfin…" });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(run).toHaveBeenCalledWith({ optionChecked: false });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onResult).not.toHaveBeenCalled();

    await act(async () => finish({ ok: true }));
    expect(onResult).toHaveBeenCalledWith({ confirmed: true, optionChecked: false });
    expect(toastSuccess).toHaveBeenCalledWith("Uninstalled Jellyfin");
  });

  it("keeps the dialog open with the error and a Retry when run() fails", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Couldn't uninstall Jellyfin: the container is still starting. Try again in a minute."))
      .mockResolvedValueOnce(undefined);
    const onResult = vi.fn();
    render(<ConfirmDialog open onResult={onResult} {...uninstall} run={run} />);
    fireEvent.click(screen.getByRole("button", { name: "Uninstall Jellyfin" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("the container is still starting");
    expect(onResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(onResult).toHaveBeenCalledWith({ confirmed: true, optionChecked: false }));
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("confirmRunError", () => {
  it("treats `{ ok: false, error }` results and thrown values as failures", () => {
    expect(confirmRunError({ ok: true, value: undefined })).toBeNull();
    expect(confirmRunError({ ok: true, value: { ok: true } })).toBeNull();
    expect(confirmRunError({ ok: true, value: { ok: false, error: "Port 8096 is in use." } })).toBe("Port 8096 is in use.");
    expect(confirmRunError({ ok: false, error: new Error("Nope.") })).toBe("Nope.");
    expect(confirmRunError({ ok: false, error: null })).toMatch(/Try again/);
  });
});

describe("useConfirm with ConfirmDialogHost", () => {
  it("resolves with the person's decision", async () => {
    render(<ConfirmDialogHost />);
    const { result } = renderHook(() => useConfirm());
    let outcome: Promise<{ confirmed: boolean; optionChecked: boolean }> | undefined;
    act(() => {
      outcome = result.current(stop);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Stop sonarr" }));
    await expect(outcome).resolves.toEqual({ confirmed: true, optionChecked: false });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("shows queued requests one at a time", async () => {
    render(<ConfirmDialogHost />);
    const { result } = renderHook(() => useConfirm());
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    act(() => {
      first = result.current(stop);
      second = result.current(uninstall);
    });
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await expect(first).resolves.toEqual({ confirmed: false, optionChecked: false });
    expect(await screen.findByRole("button", { name: "Uninstall Jellyfin" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(second).resolves.toEqual({ confirmed: false, optionChecked: false });
  });

  it("treats a request as cancelled when no host is mounted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { result } = renderHook(() => useConfirm());
    await expect(result.current(uninstall)).resolves.toEqual({ confirmed: false, optionChecked: false });
    errors.mockRestore();
  });
});
