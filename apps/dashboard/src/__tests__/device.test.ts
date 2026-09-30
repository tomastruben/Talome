import { describe, expect, it } from "vitest";
import { hasOverlaidStatusBar, isAppleTouchDevice } from "@/lib/device";

const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAC_UA = IPAD_DESKTOP_UA;
const WINDOWS_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("status bar detection", () => {
  it("recognises an iPad that reports itself as a Mac by its touch screen", () => {
    expect(isAppleTouchDevice({ userAgent: IPAD_DESKTOP_UA, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isAppleTouchDevice({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
  });

  it("leaves room only for an iPad opened full screen from the Home Screen", () => {
    const ipad = { userAgent: IPAD_DESKTOP_UA, platform: "MacIntel", maxTouchPoints: 5 };
    expect(hasOverlaidStatusBar({ ...ipad, standalone: true, displayModeStandalone: true })).toBe(true);
    // The same iPad in a Safari tab: Safari's own bars sit above the page
    expect(hasOverlaidStatusBar({ ...ipad, standalone: false, displayModeStandalone: false })).toBe(false);
  });

  it("uses the whole screen on desktops, installed or not", () => {
    expect(hasOverlaidStatusBar({ userAgent: MAC_UA, platform: "MacIntel", maxTouchPoints: 0, displayModeStandalone: true })).toBe(false);
    expect(hasOverlaidStatusBar({ userAgent: WINDOWS_UA, platform: "Win32", maxTouchPoints: 10, displayModeStandalone: true })).toBe(false);
  });
});
