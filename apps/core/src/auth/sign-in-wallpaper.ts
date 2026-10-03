import { z } from "zod";

// Only bundled public artwork can be the server's signed-out backdrop.
// Uploaded photos, data URLs and remote URLs stay private to their browser.
const preferencesSchema = z.object({
  desktopWallpaper: z.object({
    wallpaperUrl: z.string().regex(/^\/wallpapers\/(?:[a-z][a-z0-9-]*|generated\/talome-\d{2})\.jpg$/),
  }),
});

export function publicSignInWallpaper(preferences: string | null): string | null {
  try {
    const parsed = preferencesSchema.safeParse(JSON.parse(preferences ?? "{}"));
    return parsed.success ? parsed.data.desktopWallpaper.wallpaperUrl : null;
  } catch {
    return null;
  }
}
