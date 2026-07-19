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
  });
});
