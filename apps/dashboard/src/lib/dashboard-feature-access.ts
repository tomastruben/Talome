import {
  hasPermission,
  type FeaturePermission,
  type UserPermissions,
} from "@talome/types";

export interface DashboardRouteRequirement {
  permission?: FeaturePermission;
  adminOnly?: boolean;
}

const ROUTE_REQUIREMENTS: ReadonlyArray<{
  path: string;
  exact?: boolean;
  requirement: DashboardRouteRequirement;
}> = [
  { path: "/dashboard", exact: true, requirement: { permission: "dashboard" } },
  { path: "/dashboard/assistant", requirement: { permission: "chat" } },
  { path: "/dashboard/media", requirement: { permission: "media" } },
  { path: "/dashboard/player", requirement: { permission: "media" } },
  { path: "/dashboard/audiobooks", requirement: { permission: "audiobooks" } },
  { path: "/dashboard/files", requirement: { permission: "files" } },
  { path: "/dashboard/containers", requirement: { permission: "apps" } },
  { path: "/dashboard/apps", requirement: { permission: "apps" } },
  { path: "/dashboard/share", requirement: { permission: "apps" } },
  { path: "/dashboard/native-apps", requirement: { permission: "apps" } },
  { path: "/dashboard/backups", requirement: { permission: "apps" } },
  { path: "/dashboard/automations", requirement: { permission: "automations" } },
  { path: "/dashboard/intelligence", requirement: { permission: "intelligence" } },
  { path: "/dashboard/logs", requirement: { permission: "intelligence" } },
  { path: "/dashboard/terminal", requirement: { adminOnly: true } },
  { path: "/dashboard/bug-hunt", requirement: { adminOnly: true } },
];

export function getDashboardRouteRequirement(
  pathname: string,
): DashboardRouteRequirement | undefined {
  return ROUTE_REQUIREMENTS.find(({ path, exact }) =>
    exact ? pathname === path : pathname === path || pathname.startsWith(`${path}/`),
  )?.requirement;
}

export function canAccessDashboardRoute(
  pathname: string,
  role: "admin" | "member" | undefined,
  permissions: UserPermissions | undefined,
): boolean {
  const requirement = getDashboardRouteRequirement(pathname);
  if (!requirement) return true;
  if (role === "admin") return true;
  if (requirement.adminOnly) return false;
  return !requirement.permission || hasPermission(permissions, requirement.permission);
}

const MEMBER_FALLBACK_ROUTES: ReadonlyArray<{
  path: string;
  permission?: FeaturePermission;
}> = [
  { path: "/dashboard/assistant", permission: "chat" },
  { path: "/dashboard/media", permission: "media" },
  { path: "/dashboard/audiobooks", permission: "audiobooks" },
  { path: "/dashboard/files", permission: "files" },
  { path: "/dashboard/containers", permission: "apps" },
  { path: "/dashboard/automations", permission: "automations" },
  { path: "/dashboard/intelligence", permission: "intelligence" },
  { path: "/dashboard/settings" },
];

export function firstAccessibleDashboardRoute(
  role: "admin" | "member" | undefined,
  permissions: UserPermissions | undefined,
): string {
  if (role === "admin") return "/dashboard";
  return MEMBER_FALLBACK_ROUTES.find(({ permission }) =>
    !permission || hasPermission(permissions, permission),
  )?.path ?? "/dashboard/settings";
}
