import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopWindow } from "@/components/desktop/desktop-window";

describe("DesktopWindow", () => {
  const defaultProps = {
    id: "files",
    title: "Files",
    bounds: { x: 80, y: 100, width: 700, height: 500 },
    area: { width: 1400, height: 820 },
    minimum: { width: 420, height: 320 },
    active: true,
    maximized: false,
    zIndex: 2,
    onFocus: vi.fn(),
    onClose: vi.fn(),
    onMinimize: vi.fn(),
    onBoundsChange: vi.fn(),
    onMaximizeChange: vi.fn(),
  };

  it("reports pointer-driven resize geometry", () => {
    const onBoundsChange = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        onBoundsChange={onBoundsChange}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Resize Files" }), {
      button: 0,
      clientX: 780,
      clientY: 600,
    });
    fireEvent.pointerMove(window, { clientX: 860, clientY: 650 });

    expect(onBoundsChange).toHaveBeenLastCalledWith({
      x: 80,
      y: 100,
      width: 780,
      height: 550,
    });
  });

  it("resizes with arrow keys and clamps accelerated keyboard resizing", () => {
    const onBoundsChange = vi.fn();
    render(<DesktopWindow {...defaultProps} onBoundsChange={onBoundsChange}>Content</DesktopWindow>);
    const handle = screen.getByRole("button", { name: "Resize Files" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ ...defaultProps.bounds, width: 716 });
    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ ...defaultProps.bounds, height: 436 });
    fireEvent.keyDown(handle, { key: "Enter" });
    expect(onBoundsChange).toHaveBeenCalledTimes(2);
  });

  it("activates a window when its controls receive keyboard focus", () => {
    const onFocus = vi.fn();
    render(<DesktopWindow {...defaultProps} active={false} onFocus={onFocus}>Content</DesktopWindow>);
    fireEvent.focus(screen.getByRole("button", { name: "Close Files" }));
    expect(onFocus).toHaveBeenCalledOnce();
  });

  it("keeps keyboard resizing within the available workspace", () => {
    const onBoundsChange = vi.fn();
    render(<DesktopWindow {...defaultProps} bounds={{ x: 80, y: 100, width: 1310, height: 330 }} onBoundsChange={onBoundsChange}>Content</DesktopWindow>);
    const handle = screen.getByRole("button", { name: "Resize Files" });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 80, y: 100, width: 1320, height: 330 });
    fireEvent.keyDown(handle, { key: "ArrowUp", shiftKey: true });
    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 80, y: 100, width: 1310, height: 320 });
  });

  it("captures resize gestures and keeps the handle inside the workspace", () => {
    const onBoundsChange = vi.fn();
    const setPointerCapture = vi.fn();
    const resizePrototype = HTMLElement.prototype as HTMLElement & {
      setPointerCapture?: (pointerId: number) => void;
    };
    const originalSetPointerCapture = resizePrototype.setPointerCapture;
    resizePrototype.setPointerCapture = setPointerCapture;

    try {
      render(
        <DesktopWindow
          {...defaultProps}
          onBoundsChange={onBoundsChange}
        >
          <iframe title="Service app" />
        </DesktopWindow>,
      );

      fireEvent.pointerDown(screen.getByRole("button", { name: "Resize Files" }), {
        button: 0,
        pointerId: 7,
        clientX: 780,
        clientY: 600,
      });
      fireEvent.pointerMove(window, { pointerId: 7, clientX: 2400, clientY: 1600 });

      expect(setPointerCapture).toHaveBeenCalledWith(7);
      expect(onBoundsChange).toHaveBeenLastCalledWith({
        x: 80,
        y: 100,
        width: 1320,
        height: 720,
      });
    } finally {
      resizePrototype.setPointerCapture = originalSetPointerCapture;
    }
  });

  it("lets pointer dragging place a normal window flush with the top-left edges", () => {
    const onBoundsChange = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        onBoundsChange={onBoundsChange}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByText("Files"), {
      button: 0,
      clientX: 200,
      clientY: 220,
    });
    fireEvent.pointerMove(window, { clientX: 0, clientY: 0 });

    expect(onBoundsChange).toHaveBeenLastCalledWith({
      x: 0,
      y: 0,
      width: 700,
      height: 500,
    });
  });

  it("renders leading, trailing, and toggle actions in the titlebar", () => {
    const onAction = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        title="Assistant"
        actions={[
          { id: "back", label: "Back", icon: "back", placement: "leading" },
          { id: "auto", label: "Auto", kind: "toggle", active: false },
          { id: "new", label: "New", icon: "add" },
        ]}
        onAction={onAction}
      >
        <div>Assistant content</div>
      </DesktopWindow>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(screen.getByRole("switch", { name: "Auto" }));
    fireEvent.click(screen.getByRole("button", { name: "New" }));

    expect(onAction.mock.calls).toEqual([["back"], ["auto"], ["new"]]);
    expect(screen.getByText("Assistant")).toHaveAttribute("data-title-placement", "leading");
  });

  it("keeps the title beside the window controls when there are no actions", () => {
    render(
      <DesktopWindow {...defaultProps}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    expect(screen.getByText("Files")).toHaveAttribute("data-title-placement", "leading");
  });

  it("uses simple Hugeicons glyphs for the semaphore controls", () => {
    render(
      <DesktopWindow {...defaultProps}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    expect(document.querySelector('[data-window-control-glyph="close"]')).toBeInTheDocument();
    expect(document.querySelector('[data-window-control-glyph="minimize"]')).toBeInTheDocument();
    expect(document.querySelector('[data-window-control-glyph="maximize"]')).toBeInTheDocument();
    for (const kind of ["close", "minimize", "maximize"]) {
      expect(document.querySelector(`[data-window-control-glyph="${kind}"]`)).toHaveClass(
        "absolute",
        "left-1/2",
        "top-1/2",
        "-translate-x-1/2",
        "-translate-y-1/2",
      );
    }
    expect(
      screen.getByRole("button", { name: "Close Files" }).querySelector("svg"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Minimize Files" }).querySelector("svg"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Maximize Files" }).querySelector("svg"),
    ).toBeInTheDocument();
  });

  it("removes inset window chrome when maximized", () => {
    render(
      <DesktopWindow
        {...defaultProps}
        maximized
        bounds={{ x: 0, y: 0, width: 1400, height: 820 }}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    const windowRegion = screen.getByRole("region", { name: "Files window" });
    expect(windowRegion).toHaveClass("rounded-none", "border-0");
    expect(windowRegion).not.toHaveClass("rounded-xl");
    expect(screen.queryByRole("button", { name: "Resize Files" })).not.toBeInTheDocument();
  });

  it("removes a disabled window and its controls from interaction", () => {
    render(
      <DesktopWindow {...defaultProps} disabled>
        <div>Files content</div>
      </DesktopWindow>,
    );

    const windowRegion = document.querySelector('[data-desktop-window="files"]');
    expect(windowRegion).toHaveAttribute("inert");
    expect(windowRegion).toHaveAttribute("aria-hidden", "true");
    expect(windowRegion).toHaveClass("pointer-events-none");
  });

  it("keeps a minimized window mounted without exposing it to interaction", () => {
    render(
      <DesktopWindow {...defaultProps} minimized>
        <iframe title="Persistent app frame" src="about:blank" />
      </DesktopWindow>,
    );

    const windowRegion = document.querySelector('[data-desktop-window="files"]');
    expect(windowRegion).toHaveAttribute("data-window-minimized", "true");
    expect(windowRegion).toHaveAttribute("inert");
    expect(windowRegion).toHaveAttribute("aria-hidden", "true");
    expect(windowRegion).toHaveClass(
      "invisible",
      "pointer-events-none",
      "opacity-0",
    );
    expect(screen.getByTitle("Persistent app frame")).toBeInTheDocument();
  });

  it("renders a titlebar menu and dispatches its selected item", async () => {
    const onAction = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        title="Terminal"
        actions={[{
          id: "sessions",
          label: "default",
          kind: "menu",
          placement: "leading",
          items: [
            { id: "session-default", label: "default", active: true },
            { id: "session-refresh", label: "Refresh sessions" },
          ],
        }]}
        onAction={onAction}
      >
        <div>Terminal content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "default" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Refresh sessions" }));

    expect(onAction).toHaveBeenCalledWith("session-refresh");
  });

  it("separates terminal agent selection from session commands", async () => {
    const onAction = vi.fn();

    render(
      <DesktopWindow
        {...defaultProps}
        title="Terminal"
        actions={[
          { id: "terminal-auto", label: "Auto", kind: "toggle", active: true },
          { id: "terminal-remote", label: "Remote", icon: "remote", active: false },
          {
            id: "terminal-agent",
            label: "Codex",
            icon: "source-code",
            kind: "menu",
            items: [
              { id: "terminal-agent-claude", label: "Claude Code" },
              { id: "terminal-agent-codex", label: "Codex", active: true },
            ],
          },
          {
            id: "terminal-session",
            label: "Session",
            kind: "menu",
            items: [
              { id: "terminal-continue-agent", label: "Continue session" },
              { id: "terminal-new-agent-session", label: "New session" },
            ],
          },
        ]}
        onAction={onAction}
      >
        <div>Terminal content</div>
      </DesktopWindow>,
    );

    expect(screen.getByLabelText("Terminal controls")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Auto" }));
    fireEvent.click(screen.getByRole("button", { name: "Remote" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Codex" }), { button: 0 });
    expect(await screen.findByRole("menuitem", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Continue session" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Claude Code" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Session", exact: true }), { button: 0 });
    expect(await screen.findByRole("menuitem", { name: "New session" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Claude Code" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Continue session" }));

    expect(onAction.mock.calls).toEqual([
      ["terminal-auto"],
      ["terminal-remote"],
      ["terminal-agent-claude"],
      ["terminal-continue-agent"],
    ]);
  });
});
