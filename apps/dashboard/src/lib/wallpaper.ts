/** Browser-local wallpaper choice shared by the desktop and the sign-in screen. */
export const DESKTOP_WALLPAPER_STORAGE_KEY = "talome-desktop-wallpaper-v1";

/** Shown on the sign-in screen before a wallpaper has been chosen on this device. */
export const DEFAULT_SIGN_IN_WALLPAPER = "/wallpapers/aurora.jpg";

/** The wallpaper picked on this device, if any. */
export function readStoredWallpaper(): string | undefined {
  try {
    return localStorage.getItem(DESKTOP_WALLPAPER_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
