import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CORE = process.env.CORE_BACKEND_URL || process.env.NEXT_PUBLIC_CORE_URL || "http://127.0.0.1:4000";

/**
 * Same-origin relay for streaming uploads (used when the dashboard is served over
 * HTTPS). proxy.ts and the next.config rewrite both buffer request bodies and cut
 * them off at 10 MB, so this path is excluded from proxy.ts and, as a static
 * route, is matched before the rewrite. The body streams straight through to core.
 */
export async function PUT(req: NextRequest) {
  const url = new URL(req.url);
  const headers = new Headers();
  for (const name of ["cookie", "authorization", "content-type", "content-length", "user-agent", "x-forwarded-for"]) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-forwarded-host", req.headers.get("host") ?? "localhost");

  try {
    const coreRes = await fetch(`${CORE}/api/files/upload-stream${url.search}`, {
      method: "PUT",
      headers,
      body: req.body,
      signal: req.signal,
      // @ts-expect-error Node fetch supports duplex for streaming request bodies
      duplex: "half",
    });
    return new Response(coreRes.body, {
      status: coreRes.status,
      headers: { "content-type": coreRes.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Core unreachable" }, { status: 502 });
  }
}
