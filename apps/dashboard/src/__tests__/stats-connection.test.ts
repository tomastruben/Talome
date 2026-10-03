import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getDirectCoreUrl } from "@/lib/constants";
import { GET } from "@/app/api/[...path]/route";

afterEach(() => vi.unstubAllGlobals());

describe("secure live stats", () => {
  it("uses the secure dashboard origin rather than plaintext port 4000", () => {
    vi.stubGlobal("window", { location: new URL("https://mini.tailnet.ts.net:8443/dashboard/desktop") });
    expect(getDirectCoreUrl() + "/api/stats/stream").toBe("https://mini.tailnet.ts.net:8443/api/stats/stream");
  });

  it("keeps direct streaming on the HTTP LAN dashboard", () => {
    vi.stubGlobal("window", { location: new URL("http://localhost:3000/dashboard/desktop") });
    expect(getDirectCoreUrl()).toBe("http://localhost:4000");
  });

  it("delivers an SSE event while upstream stays open and forwards authentication", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const fetch = vi.fn(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const request = new NextRequest("https://mini.tailnet.ts.net:8443/api/stats/stream", { headers: { cookie: "talome_session=test" } });
    const response = await GET(request);
    const options = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(options[1].headers).get("cookie")).toBe("talome_session=test");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    const reader = response.body!.getReader();
    const event = "event: stats\ndata: {\"cpu\":{\"usage\":12}}\n\n";
    controller!.enqueue(new TextEncoder().encode(event));
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    expect(new TextDecoder().decode(chunk.value)).toBe(event);
    controller!.close();
    expect((await reader.read()).done).toBe(true);
  });
});
