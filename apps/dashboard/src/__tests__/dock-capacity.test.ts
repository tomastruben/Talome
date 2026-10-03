import { describe, expect, it } from "vitest";
import { dockAppCapacity } from "@/lib/dock-capacity";

describe("dock overflow", () => {
  it("keeps the full dock when it fits and reserves More only when necessary", () => {
    expect(dockAppCapacity(946, 166, 8, true)).toBe(8);
    expect(dockAppCapacity(946, 166, 12, true)).toBe(8);
    expect(dockAppCapacity(1600, 166, 12, true)).toBe(12);
  });
  it("leaves room for the player and approval controls as the tray grows", () => {
    expect(dockAppCapacity(946, 400, 12, true)).toBeLessThan(dockAppCapacity(946, 166, 12, true));
  });
  it("reserves controls and magnification even with hundreds of apps", () => {
    for (const width of [768, 820, 946, 1024, 1440]) {
      const capacity = dockAppCapacity(width, 400, 200, true);
      expect(32 + 18 + 52 + 16 + 80 + 64 + 400 + (capacity + 1) * 52).toBeLessThanOrEqual(width);
    }
  });
  it("supports members without Settings and never returns negative capacity", () => {
    expect(dockAppCapacity(946, 166, 12, false)).toBeGreaterThan(dockAppCapacity(946, 166, 12, true));
    expect(dockAppCapacity(200, 400, 12, true)).toBe(0);
    expect(dockAppCapacity(946, 166, 0, true)).toBe(0);
  });
});
