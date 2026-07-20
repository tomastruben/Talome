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
    expect(screen.queryByRole("button", { name: "Resize Files" })).not.toBeInTheDocument();
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
});
