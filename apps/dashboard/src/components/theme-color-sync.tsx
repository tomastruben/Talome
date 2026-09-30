"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { applyThemeColor } from "@/lib/theme-color";

/**
 * The root layout's `viewport.themeColor` entries (keyed on
 * prefers-color-scheme) only cover first paint. Once next-themes resolves,
 * the status bar follows the theme chosen in Talome.
 */
export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();
  useEffect(() => {
    applyThemeColor(resolvedTheme);
  }, [resolvedTheme]);
  return null;
}
