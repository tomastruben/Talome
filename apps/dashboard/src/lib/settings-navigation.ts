export type SettingsAccessDecision = "allow" | "pending" | "redirect";

interface SettingsAccessInput {
  sectionExists: boolean;
  adminOnly: boolean;
  isAdmin: boolean;
  userPending: boolean;
}

/**
 * Resolve access without treating an unresolved SWR user as a signed-in member.
 * Admin settings must wait for /api/auth/me before deciding to redirect.
 */
export function getSettingsAccessDecision({
  sectionExists,
  adminOnly,
  isAdmin,
  userPending,
}: SettingsAccessInput): SettingsAccessDecision {
  if (!sectionExists) return "redirect";
  if (!adminOnly) return "allow";
  if (userPending) return "pending";
  return isAdmin ? "allow" : "redirect";
}
