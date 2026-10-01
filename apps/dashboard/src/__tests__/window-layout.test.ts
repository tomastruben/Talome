import { describe, expect, it } from "vitest";
import { windowContentLayout } from "@/lib/window-layout";

describe("windowContentLayout", () => {
  it("lets apps that own their panes fill the window", () => {
    for (const path of [
      "/dashboard/files",
      "/dashboard/files/shared",
      "/dashboard/assistant",
      "/dashboard/assistant/abc123",
      "/dashboard/terminal",
      "/dashboard/terminal/session/1",
      "/dashboard/player",
      "/dashboard/player/42",
    ]) {
      expect(windowContentLayout(path), path).toBe("fill");
    }
  });

  it("pads and scrolls every other page", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/media",
      "/dashboard/apps",
      "/dashboard/apps/talome/jellyfin",
      "/dashboard/containers",
      "/dashboard/settings",
      "/dashboard/settings/security",
      // A prefix is not a route: only the route itself and its sub-paths fill
      "/dashboard/filesystem",
      "/dashboard/players",
    ]) {
      expect(windowContentLayout(path), path).toBe("page");
    }
  });
});
