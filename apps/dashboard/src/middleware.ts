import { NextRequest, NextResponse } from "next/server";

const CORE_BACKEND = process.env.CORE_BACKEND_URL || "http://127.0.0.1:4000";

/** Decode a JWT payload without verification (just base64url → JSON). */
function decodeJwtPayload(token: string): { exp?: number } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(base64);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Proxy /api/* requests to the core backend
  if (pathname.startsWith("/api/")) {
    const url = new URL(pathname + request.nextUrl.search, CORE_BACKEND);
    return NextResponse.rewrite(url);
  }

  // Allow public paths through
  if (
    pathname === "/login" ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/manifest.json"
  ) {
    return NextResponse.next();
  }

  // Check for session cookie
  const sessionCookie = request.cookies.get("talome_session");

  if (!sessionCookie?.value) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Check if the JWT has expired
  const payload = decodeJwtPayload(sessionCookie.value);
  if (payload?.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("from", pathname);
    const response = NextResponse.redirect(loginUrl);
    response.cookies.delete("talome_session");
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
