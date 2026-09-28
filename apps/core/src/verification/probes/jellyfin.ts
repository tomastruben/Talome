/**
 * Jellyfin probe — API key valid, libraries configured, and every library
 * folder actually exists inside the Jellyfin container.
 */

import { z } from "zod";
import { appRequest, type ProbeCallContext } from "../http.js";
import { outcome, type CheckDefinition } from "../runner.js";
import type { CheckOutcome } from "../types.js";
import { apiReachableCheck, httpFailure, listPreview, parseOr, plural } from "./common.js";

const systemInfoSchema = z.object({ Version: z.string().optional(), ServerName: z.string().optional() });

const virtualFoldersSchema = z.array(
  z.object({
    Name: z.string().optional(),
    CollectionType: z.string().nullable().optional(),
    Locations: z.array(z.string()).optional(),
  }),
);
export type JellyfinLibrary = z.infer<typeof virtualFoldersSchema>[number];

const countsSchema = z.object({
  MovieCount: z.number().optional(),
  SeriesCount: z.number().optional(),
  EpisodeCount: z.number().optional(),
  SongCount: z.number().optional(),
  BookCount: z.number().optional(),
});

export async function getJellyfinLibraries(ctx: ProbeCallContext): Promise<{ libraries: JellyfinLibrary[] | null; error?: CheckOutcome }> {
  const res = await appRequest(ctx, "jellyfin", "/Library/VirtualFolders");
  if (!res.ok) return { libraries: null, error: httpFailure(ctx, "jellyfin", res, "listing libraries") };
  const libraries = parseOr(virtualFoldersSchema, res.data);
  if (!libraries) return { libraries: null, error: outcome.fail("Jellyfin returned an unexpected library list.") };
  return { libraries };
}

/** Read-only existence check of a path inside the Jellyfin container (ValidateWritable=false). */
export async function jellyfinPathExists(ctx: ProbeCallContext, path: string): Promise<boolean | null> {
  const res = await appRequest(ctx, "jellyfin", "/Environment/ValidatePath", {
    method: "POST",
    body: { Path: path, ValidateWritable: false, IsFile: false },
  });
  if (res.ok) return true;
  if (res.status === 404 || res.status === 400) return false;
  return null;
}

export async function evaluateJellyfinLibraries(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const { libraries, error } = await getJellyfinLibraries(ctx);
  if (!libraries) return error!;
  if (libraries.length === 0) {
    return outcome.fail(
      "Jellyfin has no libraries, so there is nothing to stream.",
      "Add a library pointing at your media folder — ask the assistant to run jellyfin_add_library.",
    );
  }
  const empty = libraries.filter((l) => (l.Locations ?? []).length === 0);
  const names = libraries.map((l) => `${l.Name ?? "Unnamed"}${l.CollectionType ? ` (${l.CollectionType})` : ""}`);

  const countsRes = await appRequest(ctx, "jellyfin", "/Items/Counts");
  const counts = countsRes.ok ? parseOr(countsSchema, countsRes.data) : null;
  const countText = counts
    ? ` — ${[
        counts.MovieCount ? plural(counts.MovieCount, "movie") : null,
        counts.SeriesCount ? plural(counts.SeriesCount, "series", "series") : null,
        counts.EpisodeCount ? plural(counts.EpisodeCount, "episode") : null,
        counts.SongCount ? plural(counts.SongCount, "song") : null,
        counts.BookCount ? plural(counts.BookCount, "book") : null,
      ].filter(Boolean).join(", ") || "no items scanned yet"}`
    : "";

  if (empty.length > 0) {
    return outcome.warn(
      `${plural(libraries.length, "library", "libraries")} (${listPreview(names)}), but ${listPreview(empty.map((l) => l.Name ?? "Unnamed"))} ${empty.length === 1 ? "has" : "have"} no folder${countText}.`,
      "Add a media folder to the empty library in Jellyfin → Dashboard → Libraries.",
    );
  }
  return outcome.pass(`${plural(libraries.length, "library", "libraries")}: ${listPreview(names)}${countText}.`);
}

export async function evaluateJellyfinLibraryPaths(ctx: ProbeCallContext): Promise<CheckOutcome> {
  const { libraries, error } = await getJellyfinLibraries(ctx);
  if (!libraries) return error!;
  const locations = [...new Set(libraries.flatMap((l) => l.Locations ?? []))];
  if (locations.length === 0) return outcome.skip("No library folders to check.");

  const missing: string[] = [];
  const unknown: string[] = [];
  for (const loc of locations) {
    const exists = await jellyfinPathExists(ctx, loc);
    if (exists === false) missing.push(loc);
    else if (exists === null) unknown.push(loc);
  }
  if (missing.length > 0) {
    return outcome.fail(
      `Library ${missing.length === 1 ? "folder" : "folders"} missing inside the Jellyfin container: ${listPreview(missing)}.`,
      "The drive may be unmounted, or the folder isn't mounted into the Jellyfin container — check the drive and add_volume_mount, then restart Jellyfin.",
    );
  }
  if (unknown.length === locations.length) {
    return outcome.warn(`Could not confirm ${plural(locations.length, "library folder")} (Jellyfin did not answer the path check).`);
  }
  return outcome.pass(`All ${plural(locations.length - unknown.length, "library folder")} exist: ${listPreview(locations)}.`);
}

export function jellyfinChecks(): CheckDefinition[] {
  return [
    apiReachableCheck("jellyfin", "/System/Info", (data) => {
      const info = parseOr(systemInfoSchema, data);
      return `Jellyfin${info?.Version ? ` ${info.Version}` : ""}${info?.ServerName ? ` "${info.ServerName}"` : ""} answered and accepted the API key`;
    }),
    { id: "libraries", label: "Libraries configured", appId: "jellyfin", critical: true, dependsOn: ["api"], run: evaluateJellyfinLibraries },
    { id: "library-paths", label: "Library folders exist", appId: "jellyfin", dependsOn: ["libraries"], timeoutMs: 15_000, run: evaluateJellyfinLibraryPaths },
  ];
}
