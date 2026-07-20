import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopWallpaperDialog } from "@/components/desktop/desktop-customization";

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("searches Unsplash, tracks the download, and applies the wallpaper with attribution", async () => {
    const wallpaperUrl = "https://images.unsplash.com/photo-example?ixid=test&w=2560";
    const downloadLocation = "https://api.unsplash.com/photos/example/download";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        configured: true,
        query: "nature wallpaper",
        page: 1,
        total: 1,
        totalPages: 1,
        photos: [{
          id: "example",
          description: "Mountain lake",
          color: "#334155",
          width: 3000,
          height: 2000,
          thumbnailUrl: "https://images.unsplash.com/photo-example?ixid=test&w=400",
          wallpaperUrl,
          photoUrl: "https://unsplash.com/photos/example?utm_source=talome&utm_medium=referral",
          downloadLocation,
          photographer: {
            name: "Ada Photo",
            username: "adaphoto",
            profileUrl: "https://unsplash.com/@adaphoto?utm_source=talome&utm_medium=referral",
          },
          provider: {
            name: "Unsplash",
            url: "https://unsplash.com/photos/example?utm_source=talome&utm_medium=referral",
          },
        }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tracked: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onWallpaperChange = vi.fn(() => true);

    render(
      <DesktopWallpaperDialog
        open
        wallpaperUrl="/wallpapers/dune.jpg"
        onOpenChange={vi.fn()}
        onWallpaperChange={onWallpaperChange}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Discover" }));
    const wallpaper = await screen.findByRole("radio", {
      name: "Use photo by Ada Photo from Unsplash",
    });
    expect(screen.getByRole("link", { name: "Ada Photo" })).toHaveAttribute(
      "href",
      expect.stringContaining("utm_source=talome"),
    );

    fireEvent.click(wallpaper);
    await waitFor(() => {
      expect(onWallpaperChange).toHaveBeenCalledWith(wallpaperUrl, {
        photoUrl: expect.stringContaining("unsplash.com/photos/example"),
        photographerName: "Ada Photo",
        photographerUrl: expect.stringContaining("unsplash.com/@adaphoto"),
        providerName: "Unsplash",
      });
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/dashboard/desktop/api/unsplash/wallpapers",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ downloadLocation }),
      },
    );
  });

  it("uses the setup-free online provider without download tracking", async () => {
    const wallpaperUrl = "https://w.wallhaven.cc/full/example.jpg";
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      configured: false,
      provider: "wallhaven",
      query: "nature wallpaper",
      page: 1,
      total: 1,
      totalPages: 1,
      photos: [{
        id: "wallhaven-example",
        description: "Mountain lake wallpaper",
        color: "#334155",
        width: 3000,
        height: 2000,
        thumbnailUrl: "https://th.wallhaven.cc/lg/example.jpg",
        wallpaperUrl,
        photoUrl: "https://wallhaven.cc/w/example",
        photographer: {
          name: "Wallhaven contributor",
          username: "example",
          profileUrl: "https://wallhaven.cc/w/example",
        },
        provider: {
          name: "Wallhaven",
          url: "https://wallhaven.cc/w/example",
        },
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onWallpaperChange = vi.fn(() => true);

    render(
      <DesktopWallpaperDialog
        open
        wallpaperUrl="/wallpapers/dune.jpg"
        onOpenChange={vi.fn()}
        onWallpaperChange={onWallpaperChange}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Discover" }));
    fireEvent.click(await screen.findByRole("radio", {
      name: "Use photo by Wallhaven contributor from Wallhaven",
    }));

    await waitFor(() => {
      expect(onWallpaperChange).toHaveBeenCalledWith(wallpaperUrl, {
        photoUrl: "https://wallhaven.cc/w/example",
        photographerName: "Wallhaven contributor",
        photographerUrl: "https://wallhaven.cc/w/example",
        providerName: "Wallhaven",
      });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
