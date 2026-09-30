import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/settings.js", () => ({
  getSetting: vi.fn((key: string) => {
    if (key === "audiobookshelf_url") return "http://audiobookshelf.test";
    if (key === "audiobookshelf_api_key") return "test-token";
    return null;
  }),
}));

import {
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
