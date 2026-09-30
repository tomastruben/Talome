/**
 * Browser and PWA status-bar colour per resolved theme (matches --background).
 * Plain module (not "use client") so the server root layout can read the
 * values for its first-paint `viewport.themeColor`.
 */
export const THEME_COLOR = {
  light: "#ffffff",
  dark: "#0a0a0a",
} as const;

/**
 * Sets every theme-color meta to the colour of the theme chosen in Talome
 * (next-themes' resolved theme), not the OS scheme the media queries follow.
 */
export function applyThemeColor(theme: string | undefined, doc: Document = document): void {
  if (theme !== "light" && theme !== "dark") return;
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
