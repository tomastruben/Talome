import { describe, expect, it } from "vitest";
import { publicSignInWallpaper } from "../auth/sign-in-wallpaper.js";

describe("signed-out wallpaper", () => {
  it("shares only bundled public artwork", () => {
    expect(publicSignInWallpaper(JSON.stringify({ desktopWallpaper: { wallpaperUrl: "/wallpapers/generated/talome-07.jpg" } }))).toBe("/wallpapers/generated/talome-07.jpg");
    expect(publicSignInWallpaper(JSON.stringify({ desktopWallpaper: { wallpaperUrl: "/wallpapers/alpenglow.jpg" } }))).toBe("/wallpapers/alpenglow.jpg");
  });
  it("never exposes custom photos or remote URLs before sign-in", () => {
    for (const wallpaperUrl of ["data:image/png;base64,private", "https://photos.example/private.jpg", "/api/files/private.jpg", "/wallpapers/../private.jpg", "//example.com/image.jpg"]) {
      expect(publicSignInWallpaper(JSON.stringify({ desktopWallpaper: { wallpaperUrl } }))).toBeNull();
    }
  });
  it("tolerates missing, malformed and default preferences", () => {
    for (const preferences of [null, "{", "{}", '{"desktopWallpaper":{"wallpaperUrl":null}}']) expect(publicSignInWallpaper(preferences)).toBeNull();
  });
});
