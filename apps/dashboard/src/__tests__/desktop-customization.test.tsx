import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({ warning: vi.fn() }));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), { warning: toastMock.warning, success: vi.fn(), error: vi.fn() }),
}));

import {
  DesktopWallpaperDialog,
  WALLPAPER_ACCOUNT_SAVE_FAILED,
  normalizeDesktopWallpaperUrl,
  reportWallpaperAccountSaveFailure,
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

    const dialog = screen.getByRole("dialog", { name: "Desktop wallpaper" });
    const titlebar = dialog.querySelector<HTMLElement>("[data-wallpaper-drag-handle]");
    expect(titlebar).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close desktop wallpaper" })).toBeVisible();
    // A dialog has only the close light: no disabled minimize/zoom dots posing as controls (D-P1-11).
    expect(screen.queryByRole("button", { name: "Minimize desktop wallpaper" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Maximize desktop wallpaper" })).not.toBeInTheDocument();

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

describe("DesktopWallpaperDialog account save (D-P0-6)", () => {
  it("says the wallpaper was saved on this browser only when the account save failed, with Retry", () => {
    const retry = vi.fn();
    const { rerender } = render(
      <DesktopWallpaperDialog
        open
        wallpaperUrl="/wallpapers/dune.jpg"
        onOpenChange={vi.fn()}
        onWallpaperChange={() => true}
        accountSave={{ status: "idle" }}
      />,
    );
    expect(screen.queryByText(/Saved on this browser only/)).not.toBeInTheDocument();
    rerender(
      <DesktopWallpaperDialog
        open
        wallpaperUrl="/wallpapers/dune.jpg"
        onOpenChange={vi.fn()}
        onWallpaperChange={() => true}
        accountSave={{ status: "failed", retry }}
      />,
    );
    expect(screen.getByText(/Saved on this browser only/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("says so in a toast, with Retry, when the dialog was closed before the save failed (regression)", () => {
    const retry = vi.fn();
    toastMock.warning.mockReset();
    expect(reportWallpaperAccountSaveFailure(true, retry)).toBe(false);
    expect(toastMock.warning).not.toHaveBeenCalled();
    expect(reportWallpaperAccountSaveFailure(false, retry)).toBe(true);
    expect(toastMock.warning).toHaveBeenCalledWith(WALLPAPER_ACCOUNT_SAVE_FAILED, expect.objectContaining({
      action: expect.objectContaining({ label: "Retry", onClick: retry }),
    }));
  });
});
