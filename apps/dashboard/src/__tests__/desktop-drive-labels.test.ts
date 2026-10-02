/**
 * Desktop drive names must read on any wallpaper. White text with a shadow
 * straight on the photo measured below 3:1 on 35 of the 74 bundled
 * wallpapers, so the name sits on a flat pill of the thin material, whose
 * foreground text keeps 4.5:1 over any backdrop (design-contrast.test.tsx).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(__dirname, "..", path), "utf8");

describe("desktop drive labels", () => {
  it("sit on the thin glass with theme foreground text", () => {
    const icons = read("components/desktop/desktop-drive-icons.tsx");
    expect(icons).toMatch(/className="tm-glass tm-glass-label [^"]*text-foreground[^"]*"/);
    expect(icons).not.toMatch(/tm-on-wallpaper/);
  });

  it("the label pill is flat in both themes (the icon tile carries the lift)", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/\n\.tm-glass\.tm-glass-label \{\s*box-shadow: 0 0 0 1px/);
    expect(css).toMatch(/\n:root:not\(\.dark\) \.tm-glass\.tm-glass-label \{\s*box-shadow: 0 0 0 1px/);
    expect(css).not.toMatch(/\.tm-on-wallpaper/);
  });
});
