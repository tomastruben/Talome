import { describe, expect, it } from "vitest";
import {
  clampDesktopBounds,
  desktopSnapZoneAt,
  resizeDesktopBounds,
  snappedDesktopBounds,
  unsnapDesktopBounds,
  desktopMinimizeOffset,
  desktopWindowMotionKeyframes,
  isPersistedDesktopDock,
  isPersistedDesktopLayout,
  maximizedDesktopBounds,
  orderDesktopDockIds,
  reorderDesktopDockIds,
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

  it("fills the desktop area with a maximized frame", () => {
    expect(maximizedDesktopBounds({ width: 1440, height: 860 })).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 860,
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

describe("desktop window resizing and snapping", () => {
  const area = { width: 1440, height: 860 };
  const minimum = { width: 360, height: 260 };
  const origin = { x: 200, y: 100, width: 700, height: 500 };

  it("resizes from the left edge while keeping the right edge fixed", () => {
    expect(resizeDesktopBounds(origin, "w", { x: -50, y: 0 }, area, minimum)).toEqual({ x: 150, y: 100, width: 750, height: 500 });
  });

  it("resizes from the top-left corner and stops at the window minimum", () => {
    expect(resizeDesktopBounds(origin, "nw", { x: 600, y: 400 }, area, minimum)).toEqual({ x: 540, y: 340, width: 360, height: 260 });
  });

  it("keeps edge resizes inside the desktop", () => {
    expect(resizeDesktopBounds(origin, "se", { x: 2000, y: 2000 }, area, minimum)).toEqual({ x: 200, y: 100, width: 1240, height: 760 });
    expect(resizeDesktopBounds(origin, "n", { x: 0, y: -500 }, area, minimum)).toEqual({ x: 200, y: 0, width: 700, height: 600 });
  });

  it("offers maximize at the top edge and halves at the sides", () => {
    expect(desktopSnapZoneAt({ x: 700, y: 2 }, area)).toBe("maximize");
    expect(desktopSnapZoneAt({ x: 3, y: 400 }, area)).toBe("left");
    expect(desktopSnapZoneAt({ x: 1437, y: 400 }, area)).toBe("right");
    expect(desktopSnapZoneAt({ x: 700, y: 400 }, area)).toBeNull();
  });

  it("splits the desktop into two halves that cover it exactly", () => {
    const left = snappedDesktopBounds("left", { width: 1441, height: 860 });
    const right = snappedDesktopBounds("right", { width: 1441, height: 860 });
    expect(left.width + right.width).toBe(1441);
    expect(right.x).toBe(left.width);
  });

  it("restores the previous size under the pointer when a snapped window is dragged away", () => {
    const snapped = snappedDesktopBounds("left", area);
    const pointer = { x: 540, y: 20 }; // three quarters across the snapped title bar
    const restored = unsnapDesktopBounds(snapped, origin, pointer, area, minimum);
    expect(restored.width).toBe(700);
    expect(restored.height).toBe(500);
    expect((pointer.x - restored.x) / restored.width).toBeCloseTo(0.75);
  });
});

describe("desktop layout persistence", () => {
  it("accepts only the current version with a window collection", () => {
    expect(isPersistedDesktopLayout({ version: 1, windows: [] })).toBe(true);
    expect(isPersistedDesktopLayout({ version: 2, windows: [] })).toBe(false);
    expect(isPersistedDesktopLayout({ version: 1, windows: null })).toBe(false);
  });

  it("accepts valid pinned service and Talome app snapshots", () => {
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
      apps: [],
      appIds: ["automations", "intelligence"],
      order: ["media", "assistant", "automations"],
    })).toBe(true);
    expect(isPersistedDesktopDock({
      version: 1,
      apps: [{ id: "sonarr", name: "Sonarr", url: "javascript:alert(1)" }],
    })).toBe(false);
    expect(isPersistedDesktopDock({
      version: 1,
      apps: [],
      appIds: ["automations", 42],
    })).toBe(false);
    expect(isPersistedDesktopDock({
      version: 1,
      apps: [],
      order: ["media", 42],
    })).toBe(false);
    expect(isPersistedDesktopDock({ version: 2, apps: [] })).toBe(false);
  });

  it("orders visible Dock apps from a saved preference and appends new apps", () => {
    expect(orderDesktopDockIds(
      ["files", "media", "assistant", "audiobooks"],
      ["audiobooks", "files", "missing", "audiobooks"],
    )).toEqual(["audiobooks", "files", "media", "assistant"]);
  });

  it("reorders Dock apps before or after a target", () => {
    const ids = ["files", "media", "assistant", "audiobooks"];
    expect(reorderDesktopDockIds(ids, "audiobooks", "media", "before")).toEqual([
      "files",
      "audiobooks",
      "media",
      "assistant",
    ]);
    expect(reorderDesktopDockIds(ids, "files", "assistant", "after")).toEqual([
      "media",
      "assistant",
      "files",
      "audiobooks",
    ]);
  });
});
