import {
  Home01Icon,
  Package01Icon,
  DownloadSquare01Icon,
  HardDriveIcon,
  Message01Icon,
  Film01Icon,
  BookOpen01Icon,
  FlashIcon,
  AiMagicIcon,
  Bug01Icon,
  ComputerTerminal01Icon,
  DashboardSquare02Icon,
  Settings01Icon,
  ArchiveIcon,
  SecurityCheckIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import type { FeaturePermission } from "@talome/types";

export interface NavItem {
  title: string;
  url: string;
  icon: IconSvgElement;
  adminOnly?: boolean;
  /** Feature permission required to see this nav item */
  permission?: FeaturePermission;
  /** When set, sidebar click triggers this action instead of navigating */
  action?: string;
}

/** Starting points — what you reach for first */
export const startNav: NavItem[] = [
  { title: "Home", url: "/dashboard", icon: Home01Icon, permission: "dashboard" },
  { title: "Assistant", url: "/dashboard/assistant", icon: Message01Icon, permission: "chat" },
];

/** Content & apps — things you use and install */
export const contentNav: NavItem[] = [
  { title: "Media", url: "/dashboard/media", icon: Film01Icon, permission: "media" },
  { title: "Audiobooks", url: "/dashboard/audiobooks", icon: BookOpen01Icon, permission: "audiobooks" },
  { title: "Files", url: "/dashboard/files", icon: HardDriveIcon, permission: "files" },
  { title: "Services", url: "/dashboard/containers", icon: Package01Icon, permission: "apps" },
  { title: "App Store", url: "/dashboard/apps", icon: DownloadSquare01Icon, permission: "apps" },
];

/** Operations — managing what runs */
export const operationsNav: NavItem[] = [
  { title: "Automations", url: "/dashboard/automations", icon: FlashIcon, permission: "automations" },
  { title: "Backups", url: "/dashboard/backups", icon: ArchiveIcon, permission: "apps" },
  { title: "Intelligence", url: "/dashboard/intelligence", icon: AiMagicIcon, permission: "intelligence" },
  { title: "Bug Hunt", url: "/dashboard/bug-hunt", icon: Bug01Icon, adminOnly: true, action: "bug-hunt" },
];

/** System — configuration, anchored at bottom */
export const systemNav: NavItem[] = [
  { title: "Terminal", url: "/dashboard/terminal", icon: ComputerTerminal01Icon, adminOnly: true },
  { title: "Settings", url: "/dashboard/settings", icon: Settings01Icon },
];

/** Shown in the sidebar only while agent actions wait for an admin's decision. */
export const approvalsNavItem: NavItem = {
  title: "Approvals",
  url: "/dashboard/settings/approvals",
  icon: SecurityCheckIcon,
  adminOnly: true,
};

export const allNav: NavItem[] = [...startNav, ...contentNav, ...operationsNav, ...systemNav];

/** Who is looking: nav visibility follows role and feature permissions. */
export interface NavViewer {
  isAdmin: boolean;
  hasPermission: (feature: FeaturePermission) => boolean;
}

/** One visibility rule for the sidebar, mobile nav, palette and desktop. */
export function canSeeNavItem(item: Pick<NavItem, "adminOnly" | "permission">, viewer: NavViewer): boolean {
  if (item.adminOnly && !viewer.isAdmin) return false;
  if (item.permission && !viewer.hasPermission(item.permission)) return false;
  return true;
}

export function visibleNavItems(items: readonly NavItem[], viewer: NavViewer): NavItem[] {
  return items.filter((item) => canSeeNavItem(item, viewer));
}

/**
 * Routes that are not in the nav but still need a readable header title.
 * Everything that is in the nav takes its title from the nav item, so the
 * sidebar, mobile nav, palette and header never disagree.
 */
const EXTRA_ROUTE_TITLES: Record<string, string> = {
  "/dashboard/storage": "Storage",
  "/dashboard/share": "Share",
  "/dashboard/stacks": "Stacks",
  "/dashboard/networking": "Networking",
  "/dashboard/networks": "Networks",
  "/dashboard/evolution": "Evolution",
  "/dashboard/native-apps": "Apps",
  "/dashboard/player": "Player",
  "/dashboard/ai": "AI",
  "/dashboard/desktop": "Desktop",
  [approvalsNavItem.url]: approvalsNavItem.title,
};

/** The nav item a path belongs to (longest matching URL), if any. */
export function navItemForPath(pathname: string): NavItem | undefined {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  return allNav
    .filter((item) => (item.url === "/dashboard" ? path === "/dashboard" : path === item.url || path.startsWith(`${item.url}/`)))
    .sort((a, b) => b.url.length - a.url.length)[0];
}

/** Header title for a path: the nav item's title, a known extra route, or a readable slug. */
export function navTitleForPath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
  const extra = Object.entries(EXTRA_ROUTE_TITLES)
    .filter(([url]) => path === url || path.startsWith(`${url}/`))
    .sort((a, b) => b[0].length - a[0].length)[0];
  const item = navItemForPath(path);
  if (extra && (!item || extra[0].length > item.url.length)) return extra[1];
  if (item) return item.title;
  const slug = path.split("/").filter(Boolean).pop() ?? "dashboard";
  return humanizeSlug(slug);
}

/** "media-player" → "Media player" (sentence case, per the copy rules). */
export function humanizeSlug(slug: string): string {
  const words = slug.split(/[-_]+/).filter(Boolean).join(" ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

export interface PaletteNavCommand {
  label: string;
  path: string;
  icon: IconSvgElement;
}

/**
 * The palette's Navigate group: the same names, icons and visibility rules
 * as the sidebar (so Terminal never shows for members and Intelligence has
 * one icon). Overlay actions such as Bug Hunt are listed under Actions, and
 * in desktop mode Home is the widgets panel.
 */
export function paletteNavCommands(viewer: NavViewer, desktop: boolean): PaletteNavCommand[] {
  return visibleNavItems(allNav, viewer)
    .filter((item) => !item.action)
    .map((item) => desktop && item.url === "/dashboard"
      ? { label: "Widgets", path: item.url, icon: DashboardSquare02Icon }
      : { label: item.title, path: item.url, icon: item.icon });
}
