import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/settings.js", () => ({
  getSetting: vi.fn((key: string) => {
    if (key === "audiobookshelf_url") return "http://audiobookshelf.test";
    if (key === "audiobookshelf_api_key") return "test-token";
    if (key === "qbittorrent_url") return "http://qbt.test";
    return null;
  }),
}));

import {
  addAudiobookTorrent,
  audiobookshelfGetLibraryItemsTool,
  audiobookshelfGetProgressTool,
} from "../ai/tools/audiobookshelf-tools.js";

type ExecutableTool<TInput> = {
  execute: (input: TInput) => Promise<unknown>;
};

const progressTool = audiobookshelfGetProgressTool as unknown as ExecutableTool<{ itemId: string }>;
const libraryItemsTool = audiobookshelfGetLibraryItemsTool as unknown as ExecutableTool<{
  libraryId: string;
  limit: number;
  page: number;
  sort: string;
  desc: boolean;
  filter?: string;
}>;

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Audiobookshelf assistant tools", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a valid unstarted item as zero progress instead of an API error", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "book-1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(progressTool.execute({ itemId: "book-1" })).resolves.toEqual({
      success: true,
      hasProgress: false,
      progress: {
        currentTime: 0,
        progress: 0,
        isFinished: false,
        lastUpdate: null,
        startedAt: null,
        finishedAt: null,
        duration: 0,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://audiobookshelf.test/api/items/book-1?expanded=1&include=progress",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
      }),
    );
  });

  it("uses the dedicated in-progress endpoint and includes detailed progress", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/api/me/items-in-progress?limit=10000")) {
        return jsonResponse({
          libraryItems: [
            { id: "book-1", libraryId: "library-1", media: { metadata: { title: "Book One" }, duration: 100 } },
            { id: "book-2", libraryId: "library-2", media: { metadata: { title: "Other Library" }, duration: 200 } },
          ],
        });
      }
      return jsonResponse({
        mediaProgress: [
          { libraryItemId: "book-1", currentTime: 25, duration: 100, progress: 0.25, isFinished: false },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await libraryItemsTool.execute({
      libraryId: "library-1",
      limit: 25,
      page: 0,
      sort: "media.metadata.title",
      desc: false,
      filter: "progress",
    });

    expect(result).toMatchObject({
      success: true,
      total: 1,
      items: [{ id: "book-1", title: "Book One", userProgress: { currentTime: 25, progress: 0.25 } }],
    });
  });

  it("resolves finished progress entries to library items", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/api/me")) {
        return jsonResponse({
          mediaProgress: [
            { libraryItemId: "book-1", progress: 1, isFinished: true },
            { libraryItemId: "book-2", progress: 0.5, isFinished: false },
          ],
        });
      }
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ libraryItemIds: ["book-1"] });
      return jsonResponse({
        libraryItems: [
          { id: "book-1", libraryId: "library-1", media: { metadata: { title: "Finished Book" }, duration: 100 } },
        ],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await libraryItemsTool.execute({
      libraryId: "library-1",
      limit: 25,
      page: 0,
      sort: "media.metadata.title",
      desc: false,
      filter: "finished",
    });

    expect(result).toMatchObject({
      success: true,
      total: 1,
      items: [{ id: "book-1", title: "Finished Book", userProgress: { progress: 1, isFinished: true } }],
    });
  });
});

describe("audiobook_download", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch() {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "http://prowlarr.test/download/1") return new Response(new Uint8Array([100, 56, 58]), { status: 200 });
      if (url.endsWith("/api/v2/auth/login")) return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc; path=/" } });
      return new Response("Ok.", { status: 200 });
    }));
    return calls;
  }

  it("fetches an indexer URL itself and uploads the .torrent, so qBittorrent never has to reach Prowlarr", async () => {
    const calls = stubFetch();
    const res = await addAudiobookTorrent("http://prowlarr.test/download/1", "audiobooks");
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.url === "http://prowlarr.test/download/1")).toBe(true);
    const add = calls.find((c) => c.url === "http://qbt.test/api/v2/torrents/add")!;
    const body = add.init?.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("category")).toBe("audiobooks");
    expect(body.get("torrents")).toBeInstanceOf(Blob);
  });

  it("passes a magnet link to qBittorrent as-is", async () => {
    const calls = stubFetch();
    await addAudiobookTorrent("magnet:?xt=urn:btih:abc", "audiobooks");
    const add = calls.find((c) => c.url === "http://qbt.test/api/v2/torrents/add")!;
    expect(String(add.init?.body)).toContain("urls=magnet%3A%3Fxt%3Durn%3Abtih%3Aabc");
    expect(calls.some((c) => c.url.startsWith("magnet:"))).toBe(false);
  });
});
