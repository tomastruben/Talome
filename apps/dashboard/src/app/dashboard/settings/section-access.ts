/**
 * Whether a settings section may render for the current user.
 *
 * The user's role arrives asynchronously (/api/auth/me), so an admin-only
 * section must wait for it instead of treating "not loaded yet" as "not an
 * admin" — otherwise deep links such as /dashboard/settings/approvals?id=...
 * bounce an admin to the settings index on a cold page load.
 */
export type SectionAccess = "allowed" | "loading" | "redirect";

export function resolveSectionAccess(params: {
  exists: boolean;
  adminOnly?: boolean;
  isAdmin: boolean;
  isLoading: boolean;
}): SectionAccess {
  if (!params.exists) return "redirect";
  if (!params.adminOnly || params.isAdmin) return "allowed";
  return params.isLoading ? "loading" : "redirect";
}
