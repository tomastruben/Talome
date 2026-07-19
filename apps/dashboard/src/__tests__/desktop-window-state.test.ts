import { describe, expect, it } from "vitest";
import {
  clampDesktopBounds,
  desktopMinimizeOffset,
  desktopWindowMotionKeyframes,
  isPersistedDesktopDock,
  isPersistedDesktopLayout,
  maximizedDesktopBounds,
} from "@/lib/desktop-window-state";

describe("desktop window geometry", () => {
  it("keeps a dragged window title bar reachable", () => {
    expect(
      clampDesktopBounds(
        { x: 1200, y: -80, width: 700, height: 500 },
        { width: 1024, height: 720 },
        { width: 360, height: 260 },
      ),
    ).toEqual({ x: 904, y: 16, width: 700, height: 500 });
  });

  it("constrains oversize windows to the desktop area", () => {
    expect(
      clampDesktopBounds(
        { x: 40, y: 40, width: 1800, height: 1200 },
        { width: 1280, height: 760 },
        { width: 360, height: 260 },
      ),
    ).toEqual({ x: 40, y: 40, width: 1248, height: 728 });
  });

  it("uses an inset maximized frame", () => {
    expect(maximizedDesktopBounds({ width: 1440, height: 860 })).toEqual({
      x: 16,
      y: 16,
      width: 1408,
      height: 828,
    });
  });

  it("targets the center of the matching Dock icon when minimizing", () => {
    expect(desktopMinimizeOffset(
      { left: 100, top: 60, width: 1000, height: 700 },
      { left: 748, top: 840, width: 48, height: 48 },
    )).toEqual({ x: 172, y: 454 });
  });

  it("restores a window by reversing its minimize geometry", () => {
    const minimize = desktopWindowMotionKeyframes(
      { x: 172, y: 454 },
      "minimize",
    );
    const restore = desktopWindowMotionKeyframes(
      { x: 172, y: 454 },
      "restore",
    );

    expect(restore.transform).toEqual([...minimize.transform].reverse());
    expect(restore.opacity).toEqual([...minimize.opacity].reverse());
    expect(restore.times).toEqual([0, 0.28, 1]);
  });
});

describe("desktop layout persistence", () => {
  it("accepts only the current version with a window collection", () => {
    expect(isPersistedDesktopLayout({ version: 1, windows: [] })).toBe(true);
    expect(isPersistedDesktopLayout({ version: 2, windows: [] })).toBe(false);
    expect(isPersistedDesktopLayout({ version: 1, windows: null })).toBe(false);
  });

  it("accepts only valid pinned service app snapshots", () => {
    expect(isPersistedDesktopDock({
      version: 1,
      apps: [{
        id: "sonarr",
        name: "Sonarr",
        url: "http://localhost:8989",
        iconUrl: "https://example.com/sonarr.png",
      }],
    })).toBe(true);
    expect(isPersistedDesktopDock({
      version: 1,
      apps: [{ id: "sonarr", name: "Sonarr", url: "javascript:alert(1)" }],
    })).toBe(false);
    expect(isPersistedDesktopDock({ version: 2, apps: [] })).toBe(false);
  });
});
