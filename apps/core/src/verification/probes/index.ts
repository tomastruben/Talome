import type { CheckDefinition } from "../runner.js";
import { arrChecks } from "./arr.js";
import { immichChecks } from "./immich.js";
import { jellyfinChecks } from "./jellyfin.js";
import { prowlarrChecks } from "./prowlarr.js";
import { qbittorrentChecks } from "./qbittorrent.js";
import { seerrChecks } from "./seerr.js";
import { audiobookshelfChecks, homeAssistantChecks } from "./simple-apps.js";

/** App id → factory for that app's semantic checks. */
export const APP_PROBES: Record<string, () => CheckDefinition[]> = {
  jellyfin: jellyfinChecks,
  sonarr: () => arrChecks("sonarr"),
  radarr: () => arrChecks("radarr"),
  readarr: () => arrChecks("readarr"),
  prowlarr: prowlarrChecks,
  qbittorrent: qbittorrentChecks,
  immich: immichChecks,
  audiobookshelf: audiobookshelfChecks,
  homeassistant: homeAssistantChecks,
  overseerr: () => seerrChecks("overseerr"),
  jellyseerr: () => seerrChecks("jellyseerr"),
};

export function getAppProbe(appId: string): (() => CheckDefinition[]) | undefined {
  const id = appId.toLowerCase();
  // Own keys only — "constructor"/"__proto__" must not resolve to Object internals.
  return Object.hasOwn(APP_PROBES, id) ? APP_PROBES[id] : undefined;
}

export function listProbedApps(): string[] {
  return Object.keys(APP_PROBES);
}
