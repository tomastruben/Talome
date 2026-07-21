import { describe, expect, it } from "vitest";
import {
  continueWatchingFallbackRoute,
  resolveContinueWatchingRoute,
  type MediaLibraryRouteItem,
} from "@/lib/media-navigation";

const library: MediaLibraryRouteItem[] = [
  { id: 101, title: "The Matrix", type: "movie", year: 1999 },
  { id: 102, title: "Kreta", type: "movie", year: 1998 },
  { id: 103, title: "Léon: The Professional", type: "movie", year: 1994 },
  { id: 201, title: "Twin Peaks", type: "tv", year: 1990 },
  { id: 202, title: "Twin Peaks", type: "tv", year: 2017 },
];

describe("Continue Watching navigation", () => {
  it("resolves movies and TV shows to their Talome detail routes", () => {
    expect(resolveContinueWatchingRoute(
      { title: "The Matrix", type: "movie", year: 1999 },
      library,
    )).toBe("/dashboard/media/movie/101");
    expect(resolveContinueWatchingRoute(
      { title: "Twin Peaks", type: "tv", year: 2017 },
      library,
    )).toBe("/dashboard/media/tv/202");
  });

  it("matches Plex titles that include a trailing release year", () => {
    expect(resolveContinueWatchingRoute(
      { title: "Kreta 1998", type: "movie", year: 1998 },
      library,
    )).toBe("/dashboard/media/movie/102");
    expect(resolveContinueWatchingRoute(
      { title: "Leon – The Professional", type: "movie", year: 1994 },
      library,
    )).toBe("/dashboard/media/movie/103");
  });

  it("falls back to the matching library search when no Talome id is available", () => {
    const item = { title: "Unmatched Film", type: "movie" as const };
    expect(resolveContinueWatchingRoute(item, library)).toBeNull();
    expect(continueWatchingFallbackRoute(item)).toBe(
      "/dashboard/media?tab=movies&search=Unmatched+Film",
    );
  });
});
