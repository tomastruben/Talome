/**
 * Settings sections, grouped the way the index and the two-pane sidebar show them.
 */

import {
  AiBrain01Icon,
  AiCloudIcon,
  AiMagicIcon,
  AlertCircleIcon,
  ArchiveIcon,
  ChartIcon,
  ChatBotIcon,
  CheckmarkBadge01Icon,
  FileVideoIcon,
  Globe02Icon,
  HardDriveIcon,
  Layers01Icon,
  PackageAdd01Icon,
  PlayIcon,
  Plug02Icon,
  QuillWrite01Icon,
  Shield01Icon,
  SystemUpdate01Icon,
  ToolsIcon,
  UserIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";

export interface SettingsLink {
  slug: string;
  icon: IconSvgElement;
  title: string;
  description: string;
  adminOnly?: boolean;
}

export const GENERAL_ITEMS: SettingsLink[] = [
  { slug: "users", icon: UserIcon, title: "Users & Access", description: "Create members, manage roles", adminOnly: true },
];

export const AI_ITEMS: SettingsLink[] = [
  { slug: "ai-provider", icon: AiCloudIcon, title: "AI Provider", description: "Anthropic, OpenAI, and Ollama keys" },
  { slug: "intelligence", icon: AiMagicIcon, title: "Intelligence", description: "Agent loop, auto-remediation, self-improvement", adminOnly: true },
  { slug: "ai-cost", icon: ChartIcon, title: "API Cost", description: "Track spend, set daily caps, view usage breakdown" },
  { slug: "ai-tools", icon: ToolsIcon, title: "AI Tools", description: "Manage built-in and custom tools" },
  { slug: "ai-prompt", icon: QuillWrite01Icon, title: "System Prompt", description: "Customise the assistant's personality" },
  { slug: "ai-memory", icon: AiBrain01Icon, title: "Memory", description: "What the assistant remembers about you" },
];

export const INFRASTRUCTURE_ITEMS: SettingsLink[] = [
  { slug: "security", icon: Shield01Icon, title: "Security", description: "AI access level, approvals and shell permissions", adminOnly: true },
  { slug: "notifications", icon: AlertCircleIcon, title: "Notifications", description: "Alert thresholds and notification channels" },
  { slug: "networking", icon: Globe02Icon, title: "Networking", description: "Reverse proxy, remote access, Docker networks", adminOnly: true },
  { slug: "backups", icon: ArchiveIcon, title: "Backups", description: "Scheduled backups and restore history" },
  { slug: "file-manager", icon: HardDriveIcon, title: "File Manager", description: "Control which external drives are accessible", adminOnly: true },
  { slug: "media-player", icon: FileVideoIcon, title: "Media Player", description: "HLS transcode cache and playback settings" },
  { slug: "updates", icon: SystemUpdate01Icon, title: "App Updates", description: "Available updates and auto-update policies", adminOnly: true },
];

export const CONNECTIONS_ITEMS: SettingsLink[] = [
  { slug: "connections", icon: PlayIcon, title: "Media Services", description: "Sonarr, Radarr, Prowlarr, qBittorrent, Overseerr" },
  { slug: "integrations", icon: ChatBotIcon, title: "Chat Bots", description: "Telegram and Discord", adminOnly: true },
];

export const DEVELOPER_ITEMS: SettingsLink[] = [
  { slug: "mcp", icon: Plug02Icon, title: "MCP Server", description: "Connect Cursor, Claude Desktop, or Claude Code", adminOnly: true },
  { slug: "app-sources", icon: PackageAdd01Icon, title: "App Sources", description: "Manage app store sources" },
  { slug: "community-review", icon: CheckmarkBadge01Icon, title: "Community Review", description: "Review and approve submitted apps", adminOnly: true },
  { slug: "stacks", icon: Layers01Icon, title: "Export & Import", description: "Share settings and app stack codes" },
];

export const LEGAL_ITEMS: SettingsLink[] = [
  { slug: "legal", icon: Shield01Icon, title: "Legal & Disclaimer", description: "User responsibility, content policies, compliance" },
];

export interface SettingsCategoryDef {
  label: string;
  items: SettingsLink[];
}

export const SETTINGS_CATEGORIES: SettingsCategoryDef[] = [
  { label: "Access", items: GENERAL_ITEMS },
  { label: "AI", items: AI_ITEMS },
  { label: "Infrastructure", items: INFRASTRUCTURE_ITEMS },
  { label: "Connections", items: CONNECTIONS_ITEMS },
  { label: "Developer", items: DEVELOPER_ITEMS },
  { label: "Legal", items: LEGAL_ITEMS },
];
