import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const css = read("app/globals.css");

/** The body of the first rule whose selector list starts with `start` */
function ruleAfter(start: string): { selector: string; body: string } {
  const at = css.indexOf(start);
  if (at < 0) throw new Error(`No rule starting ${start}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  return { selector: css.slice(at, open), body: css.slice(open + 1, close) };
}

describe("shapes in a desktop window", () => {
  it("rounds windows rounded-2xl and the inset sidebar concentrically, rounded-lg", () => {
    expect(read("components/desktop/desktop-window.tsx")).toContain('"rounded-2xl border"');
    // 8px in (m-2) from an 18px corner: 10px
    expect(read("components/ui/source-list.tsx")).toMatch(/tm-window-sidebar m-2 mr-0 [^"]*rounded-lg/);
  });

  it("makes single-line controls capsules, with the window's radius, and keeps multi-line fields rectangles", () => {
    const capsules = ruleAfter(":is(.tm-window-content, [data-window-sidebar]) :is(\n  [data-slot=\"button\"]");
    for (const slot of ["button", "input", "select-trigger", "input-group", "toggle", "toggle-group", "toggle-group-item", "tabs-list"]) {
      expect(capsules.selector, slot).toContain(`[data-slot="${slot}"]`);
    }
    expect(capsules.selector).toContain('[data-slot="input-group"]:not(:has(textarea))');
    expect(capsules.selector).toContain('[data-slot="button"]:not([data-variant="link"])');
    expect(capsules.body).toMatch(/border-radius: var\(--radius-2xl\)/);
    expect(ruleAfter(':is(.tm-window-content, [data-window-sidebar]) [data-slot="textarea"]').body).toMatch(/border-radius: var\(--radius-lg\)/);
  });

  it("gives every toolbar control one 32px height, 44px on touch", () => {
    const height = ruleAfter('.tm-window-unified-toolbar :is([data-slot="button"]');
    expect(height.body).toMatch(/height: 2rem/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{\s*\.tm-window-unified-toolbar :is[\s\S]*?height: 2\.75rem/);
  });

  it("ends the toolbar 10px from the edge, as far as its capsules sit from the top", () => {
    expect(ruleAfter(".tm-window-unified-toolbar {").body).toMatch(/padding-inline: var\(--window-controls-inset\) 0\.625rem/);
    // Text verbs at the trailing end are capsules too
    expect(read("components/desktop/window-toolbar.tsx")).not.toMatch(/TRAILING_ACTION_CLASS =\s*"[^"]*rounded-md/);
  });

  it("shows the sidebar from a 48rem window, where the content keeps about the width a 560px window has", () => {
    expect(css).toContain("@container window (width >= 48rem)");
    const sidebar = 8 + 1 + 13 * 16 + 1; // inset, hairline, w-52, hairline
    expect(48 * 16 - sidebar).toBeGreaterThanOrEqual(548);
  });

  it("opens apps at a roomy size, so a window with a sidebar opens with it showing", () => {
    const source = read("components/desktop/desktop-experience.tsx");
    expect(source).toMatch(/const DEFAULT_APP_WINDOW = \{ width: 880, height: 600 \}/);
    expect(source).toMatch(/media: \{ width: 1000, height: 660 \}/);
  });
});
