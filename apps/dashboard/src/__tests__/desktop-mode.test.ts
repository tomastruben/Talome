import { describe, expect, it } from "vitest";
import { canUseDesktopMode } from "@/hooks/use-desktop-mode";

describe("desktop mode device eligibility", () => {
  it("supports a conventional desktop pointer layout", () => {
    expect(canUseDesktopMode({
      width: 1440,
      height: 900,
      hasHoverCapablePointer: true,
      hasFinePointer: true,
    })).toBe(true);
  });

  it.each([
    ["iPad Pro with Magic Keyboard", 1024, 1366, true, true],
    ["iPad Pro with Pencil hover", 1366, 1024, true, false],
    ["iPad mini with a paired mouse", 744, 1133, true, true],
  ])("supports %s", (_label, width, height, hasHoverCapablePointer, hasFinePointer) => {
    expect(canUseDesktopMode({
      width,
      height,
      hasHoverCapablePointer,
      hasFinePointer,
    })).toBe(true);
  });

  it.each([
    ["touch-only iPad", 1024, 1366, false, false],
    ["phone portrait with a fine pointer", 430, 932, true, true],
    ["phone landscape with a fine pointer", 932, 430, true, true],
    ["narrow iPad split view", 600, 900, true, true],
  ])("keeps %s in classic mode", (
    _label,
    width,
    height,
    hasHoverCapablePointer,
    hasFinePointer,
  ) => {
    expect(canUseDesktopMode({
      width,
      height,
      hasHoverCapablePointer,
      hasFinePointer,
    })).toBe(false);
  });
});
