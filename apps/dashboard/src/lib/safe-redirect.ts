/**
 * The one check for redirect targets taken from the URL (`?from=`).
 *
 * Only same-origin paths are allowed: the value must start with a single
 * "/", contain no backslash or control character, and still resolve to the
 * same origin after URL parsing (so "//evil.test", "/\evil.test",
 * "/%5Cevil.test" tricks and "javascript:" never leave Talome). Paths back
 * into the sign-in or setup screens fall back too, so a redirect can't loop.
 *
 * `within` narrows the allowed prefix further ("/dashboard" allows
 * "/dashboard" and "/dashboard/…", but not "/dashboardx").
 */
const PLACEHOLDER_ORIGIN = "http://talome.invalid";
const AUTH_PATHS = ["/login", "/setup"];

export function safeRedirectPath(
  raw: string | null | undefined,
  fallback = "/dashboard",
  options: { within?: string } = {},
): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  // Backslashes are treated as slashes by browsers ("/\evil" is "//evil").
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;

  let url: URL;
  try {
    url = new URL(raw, PLACEHOLDER_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return fallback;
  // Re-check the normalised path: dot segments and encoded slashes resolve here.
  if (url.pathname.startsWith("//")) return fallback;

  const path = url.pathname;
  if (AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return fallback;
  if (options.within) {
    const base = options.within.replace(/\/+$/, "");
    if (path !== base && !path.startsWith(`${base}/`)) return fallback;
  }
  return `${path}${url.search}${url.hash}`;
}
