import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const theme = vi.hoisted(() => ({ resolvedTheme: "dark" as string | undefined }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: theme.resolvedTheme }) }));

import { ThemeColorSync } from "@/components/theme-color-sync";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_COLOR, applyThemeColor, overrideThemeColor } from "@/lib/theme-color";

function addMeta(media: string, content: string) {
  const meta = document.createElement("meta");
  meta.name = "theme-color";
  meta.media = media;
  meta.content = content;
  document.head.appendChild(meta);
  return meta;
}

afterEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
});

describe("theme-color follows the theme chosen in Talome, not the OS", () => {
  it("overrides both media-keyed first-paint metas with the resolved theme's colour", () => {
    const lightOs = addMeta("(prefers-color-scheme: light)", THEME_COLOR.light);
    const darkOs = addMeta("(prefers-color-scheme: dark)", THEME_COLOR.dark);
    // Dark theme picked on a light-mode phone: the status bar must be dark.
    theme.resolvedTheme = "dark";
    const { rerender } = render(<ThemeColorSync />);
    expect(lightOs.content).toBe(THEME_COLOR.dark);
    expect(darkOs.content).toBe(THEME_COLOR.dark);

    theme.resolvedTheme = "light";
    rerender(<ThemeColorSync />);
    expect(lightOs.content).toBe(THEME_COLOR.light);
    expect(darkOs.content).toBe(THEME_COLOR.light);
  });

  it("adds a meta when none exists and ignores an unresolved theme", () => {
    applyThemeColor(undefined);
    expect(document.head.querySelector('meta[name="theme-color"]')).toBeNull();
    applyThemeColor("light");
    expect(document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content).toBe(THEME_COLOR.light);
  });

  it("lets the sign-in screen hold the status bar dark, then hands it back to the chosen theme", () => {
    const meta = addMeta("(prefers-color-scheme: light)", THEME_COLOR.light);
    applyThemeColor("light");
    overrideThemeColor("dark");
    expect(meta.content).toBe(THEME_COLOR.dark);
    // The theme resolving (or changing) underneath doesn't break the hold
    applyThemeColor("light");
    expect(meta.content).toBe(THEME_COLOR.dark);
    overrideThemeColor(null);
    expect(meta.content).toBe(THEME_COLOR.light);
  });

  it("draws the sign-in screen dark in both themes, like a lock screen", () => {
    const shell = readFileSync(join(__dirname, "../components/trust/auth-shell.tsx"), "utf8");
    expect(shell).toMatch(/<main[\s\S]*?className="dark relative h-dvh[^"]*\[color-scheme:dark\]/);
    expect(shell).toContain('overrideThemeColor("dark")');
    expect(shell).toContain("overrideThemeColor(null)");
    const css = readFileSync(join(__dirname, "../app/globals.css"), "utf8");
    // Light glass stops at the sign-in screen's dark scope, and its text has no light halo
    expect(css).toContain(":root:not(.dark) .tm-glass-dense:not(.dark *) {");
    expect(css).not.toMatch(/:root:not\(\.dark\) \.tm-on-scrim/);
  });
});
