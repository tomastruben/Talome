import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { contrast, over, parseColor, readTokens } from "./helpers/contrast";

/*
 * Launchpad is a panel of the regular glass material (.tm-glass-dense) in the
 * top-level document, so its blur sees the wallpaper and the windows. Its text
 * is foreground or muted-foreground only, on two fills: the hover tint and the
 * selection plate. Muted text never sits on the plate (the selected tile's
 * second line switches to foreground), so only foreground is held there.
 * Belongs with design-contrast.test.tsx §"desktop window glass"; kept apart
 * while another change edits that file.
 */

const SRC = join(__dirname, "..");
const read = (path: string) => readFileSync(join(SRC, path), "utf8");
const css = read("app/globals.css");
const light = readTokens(css, ":root");
const dark = readTokens(css, ".dark", light);
const themes = { light, dark } as const;
const color = (tokens: Record<string, string>, name: string) => parseColor(tokens[name]);
const launchpad = read("components/desktop/desktop-launchpad.tsx");

/** The declarations of the first unlayered rule whose selector is exactly `selector`. */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`No ${selector} rule`);
  return match[2];
}

function material(selector: string) {
  const body = ruleBody(selector);
  const tint = /background:\s*color-mix\(in oklch, var\((--[\w-]+)\) (\d+)%, transparent\)/.exec(body);
  const filter = /(?<!-webkit-)backdrop-filter:\s*([^;]+);/.exec(body)?.[1] ?? "";
  return {
    token: tint?.[1] ?? "",
    alpha: Number(tint?.[2]) / 100,
    brightness: Number(/brightness\(([\d.]+)\)/.exec(filter)?.[1] ?? 1),
  };
}

const regular = { dark: material(".tm-glass-dense"), light: material(":root:not(.dark) .tm-glass-dense") };
/** The worst backdrop for each theme's text: pure white behind dark glass, pure black behind light. */
const worstBackdrop = { dark: 1, light: 0 } as const;
const gray = (v: number) => ({ r: v, g: v, b: v, a: 1 });
const glass = (theme: "dark" | "light") =>
  over(
    color(themes[theme], regular[theme].token),
    gray(Math.min(1, worstBackdrop[theme] * regular[theme].brightness)),
    regular[theme].alpha,
  );
/** An alpha step read from the component's own classes, so the model can't drift from them. */
const alpha = (pattern: RegExp) => {
  const match = pattern.exec(launchpad);
  expect(match, String(pattern)).not.toBeNull();
  return Number(match![1]) / 100;
};

describe("Launchpad on the regular glass", () => {
  it("is the regular material, with no tint or fill of its own", () => {
    expect(launchpad).toMatch(/"tm-glass-dense fixed /);
    expect(launchpad).not.toMatch(/bg-surface-|bg-scrim|bg-card\b|bg-background\/(?!70\b)/);
    expect(regular.dark.token).toBe("--card");
    expect(regular.light.token).toBe("--card");
  });

  it("keeps foreground text at AA on the selection plate over the worst wallpaper, in both themes", () => {
    const plate = alpha(/layoutId="launchpad-selection"[\s\S]*?\bbg-foreground\/(\d+)\b/);
    for (const theme of ["dark", "light"] as const) {
      const fg = color(themes[theme], "--foreground");
      expect(contrast(fg, over(fg, glass(theme), plate)), `${theme} label on plate`).toBeGreaterThanOrEqual(4.5);
    }
    // The selected tile's second line is foreground, never muted, on the plate
    expect(launchpad).toMatch(/selected \? "text-foreground" : "text-muted-foreground"/);
  });

  it("keeps labels and muted second lines at AA on a hovered tile", () => {
    const hover = alpha(/const TILE =\s*"[^"]*\bhover:bg-foreground\/(\d+)\b/);
    for (const theme of ["dark", "light"] as const) {
      const fg = color(themes[theme], "--foreground");
      const hovered = over(fg, glass(theme), hover);
      expect(contrast(fg, hovered), `${theme} label on hover`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color(themes[theme], "--muted-foreground"), hovered), `${theme} muted on hover`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps a hidden tile's name and second line at AA in Customize: only its icon dims", () => {
    // A hidden tile is a live toggle (aria-pressed), not a disabled control, so
    // its text gets no exemption: no opacity on the button, the dim is the icon's
    const toggle = /aria-pressed=\{!entry\.hidden\}[\s\S]*?className=\{([^}]*)\}/.exec(launchpad);
    expect(toggle, "Customize toggle").not.toBeNull();
    expect(toggle![1]).not.toMatch(/opacity-/);
    expect(launchpad).toMatch(/editing && entry\.hidden \? "opacity-45 grayscale"/);
    const hover = alpha(/const TILE =\s*"[^"]*\bhover:bg-foreground\/(\d+)\b/);
    for (const theme of ["dark", "light"] as const) {
      const fg = color(themes[theme], "--foreground");
      const muted = color(themes[theme], "--muted-foreground");
      for (const [state, surface] of [["at rest", glass(theme)], ["hovered", over(fg, glass(theme), hover)]] as const) {
        expect(contrast(fg, surface), `${theme} hidden name ${state}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(muted, surface), `${theme} hidden second line ${state}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
