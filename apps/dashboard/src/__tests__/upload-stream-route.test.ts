// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PUT } from "@/app/api/files/upload-stream/route";

function uploadRequest(headers: Record<string, string>, body: ReadableStream<Uint8Array>) {
  return new NextRequest("https://talome.local:3000/api/files/upload-stream?path=%2Fmedia&name=notes.txt", {
    method: "PUT",
    headers,
    body,
    // @ts-expect-error Node's Request needs duplex for a streaming body
    duplex: "half",
  });
}

function bodyStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upload-stream relay", () => {
  it("forwards the CSRF headers core checks (origin, sec-fetch-site) with the session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await PUT(uploadRequest({
      host: "talome.local:3000",
      origin: "https://talome.local:3000",
      "sec-fetch-site": "same-origin",
      cookie: "talome_session=abc",
      "content-type": "text/plain",
      "x-not-forwarded": "nope",
    }, bodyStream("hello")));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { duplex?: string }];
    expect(url).toMatch(/\/api\/files\/upload-stream\?path=%2Fmedia&name=notes\.txt$/);
    expect(init.method).toBe("PUT");
    const headers = new Headers(init.headers);
    expect(headers.get("origin")).toBe("https://talome.local:3000");
    expect(headers.get("sec-fetch-site")).toBe("same-origin");
    expect(headers.get("cookie")).toBe("talome_session=abc");
    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("x-forwarded-host")).toBe("talome.local:3000");
    expect(headers.get("x-not-forwarded")).toBeNull();
    expect(headers.get("host")).toBeNull();
  });

  it("streams the body through instead of buffering it", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const req = uploadRequest({ origin: "https://talome.local:3000", "content-type": "application/octet-stream" }, bodyStream("chunk"));

    await PUT(req);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { duplex?: string }];
    expect(init.duplex).toBe("half");
    expect(init.body).toBeInstanceOf(ReadableStream);
    expect(init.body).toBe(req.body);
    expect(await new Response(init.body as ReadableStream).text()).toBe("chunk");
  });

  it("leaves out CSRF headers the browser didn't send", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await PUT(uploadRequest({ "content-type": "application/octet-stream" }, bodyStream("x")));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("origin")).toBe(false);
    expect(headers.has("sec-fetch-site")).toBe(false);
  });

  it("passes core's refusal through, and answers 502 when core is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "Cross-site request rejected" }), { status: 403, headers: { "content-type": "application/json" } })));
    const refused = await PUT(uploadRequest({ "content-type": "text/plain" }, bodyStream("x")));
    expect(refused.status).toBe(403);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const down = await PUT(uploadRequest({ "content-type": "text/plain" }, bodyStream("x")));
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ ok: false, error: "Core unreachable" });
  });
});
