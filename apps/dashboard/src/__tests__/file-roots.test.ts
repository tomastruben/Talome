import { describe, expect, it } from "vitest";
import { getVisibleFileRoots, type FileManagerRoot } from "@/lib/file-roots";

const emptyTalomeRoot: FileManagerRoot = {
  id: "talome-files",
  path: "/Users/test/.talome/files",
  label: "Talome Files",
  kind: "talome-files",
  isEmpty: true,
};

const mediaHubRoot: FileManagerRoot = {
  id: "external:/Volumes/Media Hub",
  path: "/Volumes/Media Hub",
  label: "Media Hub",
  kind: "external",
};

describe("getVisibleFileRoots", () => {
  it("hides empty Talome Files storage when another drive is available", () => {
    expect(getVisibleFileRoots([emptyTalomeRoot, mediaHubRoot], { keepTalomeFallback: true }))
      .toEqual([mediaHubRoot]);
  });

  it("hides empty Talome Files storage from desktop drive icons", () => {
    expect(getVisibleFileRoots([emptyTalomeRoot, mediaHubRoot])).toEqual([mediaHubRoot]);
  });

  it("keeps the secure upload location as a fallback when it is the only root", () => {
    expect(getVisibleFileRoots([emptyTalomeRoot], { keepTalomeFallback: true }))
      .toEqual([emptyTalomeRoot]);
  });

  it("shows Talome Files automatically when it contains user data", () => {
    const populatedTalomeRoot = { ...emptyTalomeRoot, isEmpty: false };
    expect(getVisibleFileRoots([populatedTalomeRoot, mediaHubRoot]))
      .toEqual([populatedTalomeRoot, mediaHubRoot]);
  });
});
