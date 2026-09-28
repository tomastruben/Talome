import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings = vi.hoisted(() => ({
  values: {
    sonarr_url: "http://sonarr.test",
    sonarr_api_key: "s-key",
    radarr_url: "http://radarr.test",
    radarr_api_key: "r-key",
  } as Record<string, string | undefined>,
}));

vi.mock("../utils/settings.js", () => ({ getSetting: (k: string) => settings.values[k] }));
vi.mock("../db/notifications.js", () => ({ writeNotification: vi.fn() }));
vi.mock("../middleware/request-logger.js", () => ({
  serverError: (c: { json: (b: unknown, s: number) => Response }) => c.json({ error: "fail" }, 500),
  recordGracefulError: vi.fn(),
}));
vi.mock("../docker/client.js", () => ({ inspectContainer: vi.fn(), listContainers: vi.fn(async () => []) }));
vi.mock("../media/optimizer.js", () => ({ findOptimizedPath: vi.fn() }));
vi.mock("../utils/media-paths.js", () => ({
  getArrMounts: vi.fn(async () => []),
  containerToHostPath: vi.fn(),
  resolveMediaFilePath: vi.fn(),
}));
vi.mock("../routes/files.js", () => ({
  probeFile: vi.fn(), startHls: vi.fn(), hlsOutDirByHash: vi.fn(), stopHls: vi.fn(), touchJob: vi.fn(),
  hasFfmpeg: vi.fn(), buildStreamResponse: vi.fn(), startTransmux: vi.fn(), stopTransmux: vi.fn(),
  transmuxJobs: new Map(), TRANSMUX_ROOT: "/tmp/transmux",
}));

import { media, invalidateLibraryCache } from "../routes/media.js";

const series = [{ id: 1, title: "Show", statistics: { episodeCount: 3 }, images: [] }];
const movies = [{ id: 2, title: "Film", hasFile: true, images: [] }];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invalidateLibraryCache();
  fetchMock = vi.fn(async (url: string) => {
    const body = url.includes("/series") ? series : url.includes("/movie") ? movies : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /library cache", () => {
  it("serves repeat requests from cache and dedupes concurrent ones", async () => {
    const [a, b] = await Promise.all([media.request("/library"), media.request("/library")]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // one /series + one /movie
    const body = await a.json() as { totals: { tvShows: number; movies: number }; sonarrAvailable: boolean };
    expect(body.totals).toEqual({ tvShows: 1, movies: 1 });
    expect(body.sonarrAvailable).toBe(true);
    expect(await b.json()).toEqual(body);

    await media.request("/library");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("is invalidated by mutating requests but not by playback heartbeats", async () => {
    await media.request("/library");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await media.request("/hls-ping", { method: "POST", body: "{}" });
    await media.request("/library");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/series"))).toHaveLength(1);

    // Any library mutation (here: a delete that fails upstream) drops the cache.
    await media.request("/movie/2", { method: "DELETE" });
    await media.request("/library");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/series"))).toHaveLength(2);
  });

  it("does not serve a cached library after the Sonarr URL changes", async () => {
    await media.request("/library");
    settings.values.sonarr_url = "http://other-sonarr.test";
    await media.request("/library");
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("other-sonarr"))).toHaveLength(1);
    settings.values.sonarr_url = "http://sonarr.test";
  });
});
