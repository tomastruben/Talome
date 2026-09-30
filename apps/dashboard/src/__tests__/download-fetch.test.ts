import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchDownloads } from "@/hooks/use-downloads";

describe("download data failure handling", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([401, 500])("rejects HTTP %s even when a JSON response is returned", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Unavailable" }), { status })));
    await expect(fetchDownloads("/api/media/downloads")).rejects.toThrow("unavailable");
  });
  it("rejects malformed successful responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await expect(fetchDownloads("/api/media/downloads")).rejects.toThrow("Invalid");
  });
});
