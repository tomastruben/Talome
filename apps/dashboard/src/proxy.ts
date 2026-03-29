import { NextRequest, NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login", "/api/", "/_next", "/favicon.ico", "/manifest.json"];

/** Decode a JWT payload without verification (just base64url → JSON). */
function decodeJwtPayload(token: string): { exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    // base64url → base64 → decode
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths through unconditionally
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check for session cookie — the cookie name must match SESSION_COOKIE in core
  const sessionCookie = request.cookies.get("talome_session");

  if (!sessionCookie?.value) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Check if the JWT has expired by decoding the payload (no secret needed).
  // This avoids serving a page that will immediately fail all API calls.
  const payload = decodeJwtPayload(sessionCookie.value);
  if (payload?.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    // Token expired — clear the stale cookie and redirect to login
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete("talome_session");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico
     */
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
