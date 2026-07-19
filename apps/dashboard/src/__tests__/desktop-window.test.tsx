import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopWindow } from "@/components/desktop/desktop-window";

describe("DesktopWindow", () => {
  it("reports pointer-driven resize geometry", () => {
    const onBoundsChange = vi.fn();

    render(
      <DesktopWindow
        id="files"
        title="Files"
        bounds={{ x: 80, y: 100, width: 700, height: 500 }}
        area={{ width: 1400, height: 820 }}
        minimum={{ width: 420, height: 320 }}
        active
        maximized={false}
        zIndex={2}
        onFocus={vi.fn()}
        onClose={vi.fn()}
        onMinimize={vi.fn()}
        onBoundsChange={onBoundsChange}
        onMaximizeChange={vi.fn()}
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
});
