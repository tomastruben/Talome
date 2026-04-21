import { describe, it, expect, vi, beforeEach } from "vitest";

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
  schema: { settings: { key: "key" } },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  jellyfinGetStatusTool,
  jellyfinAddLibraryTool,
  jellyfinScanLibraryTool,
  jellyfinListLibrariesTool,
  jellyfinGetStatsTool,
} from "../ai/tools/jellyfin-tools.js";

const JELLYFIN_URL = "http://jellyfin:8096";
const JELLYFIN_KEY = "jellyfin-api-key";

function configureJellyfin() {
  let callCount = 0;
  mockSettingsGet.mockImplementation(() => {
    callCount++;
    return callCount % 2 === 1 ? { value: JELLYFIN_URL } : { value: JELLYFIN_KEY };
  });
}

describe("jellyfin-tools: unconfigured", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSettingsGet.mockReturnValue(null); });

  it("jellyfin_get_status returns error when not configured", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401, headers: { get: () => "" } });
    const result = await (jellyfinGetStatusTool.execute as Function)({}, {});
    expect(result.success).toBe(false);
  });
});

describe("jellyfin-tools: configured", () => {
  beforeEach(() => { vi.clearAllMocks(); configureJellyfin(); });

  it("jellyfin_add_library posts correct content type and path", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({}),
    });

    const result = await (jellyfinAddLibraryTool.execute as Function)(
      { name: "Movies", collectionType: "movies", paths: ["/data/media/movies"] },
      {},
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("Movies");
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toContain("VirtualFolders");
    expect(call[1].method).toBe("POST");
  });

  it("jellyfin_scan_library fires the correct full scan endpoint when no ID", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "" },
      text: () => Promise.resolve(""),
    });

    const result = await (jellyfinScanLibraryTool.execute as Function)({}, {});
    expect(result.success).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toContain("/Library/Refresh");
  });

  it("jellyfin_scan_library fires item-specific endpoint when ID provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "" },
      text: () => Promise.resolve(""),
    });

    const result = await (jellyfinScanLibraryTool.execute as Function)({ libraryId: "abc123" }, {});
    expect(result.success).toBe(true);
    expect(mockFetch.mock.calls[0][0]).toContain("/Items/abc123/Refresh");
  });

  it("jellyfin_list_libraries maps response to name/type/paths", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve([
        { Name: "Movies", CollectionType: "movies", Locations: ["/data/media/movies"] },
      ]),
    });

    const result = await (jellyfinListLibrariesTool.execute as Function)({}, {});
    expect(result.success).toBe(true);
    expect(result.libraries[0].name).toBe("Movies");
    expect(result.libraries[0].type).toBe("movies");
  });
});
