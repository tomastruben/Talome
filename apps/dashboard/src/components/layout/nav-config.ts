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
  Settings01Icon,
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
  { title: "Intelligence", url: "/dashboard/intelligence", icon: AiMagicIcon },
  { title: "Bug Hunt", url: "/dashboard/bug-hunt", icon: Bug01Icon, adminOnly: true, action: "bug-hunt" },
];

/** System — configuration, anchored at bottom */
export const systemNav: NavItem[] = [
  { title: "Terminal", url: "/dashboard/terminal", icon: ComputerTerminal01Icon, adminOnly: true },
  { title: "Settings", url: "/dashboard/settings", icon: Settings01Icon },
];

export const allNav: NavItem[] = [...startNav, ...contentNav, ...operationsNav, ...systemNav];
