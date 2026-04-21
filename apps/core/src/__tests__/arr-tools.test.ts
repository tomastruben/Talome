import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ───────────────────────────────────────────────────────────────────
const mockSettingsGet = vi.hoisted(() => vi.fn());

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: mockSettingsGet,
        }),
      }),
    }),
  },
  schema: {
    settings: { key: "key" },
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  arrGetStatusTool,
  arrListRootFoldersTool,
  arrAddRootFolderTool,
  arrListDownloadClientsTool,
  arrAddDownloadClientTool,
  arrTestDownloadClientTool,
  arrListIndexersTool,
  arrListQualityProfilesTool,
  arrApplyQualityProfileTool,
  arrSearchReleasesTool,
  arrGetWantedMissingTool,
  arrSetNamingConventionTool,
} from "../ai/tools/arr-tools.js";

describe("arr-tools: configuration error when not configured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsGet.mockReturnValue(null); // no settings
  });

  it("arr_get_status returns error when sonarr not configured", async () => {
    const result = await (arrGetStatusTool.execute as Function)({ app: "sonarr" }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });

  it("arr_list_root_folders returns error when radarr not configured", async () => {
    const result = await (arrListRootFoldersTool.execute as Function)({ app: "radarr" }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });
});

describe("arr-tools: with Sonarr configured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Return URL for sonarr_url, API key for sonarr_api_key
    mockSettingsGet.mockImplementation(() => {
      const callCount = mockSettingsGet.mock.calls.length;
      // First call is for URL, second is for API key
      return callCount % 2 === 1
        ? { value: "http://sonarr:8989" }
        : { value: "test-api-key-123" };
    });
  });

  it("arr_add_root_folder posts correct body", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ id: 1, path: "/data/media/tv" }),
    });

    const result = await (arrAddRootFolderTool.execute as Function)({ app: "sonarr", path: "/data/media/tv" }, {});
    expect(result.success).toBe(true);
    expect(result.message).toContain("/data/media/tv");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/rootfolder"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("arr_add_download_client posts correct implementationName", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ id: 1, name: "qBittorrent" }),
    });

    const result = await (arrAddDownloadClientTool.execute as Function)(
      { app: "sonarr", name: "qBittorrent", host: "qbittorrent", port: 8080, username: "admin", password: "pass" },
      {},
    );
    expect(result.success).toBe(true);
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.implementationName).toBe("qBittorrent");
    expect(callBody.implementation).toBe("QBittorrent");
  });

  it("arr_list_download_clients returns the data from API", async () => {
    const clients = [{ id: 1, name: "qBittorrent", enable: true }];
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve(clients),
    });

    const result = await (arrListDownloadClientsTool.execute as Function)({ app: "sonarr" }, {});
    expect(result.success).toBe(true);
    expect(result.downloadClients).toEqual(clients);
  });

  it("arr_list_quality_profiles returns profile list", async () => {
    const profiles = [{ id: 1, name: "Any" }, { id: 2, name: "HD-1080p" }];
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve(profiles),
    });

    const result = await (arrListQualityProfilesTool.execute as Function)({ app: "sonarr" }, {});
    expect(result.success).toBe(true);
    expect(result.qualityProfiles).toHaveLength(2);
    expect(result.qualityProfiles[0].name).toBe("Any");
  });

  it("arr_apply_quality_profile updates series in bulk", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({}),
    });

    const result = await (arrApplyQualityProfileTool.execute as Function)(
      { app: "sonarr", qualityProfileId: 2, mediaIds: [101, 102] },
      {},
    );
    expect(result.success).toBe(true);
    expect(result.updatedCount).toBe(2);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/series/editor"),
      expect.objectContaining({ method: "PUT" }),
    );
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(callBody.seriesIds).toEqual([101, 102]);
    expect(callBody.qualityProfileId).toBe(2);
  });

  it("arr_search_releases ranks and returns recommendation", async () => {
    // First call: /release?movieId=42 — returns release list
    // Second call: /movie/42 — returns movie data (for title matching fallback)
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        headers: { get: () => "application/json" },
        json: () => Promise.resolve([
          { title: "Movie.2160p.REMUX", size: 60 * 1024 * 1024 * 1024, quality: { quality: { name: "Bluray-2160p" } }, ageHours: 2, mappedMovieId: 42 },
          { title: "Movie.1080p.WEB", size: 8 * 1024 * 1024 * 1024, quality: { quality: { name: "WEBDL-1080p" } }, ageHours: 5, mappedMovieId: 42 },
        ]),
      });

    const result = await (arrSearchReleasesTool.execute as Function)(
      { app: "radarr", movieId: 42, qualityIntent: "balanced" },
      {},
    );

    expect(result.success).toBe(true);
    expect(result.releases.length).toBe(2);
    expect(result.recommendation).toBeTruthy();
  });

  it("arr_get_wanted_missing returns paging payload", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ page: 1, pageSize: 30, totalRecords: 0, records: [] }),
    });

    const result = await (arrGetWantedMissingTool.execute as Function)(
      { app: "sonarr", page: 1, pageSize: 30 },
      {},
    );
    expect(result.success).toBe(true);
    expect(result.kind).toBe("missing");
  });

  it("arr_test_download_client sends POST to /downloadclient/test", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({}),
    });

    const result = await (arrTestDownloadClientTool.execute as Function)({ app: "sonarr", clientId: 1 }, {});
    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/downloadclient/test"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
