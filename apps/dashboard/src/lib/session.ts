import { CORE_URL } from "@/lib/constants";

export type LogOutResult = { ok: true } | { ok: false; error: string };

/**
 * Ends the session. Resolves `{ ok: false }` when the server did not confirm
 * it, so callers stay on the page and offer Retry instead of navigating away
 * with the session still valid (the old code ignored `res.ok`).
 */
export async function logOut(fetchImpl: typeof fetch = fetch): Promise<LogOutResult> {
  try {
    const res = await fetchImpl(`${CORE_URL}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) {
      return { ok: false, error: `Couldn't log out: the server answered ${res.status}. Check that Talome is running, then retry.` };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't log out: Talome didn't respond. Check your connection, then retry." };
  }
}

/** "Administrator" or "Member", from the session's role. */
export function roleLabel(role: string | undefined): string {
  return role === "admin" ? "Administrator" : "Member";
}
