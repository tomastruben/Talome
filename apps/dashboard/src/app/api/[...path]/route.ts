import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORE = process.env.NEXT_PUBLIC_CORE_URL || "http://127.0.0.1:4000";

async function proxyToCore(req: NextRequest) {
  const url = new URL(req.url);
  const target = `${CORE}${url.pathname}${url.search}`;

  const headers = new Headers();
  for (const [key, value] of req.headers.entries()) {
    if (key === "host" || key === "connection") continue;
    headers.set(key, value);
  }

  try {
    const coreRes = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      signal: req.signal,
      // @ts-expect-error Node fetch supports duplex for streaming request bodies
      duplex: "half",
    });

    const contentType = coreRes.headers.get("content-type") ?? "";
    const isStreamResponse =
      contentType.includes("text/event-stream") ||
      coreRes.headers.has("x-vercel-ai-data-stream") ||
      coreRes.headers.has("x-vercel-ai-ui-message-stream");

    if (isStreamResponse && coreRes.body) {
      const streamHeaders = new Headers(coreRes.headers);
      streamHeaders.set("Cache-Control", "no-cache, no-transform");
      streamHeaders.set("X-Accel-Buffering", "no");
      streamHeaders.delete("content-length");
      streamHeaders.delete("transfer-encoding");

      return new Response(coreRes.body, {
        status: coreRes.status,
        headers: streamHeaders,
      });
    }

    const resHeaders = new Headers(coreRes.headers);
    resHeaders.delete("transfer-encoding");

    return new Response(coreRes.body, {
      status: coreRes.status,
      headers: resHeaders,
    });
  } catch {
    return NextResponse.json(
      { status: "offline", error: "Core unreachable" },
      { status: 502 },
    );
  }
}

export const GET = proxyToCore;
export const POST = proxyToCore;
export const PUT = proxyToCore;
export const DELETE = proxyToCore;
export const PATCH = proxyToCore;
