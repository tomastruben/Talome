/**
 * Granular feature permissions for Talome users.
 * Admins always have full access — these only apply to `member` users.
 */

export const FEATURE_PERMISSIONS = [
  "dashboard",
  "chat",
  "media",
  "audiobooks",
  "downloads",
  "files",
  "apps",
  "automations",
] as const;

export type FeaturePermission = (typeof FEATURE_PERMISSIONS)[number];

/** Map of feature → enabled. Missing keys are treated as `true` (default allow). */
export type UserPermissions = Partial<Record<FeaturePermission, boolean>>;

export const PERMISSION_LABELS: Record<FeaturePermission, { label: string; description: string }> = {
  dashboard: { label: "Dashboard", description: "View system overview and widgets" },
  chat: { label: "Assistant", description: "Use the AI chat assistant" },
  media: { label: "Media", description: "Browse and manage media libraries" },
  audiobooks: { label: "Audiobooks", description: "Access audiobook library" },
  downloads: { label: "Downloads", description: "View and manage downloads" },
  files: { label: "Files", description: "Browse and manage files" },
  apps: { label: "Apps", description: "Install and manage applications" },
  automations: { label: "Automations", description: "Create and manage automations" },
};

/** Returns default permissions — all features enabled. */
export function getDefaultPermissions(): UserPermissions {
  return Object.fromEntries(FEATURE_PERMISSIONS.map((p) => [p, true])) as UserPermissions;
}

/** Check if a user has a specific permission. Defaults to true for missing keys. */
export function hasPermission(permissions: UserPermissions | undefined | null, feature: FeaturePermission): boolean {
  if (!permissions) return true;
  return permissions[feature] !== false;
}
