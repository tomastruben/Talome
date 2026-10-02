import type { Cache } from "swr";
import type { UserPermissions } from "@talome/types";
import {
  isDesktopModeAvailableNow,
  readDashboardModePreference,
  type DashboardModePreference,
} from "@/hooks/use-desktop-mode";
import { canAccessDashboardRoute } from "@/lib/dashboard-feature-access";

// ── The last person who signed in on this browser ───────────────────────────

/**
 * Only the username is kept, so the sign-in screen can greet the last person
 * like a lock screen. Never a password, token or anything else.
 */
export const LAST_USER_STORAGE_KEY = "talome-last-user";

/** Core's username limit (`loginSchema`). */
const MAX_USERNAME_LENGTH = 100;

function asUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/** The username remembered on this browser, or null (none, or storage unavailable). */
export function readRememberedUser(): string | null {
  try {
    return asUsername(localStorage.getItem(LAST_USER_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Remember who signed in. Call only after the server accepted the sign-in. */
export function rememberUser(username: string): boolean {
  const name = asUsername(username);
  if (!name) return false;
  try {
    localStorage.setItem(LAST_USER_STORAGE_KEY, name);
    return true;
  } catch {
    return false;
  }
}

/** For useSyncExternalStore: another tab signing in changes the remembered user. */
export function subscribeToRememberedUser(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === LAST_USER_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** The first character a person would write for this name, upper-cased ("ö" -> "Ö", emoji intact). */
export function userInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  let first: string | undefined;
  try {
    first = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)[Symbol.iterator]().next().value?.segment;
  } catch {
    // No Intl.Segmenter (older engines): the first code point is close enough.
  }
  return (first ?? Array.from(trimmed)[0] ?? "").toLocaleUpperCase();
}

// ── Where a successful sign-in lands ─────────────────────────────────────────

export const DESKTOP_PATH = "/dashboard/desktop";

/** `useUser`'s SWR key. */
export const ME_KEY = "/api/auth/me";

/** What /api/auth/me returns, as far as sign-in needs it. */
export interface SignedInUser {
  authenticated: boolean;
  userId?: string;
  username?: string;
  role?: "admin" | "member";
  permissions?: UserPermissions;
  preferences?: { desktopMode?: DashboardModePreference };
}

/**
 * "/" and "/dashboard" both land on the dashboard home, which itself forwards
 * to the desktop for people who use it (app/dashboard/page.tsx).
 */
export function isDashboardHome(path: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(path, "http://talome.invalid").pathname;
  } catch {
    return false;
  }
  pathname = pathname.replace(/\/+$/, "") || "/";
  return pathname === "/" || pathname === "/dashboard";
}

/**
 * This device's choice first, then the account's: the same order the
 * dashboard home uses to decide whether to forward to the desktop.
 */
export function preferredDashboardMode(user: SignedInUser | null | undefined): DashboardModePreference | undefined {
  if (!user?.authenticated) return undefined;
  return readDashboardModePreference(user.userId) ?? user.preferences?.desktopMode;
}

/**
 * Where to go after signing in. A deep link (`?from=` anywhere but the
 * dashboard home) is kept. The home goes straight to the desktop when the
 * person uses desktop mode, this device can show it and the home is theirs
 * to open: exactly when the home would forward there itself, minus the flash
 * of the classic dashboard in between.
 */
export function signInDestination({
  returnTo,
  mode,
  desktopAvailable,
  canOpenHome,
}: {
  returnTo: string;
  mode: DashboardModePreference | undefined;
  desktopAvailable: boolean;
  canOpenHome: boolean;
}): string {
  if (mode !== "desktop" || !desktopAvailable || !canOpenHome) return returnTo;
  return isDashboardHome(returnTo) ? DESKTOP_PATH : returnTo;
}

function desktopAvailableHere(): boolean {
  try {
    // Never open a desktop inside a desktop window.
    if (window.self !== window.top) return false;
    return isDesktopModeAvailableNow();
  } catch {
    return false;
  }
}

/** /api/auth/me answers in milliseconds; past this the dashboard home decides instead. */
const ME_TIMEOUT_MS = 1500;

/**
 * Reads the new session's user (the cookie is set by now) and picks the
 * destination. The user comes back too, so the caller can hand it to the
 * dashboard's `useUser` cache and the next screen opens without a loading
 * step. Any failure falls back to `returnTo`: the dashboard home still
 * forwards to the desktop on its own, so the worst case is the old behaviour.
 */
export async function resolveSignInDestination(
  returnTo: string,
  { timeoutMs = ME_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<{ path: string; user: SignedInUser | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ME_KEY, { credentials: "include", cache: "no-store", signal: controller.signal });
    if (!res.ok) return { path: returnTo, user: null };
    const user = (await res.json().catch(() => null)) as SignedInUser | null;
    if (!user || user.authenticated !== true) return { path: returnTo, user: null };
    const path = signInDestination({
      returnTo,
      mode: preferredDashboardMode(user),
      desktopAvailable: desktopAvailableHere(),
      canOpenHome: canAccessDashboardRoute("/dashboard", user.role, user.permissions),
    });
    return { path, user };
  } catch {
    return { path: returnTo, user: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seeds `useUser` with the session just read, marked as loaded, so the
 * dashboard shell renders the next screen at once instead of "Opening…" (and
 * so a previous person's cached user never shows). `mutate()` would leave SWR
 * reporting `isLoading` on the first mount, so the cache entry is written
 * directly, keeping SWR's own fields.
 */
export function primeSignedInUser(cache: Cache, user: SignedInUser) {
  cache.set(ME_KEY, { ...cache.get(ME_KEY), data: user, error: undefined, isValidating: false, isLoading: false });
}
