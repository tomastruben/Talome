/**
 * Shared fixtures for outcome-probe tests: a fake HTTP router standing in for
 * every app API, plus a healthy media/photo setup that individual tests break.
 * No real network, Docker or settings are touched.
 */

import type { MountInfo, ProbeEnvDeps } from "../verification/env.js";

export interface MockResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

export function jsonResponse(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json", ...extraHeaders }),
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

export function textResponse(body: string, status = 200, extraHeaders: Record<string, string> = {}): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "text/plain", ...extraHeaders }),
    json: async () => JSON.parse(body),
    text: async () => body,
  };
}

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export type RouteHandler = MockResponse | ((url: URL, init: RequestInit) => MockResponse | Promise<MockResponse>);

/**
 * Build a fetch replacement from "METHOD http://host:port/path" → handler.
 * Query strings are ignored for matching (handlers get the full URL).
 * Unknown routes answer 404. A handler of "hang" never answers until aborted.
 */
export function createRouter(routes: Record<string, RouteHandler | "hang">) {
  const calls: RecordedCall[] = [];
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((v, k) => { headers[k] = v; });
    calls.push({ method, url: url.toString(), headers, body: typeof init.body === "string" ? init.body : undefined });

    const key = `${method} ${url.origin}${url.pathname}`;
    const handler = routes[key];
    if (handler === "hang") {
      return new Promise((_resolve, reject) => {
        const signal = init.signal;
        if (signal?.aborted) reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    }
    if (!handler) return jsonResponse({ message: "Not Found" }, 404);
    return typeof handler === "function" ? handler(url, init) : handler;
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, calls };
}

export const SECRETS = {
  sonarr: "SONARR-SECRET-KEY-1234567890",
  radarr: "RADARR-SECRET-KEY-0987654321",
  prowlarr: "PROWLARR-SECRET-KEY-555",
  qbt: "QBT-PASSWORD-999",
  jellyfin: "JELLYFIN-TOKEN-4242",
  overseerr: "OVERSEERR-KEY-7777",
  immich: "IMMICH-KEY-31337",
  abs: "ABS-TOKEN-2468",
  hass: "HASS-LONG-LIVED-TOKEN-1357",
  sid: "SESSION-COOKIE-ABCDEF",
};

export const URLS = {
  sonarr: "http://sonarr:8989",
  radarr: "http://radarr:7878",
  prowlarr: "http://prowlarr:9696",
  qbt: "http://qbittorrent:8080",
  jellyfin: "http://jellyfin:8096",
  overseerr: "http://overseerr:5055",
  immich: "http://immich:2283",
  abs: "http://audiobookshelf:13378",
  hass: "http://homeassistant:8123",
};

export function mediaSettings(): Record<string, string> {
  return {
    sonarr_url: URLS.sonarr,
    sonarr_api_key: SECRETS.sonarr,
    radarr_url: URLS.radarr,
    radarr_api_key: SECRETS.radarr,
    prowlarr_url: URLS.prowlarr,
    prowlarr_api_key: SECRETS.prowlarr,
    qbittorrent_url: URLS.qbt,
    qbittorrent_password: SECRETS.qbt,
    jellyfin_url: URLS.jellyfin,
    jellyfin_api_key: SECRETS.jellyfin,
    overseerr_url: URLS.overseerr,
    overseerr_api_key: SECRETS.overseerr,
  };
}

const GB = 1024 ** 3;

function arrRoutes(app: "sonarr" | "radarr", root: string, category: string, categoryField: string): Record<string, RouteHandler> {
  const base = URLS[app];
  const existing = new Set(["/downloads", root, "/"]);
  return {
    [`GET ${base}/api/v3/system/status`]: jsonResponse({ version: app === "sonarr" ? "4.0.14" : "5.21.1" }),
    [`GET ${base}/api/v3/rootfolder`]: jsonResponse([{ id: 1, path: root, accessible: true, freeSpace: 500 * GB }]),
    [`GET ${base}/api/v3/downloadclient`]: jsonResponse([
      {
        id: 1,
        name: "qBittorrent",
        enable: true,
        protocol: "torrent",
        implementation: "QBittorrent",
        fields: [
          { name: "host", value: "qbittorrent" },
          { name: "port", value: 8080 },
          { name: "username", value: "admin" },
          { name: "password", value: SECRETS.qbt },
          { name: categoryField, value: category },
        ],
      },
    ]),
    [`GET ${base}/api/v3/health`]: jsonResponse([]),
    [`GET ${base}/api/v3/indexer`]: jsonResponse([
      { name: "Nyaa (Prowlarr)", enableRss: true, enableAutomaticSearch: true, enableInteractiveSearch: true, protocol: "torrent" },
    ]),
    [`GET ${base}/api/v3/remotepathmapping`]: jsonResponse([]),
    [`GET ${base}/api/v3/filesystem`]: (url) => {
      const p = (url.searchParams.get("path") ?? "").replace(/\/+$/, "") || "/";
      return existing.has(p)
        ? jsonResponse({ parent: "/", directories: [], files: [] })
        : jsonResponse({ directories: [], files: [] });
    },
    [`POST ${base}/api/v3/downloadclient/test`]: jsonResponse({}),
  };
}

/** A fully working media stack. */
export function healthyMediaRoutes(): Record<string, RouteHandler | "hang"> {
  return {
    ...arrRoutes("sonarr", "/tv", "tv-sonarr", "tvCategory"),
    ...arrRoutes("radarr", "/movies", "radarr", "movieCategory"),
    // Prowlarr
    [`GET ${URLS.prowlarr}/api/v1/system/status`]: jsonResponse({ version: "1.31.2" }),
    [`GET ${URLS.prowlarr}/api/v1/indexer`]: jsonResponse([{ name: "Nyaa", enable: true }]),
    [`GET ${URLS.prowlarr}/api/v1/indexerstatus`]: jsonResponse([]),
    [`GET ${URLS.prowlarr}/api/v1/applications`]: jsonResponse([
      { name: "Sonarr", implementation: "Sonarr", syncLevel: "fullSync" },
      { name: "Radarr", implementation: "Radarr", syncLevel: "fullSync" },
    ]),
    [`GET ${URLS.prowlarr}/api/v1/health`]: jsonResponse([]),
    // qBittorrent
    [`POST ${URLS.qbt}/api/v2/auth/login`]: textResponse("Ok.", 200, { "set-cookie": `SID=${SECRETS.sid}; HttpOnly; path=/` }),
    [`GET ${URLS.qbt}/api/v2/app/version`]: textResponse("v5.0.4"),
    [`GET ${URLS.qbt}/api/v2/app/preferences`]: jsonResponse({ save_path: "/downloads/" }),
    [`GET ${URLS.qbt}/api/v2/torrents/categories`]: jsonResponse({ "tv-sonarr": { name: "tv-sonarr", savePath: "" }, radarr: { name: "radarr", savePath: "" } }),
    // Jellyfin
    [`GET ${URLS.jellyfin}/System/Info`]: jsonResponse({ Version: "10.10.6", ServerName: "home" }),
    [`GET ${URLS.jellyfin}/Library/VirtualFolders`]: jsonResponse([
      { Name: "Shows", CollectionType: "tvshows", Locations: ["/data/media/tv"] },
      { Name: "Movies", CollectionType: "movies", Locations: ["/data/media/movies"] },
    ]),
    [`GET ${URLS.jellyfin}/Items/Counts`]: jsonResponse({ MovieCount: 12, SeriesCount: 3, EpisodeCount: 40 }),
    [`POST ${URLS.jellyfin}/Environment/ValidatePath`]: textResponse("", 204),
    // Overseerr
    [`GET ${URLS.overseerr}/api/v1/status`]: jsonResponse({ version: "1.33.2" }),
    [`GET ${URLS.overseerr}/api/v1/settings/main`]: jsonResponse({ applicationTitle: "Overseerr" }),
    [`GET ${URLS.overseerr}/api/v1/settings/jellyfin`]: jsonResponse({ ip: "jellyfin", port: 8096, libraries: [{ name: "Shows", enabled: true }, { name: "Movies", enabled: true }] }),
    [`GET ${URLS.overseerr}/api/v1/settings/sonarr`]: jsonResponse([{ id: 0, name: "Sonarr", hostname: "sonarr", port: 8989, apiKey: SECRETS.sonarr, isDefault: true, is4k: false }]),
    [`GET ${URLS.overseerr}/api/v1/settings/radarr`]: jsonResponse([{ id: 0, name: "Radarr", hostname: "radarr", port: 7878, apiKey: SECRETS.radarr, isDefault: true, is4k: false }]),
    [`POST ${URLS.overseerr}/api/v1/settings/sonarr/test`]: jsonResponse({ profiles: [] }),
    [`POST ${URLS.overseerr}/api/v1/settings/radarr/test`]: jsonResponse({ profiles: [] }),
  };
}

export function healthyMounts(): Record<string, MountInfo[]> {
  return {
    sonarr: [
      { source: "/srv/media/tv", destination: "/tv" },
      { source: "/srv/downloads", destination: "/downloads" },
    ],
    radarr: [
      { source: "/srv/media/movies", destination: "/movies" },
      { source: "/srv/downloads", destination: "/downloads" },
    ],
    qbittorrent: [{ source: "/srv/downloads", destination: "/downloads" }],
    jellyfin: [{ source: "/srv/media", destination: "/data/media" }],
  };
}

export function makeDeps(opts: {
  settings: Record<string, string>;
  routes: Record<string, RouteHandler | "hang">;
  mounts?: Record<string, MountInfo[]> | null;
  lan?: string;
}): { deps: Partial<ProbeEnvDeps>; calls: RecordedCall[] } {
  const router = createRouter(opts.routes);
  const mounts = opts.mounts;
  return {
    calls: router.calls,
    deps: {
      getSetting: (key: string) => opts.settings[key],
      fetch: router.fetch,
      inspectMounts: async (container: string) => (mounts === null || mounts === undefined ? null : mounts[container] ?? null),
      lanAddress: () => opts.lan ?? "192.168.1.20",
    },
  };
}

export function allSecretValues(): string[] {
  return Object.values(SECRETS);
}
