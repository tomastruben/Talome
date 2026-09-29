/**
 * AI tools that change Sonarr/Radarr (add/delete/monitor series or movies,
 * grabs, commands) drop the media library cache served by GET /api/media/library.
 * Reads never do. Fetch and settings are mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings = vi.hoisted(() => ({
  values: {
    sonarr_url: "http://sonarr.test",
    sonarr_api_key: "s-key",
    radarr_url: "http://radarr.test",
    radarr_api_key: "r-key",
    prowlarr_url: "http://prowlarr.test",
    prowlarr_api_key: "p-key",
  } as Record<string, string | undefined>,
}));

vi.mock("../utils/settings.js", () => ({ getSetting: (k: string) => settings.values[k] }));

import { getOrBuildLibrary, invalidateLibraryCache } from "../media/library-cache.js";
import { arrGetStatusTool, arrRunCommandTool, arrSetMonitoringTool, prowlarrManageIndexersTool } from "../ai/tools/arr-tools.js";
import { requestMediaTool } from "../ai/tools/media-tools.js";
import { appApiCallTool } from "../ai/tools/universal-tools.js";

type Handler = (url: string, init?: RequestInit) => unknown;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

let routes: Handler;
let fetchMock: ReturnType<typeof vi.fn>;
let builds = 0;

async function readLibrary(): Promise<unknown> {
  return getOrBuildLibrary("k", async () => {
    builds++;
    return { payload: { builds }, complete: true };
  });
}

beforeEach(() => {
  invalidateLibraryCache();
  builds = 0;
  routes = () => ({});
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = routes(url, init);
    return body instanceof Response ? body : jsonResponse(body);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("library cache", () => {
  it("serves repeat reads from cache until invalidated", async () => {
    await readLibrary();
    await readLibrary();
    expect(builds).toBe(1);
    invalidateLibraryCache();
    await readLibrary();
    expect(builds).toBe(2);
  });
});

describe("arr tools invalidate the library after successful mutations", () => {
  it("set_movie (Radarr PUT) drops the cache", async () => {
    await readLibrary();
    routes = (url) => (url.endsWith("/api/v3/movie/7") ? { id: 7, monitored: true } : {});
    const result = await (arrSetMonitoringTool.execute as Function)(
      { app: "radarr", action: "set_movie", movieId: 7, monitored: false },
      {},
    );
    expect(result.success).toBe(true);
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
    expect(put).toBeTruthy();
    await readLibrary();
    expect(builds).toBe(2);
  });

  it("set_series (Sonarr PUT) and commands drop the cache", async () => {
    routes = (url) => (url.includes("/series/3") ? { id: 3, monitored: true } : { id: 99, status: "queued" });
    await readLibrary();
    await (arrSetMonitoringTool.execute as Function)({ app: "sonarr", action: "set_series", seriesId: 3, monitored: false }, {});
    await readLibrary();
    expect(builds).toBe(2);
    await (arrRunCommandTool.execute as Function)({ app: "sonarr", commandName: "RescanSeries", seriesId: 3 }, {});
    await readLibrary();
    expect(builds).toBe(3);
  });

  it("keeps the cache for reads, failed mutations and non-library apps", async () => {
    await readLibrary();
    routes = () => ({ version: "4.0.0" });
    await (arrGetStatusTool.execute as Function)({ app: "sonarr" }, {});
    await readLibrary();
    expect(builds).toBe(1);

    // Upstream error → nothing changed → cache kept.
    routes = (url, init) => (init?.method === "PUT" ? new Response("nope", { status: 500 }) : { id: 7, monitored: true });
    const failed = await (arrSetMonitoringTool.execute as Function)(
      { app: "radarr", action: "set_movie", movieId: 7, monitored: false },
      {},
    );
    expect(failed.success).toBe(false);
    await readLibrary();
    expect(builds).toBe(1);

    // Prowlarr changes never affect the Sonarr/Radarr library.
    routes = () => ({});
    await (prowlarrManageIndexersTool.execute as Function)({ action: "delete", indexerId: 4 }, {});
    await readLibrary();
    expect(builds).toBe(1);
  });
});

describe("request_media invalidates the library after adding", () => {
  it("adding a movie to Radarr drops the cache", async () => {
    routes = (url) => {
      if (url.endsWith("/rootfolder")) return [{ path: "/movies" }];
      if (url.endsWith("/qualityprofile")) return [{ id: 1, name: "HD-1080p" }];
      if (url.endsWith("/movie")) return { id: 42 };
      return {};
    };
    await readLibrary();
    const result = await (requestMediaTool.execute as Function)({ type: "movie", tmdbId: 603, title: "The Matrix", qualityTier: "standard" }, {});
    expect(result.success).toBe(true);
    await readLibrary();
    expect(builds).toBe(2);
  });

  it("a failed add keeps the cache", async () => {
    routes = (url) => {
      if (url.endsWith("/rootfolder")) return [{ path: "/tv" }];
      if (url.endsWith("/qualityprofile")) return [{ id: 1, name: "HD-1080p" }];
      if (url.endsWith("/series")) return new Response("exists", { status: 400 });
      return {};
    };
    await readLibrary();
    await expect((requestMediaTool.execute as Function)({ type: "tv", tvdbId: 1, title: "Show", qualityTier: "standard" }, {})).rejects.toThrow();
    await readLibrary();
    expect(builds).toBe(1);
  });
});

describe("app_api_call invalidates the library after Sonarr/Radarr mutations", () => {
  const call = (input: Record<string, unknown>) =>
    (appApiCallTool.execute as Function)({ timeoutMs: 1000, ...input }, {}) as Promise<{ success: boolean }>;

  it("DELETE /api/v3/series/{id} on Sonarr drops the cache", async () => {
    await readLibrary();
    routes = () => ({});
    const result = await call({ appId: "sonarr", method: "DELETE", path: "/api/v3/series/12" });
    expect(result.success).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain("sonarr.test/api/v3/series/12");
    await readLibrary();
    expect(builds).toBe(2);
  });

  it("a Radarr PUT drops the cache; reads, failures and other apps do not", async () => {
    await readLibrary();
    routes = () => ({ id: 7 });
    await call({ appId: "Radarr", method: "PUT", path: "/api/v3/movie/7", body: { monitored: false } });
    await readLibrary();
    expect(builds).toBe(2);

    await call({ appId: "sonarr", method: "GET", path: "/api/v3/series" });
    routes = () => new Response("nope", { status: 500 });
    const failed = await call({ appId: "sonarr", method: "DELETE", path: "/api/v3/series/1" });
    expect(failed.success).toBe(false);
    routes = () => ({});
    await call({ appId: "prowlarr", method: "DELETE", path: "/api/v1/indexer/4" });
    await readLibrary();
    expect(builds).toBe(2);
  });
});
