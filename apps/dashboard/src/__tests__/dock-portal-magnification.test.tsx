/**
 * Panels opened from the Dock (Control Center, notifications, the Talome
 * menu) render in portals, and React bubbles their pointer events through the
 * Dock's tree. Hovering an open panel must not drive the Dock's magnification.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(__dirname, "..", "components/desktop/desktop-experience.tsx"), "utf8");

describe("Dock magnification ignores portalled panels", () => {
  it("only pointer moves over the Dock itself set the magnification pointer", () => {
    const handler = source.slice(source.indexOf("onPointerMove={(event) => {"), source.indexOf("onPointerLeave={() => dockPointerX.set"));
    expect(handler).toMatch(/event\.currentTarget\.contains\(event\.target as Node\)/);
    // Pointing into a panel settles the Dock rather than freezing the last position
    expect(handler).toMatch(/dockPointerX\.set\(Number\.POSITIVE_INFINITY\);\s*return;/);
  });
});
