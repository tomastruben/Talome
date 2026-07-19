import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopWallpaperDialog } from "@/components/desktop/desktop-customization";

describe("DesktopWallpaperDialog", () => {
  it("moves by its titlebar and stays inside the viewport", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1280,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 800,
    });

    render(
      <DesktopWallpaperDialog
        open
        wallpaperUrl="/wallpapers/dune.jpg"
        onOpenChange={vi.fn()}
        onWallpaperChange={() => true}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Desktop Wallpaper" });
    const titlebar = dialog.querySelector<HTMLElement>("[data-wallpaper-drag-handle]");
    expect(titlebar).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close Desktop Wallpaper" })).toBeVisible();
    expect(screen.queryByText("Choose a Talome scene or use your own image stored in this browser.")).not.toBeInTheDocument();

    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue({
      bottom: 740,
      height: 680,
      left: 256,
      right: 1024,
      top: 60,
      width: 768,
      x: 256,
      y: 60,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(titlebar!, {
      button: 0,
      clientX: 600,
      clientY: 100,
    });
    fireEvent.pointerMove(window, {
      clientX: 900,
      clientY: 500,
    });

    expect(dialog.style.translate).toBe("calc(-50% + 240px) calc(-50% + 44px)");

    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, {
      clientX: 300,
      clientY: 300,
    });
    expect(dialog.style.translate).toBe("calc(-50% + 240px) calc(-50% + 44px)");
  });
});
