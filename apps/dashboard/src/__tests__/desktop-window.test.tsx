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

  const openArrangeMenu = () => {
    const trigger = screen.getByRole("button", { name: "Arrange Files" });
    fireEvent.keyDown(trigger, { key: "Enter" });
  };

  it("uses quiet window controls instead of coloured traffic lights", () => {
    render(
      <DesktopWindow {...defaultProps}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    const controls = screen.getByRole("group", { name: "Window controls" });
    const colouredAtRest = Array.from(controls.querySelectorAll("button")).filter((button) =>
      button.className.split(/\s+/).some((token) => token.startsWith("bg-status-")),
    );
    expect(colouredAtRest).toEqual([]);
    expect(screen.getByRole("button", { name: "Minimize Files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Arrange Files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close Files" })).toBeVisible();
  });

  it("arranges a window into the left half and remembers its size", async () => {
    const onTile = vi.fn();
    render(
      <DesktopWindow {...defaultProps} onTile={onTile}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    openArrangeMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Left half" }));

    expect(onTile).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 700, height: 820 },
      defaultProps.bounds,
    );
  });

  it("fills the desktop from Arrange", async () => {
    const onMaximizeChange = vi.fn();
    const onBoundsChange = vi.fn();
    render(
      <DesktopWindow {...defaultProps} onTile={vi.fn()} onMaximizeChange={onMaximizeChange} onBoundsChange={onBoundsChange}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    openArrangeMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fill" }));

    expect(screen.queryByRole("menuitem", { name: "Previous size" })).toBeNull();
    expect(onMaximizeChange).toHaveBeenCalledWith(true, defaultProps.bounds);
    expect(onBoundsChange).toHaveBeenCalledWith({ x: 0, y: 0, width: 1400, height: 820 });
  });

  it("offers the previous size once a window is arranged", async () => {
    const onMaximizeChange = vi.fn();
    render(
      <DesktopWindow
        {...defaultProps}
        maximized
        bounds={{ x: 0, y: 0, width: 1400, height: 820 }}
        restoreBounds={defaultProps.bounds}
        onTile={vi.fn()}
        onMaximizeChange={onMaximizeChange}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    openArrangeMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Previous size" }));

    expect(onMaximizeChange).toHaveBeenCalledWith(false, defaultProps.bounds);
  });

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

    fireEvent.pointerDown(document.querySelector('[data-resize-edge="se"]')!, {
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

  it("resizes from the left edge while the right edge stays put", () => {
    const onBoundsChange = vi.fn();
    render(
      <DesktopWindow {...defaultProps} onBoundsChange={onBoundsChange}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(document.querySelector('[data-resize-edge="w"]')!, { button: 0, clientX: 80, clientY: 300 });
    fireEvent.pointerMove(window, { clientX: 40, clientY: 300 });

    expect(onBoundsChange).toHaveBeenLastCalledWith({ x: 40, y: 100, width: 740, height: 500 });
  });

  it("snaps to the left half when dragged to the left edge, remembering its size", () => {
    const onTile = vi.fn();
    render(
      <DesktopWindow {...defaultProps} onTile={onTile}>
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByText("Files").parentElement!.parentElement!, { button: 0, clientX: 300, clientY: 120 });
    fireEvent.pointerMove(window, { clientX: 2, clientY: 300 });
    fireEvent.pointerUp(window);

    expect(onTile).toHaveBeenCalledWith(
      { x: 0, y: 0, width: 700, height: 820 },
      { x: 80, y: 100, width: 700, height: 500 },
    );
  });

  it("gives a snapped window its previous size back when dragged away", () => {
    const onTile = vi.fn();
    render(
      <DesktopWindow
        {...defaultProps}
        bounds={{ x: 0, y: 0, width: 700, height: 820 }}
        restoreBounds={{ x: 80, y: 100, width: 600, height: 400 }}
        onTile={onTile}
      >
        <div>Files content</div>
      </DesktopWindow>,
    );

    fireEvent.pointerDown(screen.getByText("Files").parentElement!.parentElement!, { button: 0, clientX: 350, clientY: 20 });
    fireEvent.pointerMove(window, { clientX: 351, clientY: 21 }); // below the drag threshold
    expect(onTile).not.toHaveBeenCalled();
    fireEvent.pointerMove(window, { clientX: 400, clientY: 60 });

    expect(onTile).toHaveBeenCalledTimes(1);
    const [restored, restore] = onTile.mock.calls[0];
    expect(restored).toMatchObject({ width: 600, height: 400 });
    expect(restore).toBeUndefined();
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

  it("fills the area edge to edge when maximized, rounding only the corners above the Dock", () => {
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
    expect(windowRegion).toHaveClass("rounded-t-none", "rounded-b-2xl", "border-x-0", "border-t-0");
    expect(windowRegion).not.toHaveClass("rounded-2xl");
    expect(document.querySelector("[data-resize-edge]")).toBeNull();
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
