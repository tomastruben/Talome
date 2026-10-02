/**
 * Browser and PWA status-bar colour per resolved theme (matches --background).
 * Plain module (not "use client") so the server root layout can read the
 * values for its first-paint `viewport.themeColor`.
 */
export const THEME_COLOR = {
  light: "#ffffff",
  dark: "#0a0a0a",
} as const;

type Theme = keyof typeof THEME_COLOR;

let chosenTheme: Theme | undefined;
let screenTheme: Theme | null = null;

/**
 * Sets every theme-color meta to the colour of the theme chosen in Talome
 * (next-themes' resolved theme), not the OS scheme the media queries follow.
 * While a screen holds its own colour (overrideThemeColor) the choice is kept
 * for later and the screen's colour stays.
 */
export function applyThemeColor(theme: string | undefined, doc: Document = document): void {
  if (theme !== "light" && theme !== "dark") return;
  chosenTheme = theme;
  writeThemeColor(screenTheme ?? theme, doc);
}

/**
 * A screen that is one colour whatever the theme (the sign-in screen is
 * dark) holds the status bar to it; null hands it back to the chosen theme.
 */
export function overrideThemeColor(theme: Theme | null, doc: Document = document): void {
  screenTheme = theme;
  const next = theme ?? chosenTheme;
  if (next) writeThemeColor(next, doc);
}

function writeThemeColor(theme: Theme, doc: Document): void {
  const color = THEME_COLOR[theme];
  const metas = doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
  if (metas.length === 0) {
    const meta = doc.createElement("meta");
    meta.name = "theme-color";
    meta.content = color;
    doc.head.appendChild(meta);
    return;
  }
  metas.forEach((meta) => {
    meta.content = color;
  });
}
