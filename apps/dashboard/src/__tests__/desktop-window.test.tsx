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

  it("renders the classic terminal controls as one titlebar group", async () => {
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
              { id: "terminal-continue-agent", label: "Continue session", separatorBefore: true },
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
    fireEvent.click(await screen.findByRole("menuitem", { name: "Continue session" }));

    expect(onAction.mock.calls).toEqual([
      ["terminal-auto"],
      ["terminal-remote"],
      ["terminal-continue-agent"],
    ]);
  });
});
