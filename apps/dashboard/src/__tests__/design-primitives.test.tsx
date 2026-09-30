import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";
import { Checkbox, CheckboxField } from "@/components/ui/checkbox";
import { CopyButton, copyText } from "@/components/ui/copy-button";
import { RadioCardGroup, nextEnabledIndex, type RadioCardOption } from "@/components/ui/radio-card-group";
import { edgeFadeState } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { StatusDot } from "@/components/ui/status-dot";
import { LiveAnnouncer, announce } from "@/components/ui/live-announcer";

describe("Button", () => {
  it("renders children directly when not busy-capable (backward compatible)", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button.querySelector("[data-slot=button-label]")).toBeNull();
    expect(button.className).toContain("pressable");
    expect(button.className).not.toContain("transition-all");
  });

  it("keeps focus and width while busy, ignores clicks and announces the busy label", () => {
    const onClick = vi.fn();
    const { rerender } = render(
      <Button busy={false} onClick={onClick}>
        Install
      </Button>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button busy busyLabel="Installing Jellyfin…" onClick={onClick}>
        Install
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Installing Jellyfin…" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    // The label stays in the DOM (fixed width); the spinner is decorative.
    expect(button.querySelector("[data-slot=button-label]")).toHaveTextContent("Install");
    expect(button.querySelector("[data-slot=spinner]")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not submit a form while busy", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" busy>
          Sign in
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe("Spinner", () => {
  it("is a status region on its own and hidden when decorative; it only spins when motion is allowed", () => {
    const { container, rerender } = render(<Spinner />);
    const standalone = screen.getByRole("status", { name: "Loading" });
    expect(standalone.getAttribute("class")).toContain("motion-safe:animate-spin");
    rerender(<Spinner decorative />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(container.querySelector("[data-slot=spinner]")).toHaveAttribute("aria-hidden", "true");
  });
});

describe("CopyButton", () => {
  const writeText = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    writeText.mockReset();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("copies, shows a tick, announces Copied, and reverts after 2s", async () => {
    writeText.mockResolvedValue(undefined);
    render(<CopyButton value="tlm_123" label="Copy access token" />);
    const button = screen.getByRole("button", { name: "Copy access token" });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith("tlm_123");
    expect(button).toHaveAttribute("data-state", "copied");
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(button).toHaveAttribute("data-state", "idle");
  });

  it("falls back to execCommand when the Clipboard API is unavailable (plain http)", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("shows an inline error and selects the text when both copy paths fail", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    function Harness() {
      const ref = useRef<HTMLElement>(null);
      return (
        <div>
          <code ref={ref}>tlm_secret</code>
          <CopyButton value="tlm_secret" label="Copy access token" size="sm" selectOnFailRef={ref} />
        </div>
      );
    }
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy access token" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't copy. The text is selected");
    expect(window.getSelection()?.toString()).toBe("tlm_secret");
  });
});

describe("Checkbox", () => {
  it("is a labelled checkbox with an indeterminate state", () => {
    render(
      <>
        <CheckboxField label="Keep app data" description="Settings and media stay on disk." defaultChecked />
        <Checkbox aria-label="Select all 4 items" checked="indeterminate" />
      </>,
    );
    const keep = screen.getByRole("checkbox", { name: "Keep app data" });
    expect(keep).toBeChecked();
    expect(keep).toHaveAccessibleDescription("Settings and media stay on disk.");
    fireEvent.click(screen.getByText("Keep app data"));
    expect(keep).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select all 4 items" })).toHaveAttribute("aria-checked", "mixed");
  });
});

describe("RadioCardGroup", () => {
  const modes: RadioCardOption<"permissive" | "cautious" | "locked">[] = [
    { value: "permissive", title: "Permissive", description: "Agents act without asking." },
    { value: "cautious", title: "Cautious", description: "Asks before destructive actions.", badge: "Recommended" },
    { value: "locked", title: "Locked", description: "Read-only.", disabled: true, disabledReason: "Needs an admin." },
  ];

  function Harness({ onChange }: { onChange?: (value: string) => void }) {
    const [value, setValue] = useState<"permissive" | "cautious" | "locked">("cautious");
    return (
      <RadioCardGroup
        aria-label="Security mode"
        value={value}
        options={modes}
        onValueChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    );
  }

  it("exposes a radiogroup with one tab stop on the selected card", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup", { name: "Security mode" })).toBeInTheDocument();
    const cautious = screen.getByRole("radio", { name: /Cautious/ });
    expect(cautious).toHaveAttribute("aria-checked", "true");
    expect(cautious).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: /Permissive/ })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("radio", { name: /Locked/ })).toHaveAccessibleDescription("Needs an admin.");
  });

  it("moves and selects with arrow keys, skipping disabled cards", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const cautious = screen.getByRole("radio", { name: /Cautious/ });
    fireEvent.keyDown(cautious, { key: "ArrowDown" });
    // Locked is disabled, so the next enabled card wraps to Permissive.
    expect(onChange).toHaveBeenLastCalledWith("permissive");
    expect(screen.getByRole("radio", { name: /Permissive/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("radio", { name: /Locked/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("finds the next enabled index with wrap-around", () => {
    expect(nextEnabledIndex([false, false, true], 1, 1)).toBe(0);
    expect(nextEnabledIndex([false, true, false], 0, -1)).toBe(2);
    expect(nextEnabledIndex([true, false, true], 1, 1)).toBe(1);
    expect(nextEnabledIndex([], 0, 1)).toBe(-1);
  });
});

describe("edge fades", () => {
  it("fades only the edges that have more content", () => {
    const base = { scrollLeft: 0, scrollWidth: 100, clientWidth: 100, clientHeight: 100 };
    expect(edgeFadeState({ ...base, scrollTop: 0, scrollHeight: 100 })).toEqual({
      top: false,
      bottom: false,
      left: false,
      right: false,
    });
    expect(edgeFadeState({ ...base, scrollTop: 0, scrollHeight: 300 })).toMatchObject({ top: false, bottom: true });
    expect(edgeFadeState({ ...base, scrollTop: 100, scrollHeight: 300 })).toMatchObject({ top: true, bottom: true });
    // Sub-pixel rounding at the end shows no fade.
    expect(edgeFadeState({ ...base, scrollTop: 199.5, scrollHeight: 300 })).toMatchObject({ top: true, bottom: false });
  });
});

describe("StatusDot", () => {
  it("always carries a label and breathes only for work in flight", () => {
    const { container, rerender } = render(<StatusDot state="working" label="Updating" />);
    expect(screen.getByText("Updating")).toBeInTheDocument();
    expect(container.innerHTML).toContain("motion-safe:animate-breathe");
    rerender(<StatusDot state="stopped" label="Stopped" hideLabel />);
    expect(screen.getByText("Stopped")).toHaveClass("sr-only");
    expect(container.innerHTML).not.toContain("status-critical");
    expect(container.innerHTML).not.toContain("animate-");
  });
});

describe("LiveAnnouncer", () => {
  it("speaks announcements through polite and assertive regions", async () => {
    render(<LiveAnnouncer />);
    await act(async () => {
      announce("Cursor is asking to restart sonarr. Approval needed.");
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Approval needed.");
    await act(async () => {
      announce("Approval for sonarr restart expired.", { assertive: true });
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("expired");
  });
});
