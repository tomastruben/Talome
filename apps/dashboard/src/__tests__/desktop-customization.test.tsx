import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DesktopWallpaperDialog,
  normalizeDesktopWallpaperUrl,
} from "@/components/desktop/desktop-customization";

describe("normalizeDesktopWallpaperUrl", () => {
  it("clears retired fantasy wallpapers while preserving current and custom choices", () => {
    expect(normalizeDesktopWallpaperUrl(
      "/wallpapers/generated/talome-29.jpg",
    )).toBeUndefined();
    expect(normalizeDesktopWallpaperUrl(
      "/wallpapers/generated/talome-46.jpg",
    )).toBe("/wallpapers/generated/talome-46.jpg");
    expect(normalizeDesktopWallpaperUrl("data:image/jpeg;base64,custom")).toBe(
      "data:image/jpeg;base64,custom",
    );
  });
});

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
    expect(screen.getByRole("button", { name: "Minimize Desktop Wallpaper" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Maximize Desktop Wallpaper" })).toBeDisabled();

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

  it("offers generated wallpapers in Talome without a Discover section", () => {
    const onWallpaperChange = vi.fn(() => true);

    render(
      <DesktopWallpaperDialog
        open
        wallpaperUrl="/wallpapers/dune.jpg"
        onOpenChange={vi.fn()}
        onWallpaperChange={onWallpaperChange}
      />,
    );

    expect(screen.queryByRole("tab", { name: "Discover" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Talome" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Custom" })).toBeVisible();

    expect(screen.getByRole("radio", {
      name: "Use Luminous Fold wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Glacier Dawn wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Mineral Veil wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Quiet Fjord wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Ring Garden wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Azure Bloom wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Silver Tempest wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Porcelain Helix wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Dusk Ribbon wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Pearl Event wallpaper",
    })).toBeVisible();
    expect(screen.getByRole("radio", {
      name: "Use Whispered Lens wallpaper",
    })).toBeVisible();

    expect(screen.queryByRole("radio", {
      name: "Use Bioluminescent Valley wallpaper",
    })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", {
      name: "Use Celestial Tidepools wallpaper",
    })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", {
      name: "Use Midnight Botanica wallpaper",
    })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", {
      name: "Use Deep Nebula wallpaper",
    })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", {
      name: "Use Magenta Rift wallpaper",
    })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", {
      name: "Use Sage Contours wallpaper",
    }));
    expect(onWallpaperChange).toHaveBeenCalledWith(
      "/wallpapers/generated/talome-46.jpg",
      undefined,
    );

    fireEvent.click(screen.getByRole("radio", {
      name: "Use Pearl Event wallpaper",
    }));
    expect(onWallpaperChange).toHaveBeenLastCalledWith(
      "/wallpapers/generated/talome-75.jpg",
      undefined,
    );

    fireEvent.click(screen.getByRole("radio", {
      name: "Use Coral Strand wallpaper",
    }));
    expect(onWallpaperChange).toHaveBeenLastCalledWith(
      "/wallpapers/generated/talome-65.jpg",
      undefined,
    );
  });
});
