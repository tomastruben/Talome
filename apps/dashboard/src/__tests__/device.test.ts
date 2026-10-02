import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { APPLE_STATUS_BAR_STYLE, FRAME_SCRIPT } from "@/lib/device";
import { proxy } from "@/proxy";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");

describe("a Home Screen web app on iOS and iPadOS", () => {
  it("gets a solid status bar, so nothing sits in the band iOS blurs under a translucent one", () => {
    expect(APPLE_STATUS_BAR_STYLE).toBe("default");
    const layout = read("app/layout.tsx");
    expect(layout).toContain("statusBarStyle: APPLE_STATUS_BAR_STYLE");
    expect(layout).not.toContain("black-translucent");
  });

  it("doesn't size anything for a status bar drawn over the page", () => {
    const css = read("app/globals.css");
    expect(css).not.toContain("data-status-bar");
    expect(FRAME_SCRIPT).not.toContain("data-status-bar");
    // The home indicator still overlays: the Dock and its reserve clear it
    expect(css).toMatch(/--desktop-dock-reserve: calc\(4\.75rem \+ env\(safe-area-inset-bottom, 0px\)\)/);
    expect(css).toMatch(/\[data-desktop-dock-band\] \{\s*padding-bottom: calc\(0\.25rem \+ env\(safe-area-inset-bottom, 0px\)\)/);
  });

  it("marks a page running inside a desktop window", () => {
    expect(FRAME_SCRIPT).toContain('window.self!==window.top');
    expect(FRAME_SCRIPT).toContain('"data-embedded-frame"');
    expect(read("app/layout.tsx")).toContain("__html: FRAME_SCRIPT");
  });

  it("lets the keyboard go with the lock screen when signing in", () => {
    const login = read("app/login/page.tsx");
    const goOn = login.slice(login.indexOf("async function goOn"));
    expect(goOn.slice(0, goOn.indexOf("router.replace"))).toContain("document.activeElement.blur()");
  });
});

describe("files fetched before anyone signs in", () => {
  const request = (path: string) => new NextRequest(new URL(path, "http://talome.local"));

  it.each(["/apple-icon.png", "/icon.svg", "/icon-192.png", "/icon-512.png", "/favicon.png", "/sw.js"])(
    "serves %s without a session, so Add to Home Screen gets the real icon",
    (path) => {
      const response = proxy(request(path));
      expect(response.headers.get("location")).toBeNull();
    },
  );

  it("still sends a signed-out page request to sign-in", () => {
    const response = proxy(request("/dashboard"));
    expect(response.headers.get("location")).toContain("/login?from=%2Fdashboard");
  });
});
