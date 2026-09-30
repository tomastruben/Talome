import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const theme = vi.hoisted(() => ({ resolvedTheme: "dark" as string | undefined }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: theme.resolvedTheme }) }));

import { ThemeColorSync } from "@/components/theme-color-sync";
import { THEME_COLOR, applyThemeColor } from "@/lib/theme-color";

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
});
