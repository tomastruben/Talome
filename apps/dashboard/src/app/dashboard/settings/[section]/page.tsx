"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSetAtom } from "jotai";
import { pageTitleAtom } from "@/atoms/page-title";
import { useUser } from "@/hooks/use-user";

import { GeneralSection } from "@/components/settings/sections/general";
import { UsersSection } from "@/components/settings/sections/users";
import { AiProviderSection } from "@/components/settings/sections/ai-provider";
import { AiToolsSection } from "@/components/settings/sections/ai-tools";
import { AiPromptSection } from "@/components/settings/sections/ai-prompt";
import { AiMemorySection } from "@/components/settings/sections/ai-memory";
import { ConnectionsSection } from "@/components/settings/sections/connections";
import { IntegrationsSection } from "@/components/settings/sections/integrations";
import { McpSection } from "@/components/settings/sections/mcp";
import { AppSourcesSection } from "@/components/settings/sections/app-sources";
import { CommunityReviewSection } from "@/components/settings/sections/community-review";
import { ExportImportSection } from "@/components/settings/sections/setup-link";
import { NetworkingSection } from "@/components/settings/sections/networking";
import { BackupsSection } from "@/components/settings/sections/backups";
import { IntelligenceSection } from "@/components/settings/sections/intelligence";
import { AiCostSection } from "@/components/settings/sections/ai-cost";
import { FileManagerSection } from "@/components/settings/sections/file-manager";
import { MediaPlayerSection } from "@/components/settings/sections/media-player";
import { LegalSection } from "@/components/settings/sections/legal";
import { NotificationsSection } from "@/components/settings/sections/notifications";
import { SecuritySection } from "@/components/settings/sections/security";
import { UpdatesSection } from "@/components/settings/sections/updates";

import type { ComponentType } from "react";

interface SectionDef {
  component: ComponentType;
  title: string;
  adminOnly?: boolean;
}

const SECTIONS: Record<string, SectionDef> = {
  "general":          { component: GeneralSection,        title: "General" },
  "users":            { component: UsersSection,          title: "Users & Access", adminOnly: true },
  "ai-provider":      { component: AiProviderSection,     title: "AI Provider" },
  "ai-tools":         { component: AiToolsSection,         title: "AI Tools" },
  "security":         { component: SecuritySection,        title: "Security", adminOnly: true },
  "ai-prompt":        { component: AiPromptSection,       title: "System Prompt" },
  "ai-memory":        { component: AiMemorySection,       title: "Memory" },
  "connections":      { component: ConnectionsSection,    title: "Media Services" },
  "integrations":     { component: IntegrationsSection,   title: "Chat Bots" },
  "notifications":    { component: NotificationsSection,   title: "Notifications" },
  "mcp":              { component: McpSection,            title: "MCP Server" },
  "app-sources":      { component: AppSourcesSection,     title: "App Sources" },
  "community-review": { component: CommunityReviewSection, title: "Community Review", adminOnly: true },
  "stacks":           { component: ExportImportSection,      title: "Export & Import" },
  "networking":       { component: NetworkingSection,      title: "Networking", adminOnly: true },
  "backups":          { component: BackupsSection,         title: "Backups" },
  "intelligence":    { component: IntelligenceSection,    title: "Intelligence", adminOnly: true },
  "ai-cost":         { component: AiCostSection,          title: "API Cost" },
  "file-manager":    { component: FileManagerSection,     title: "File Manager", adminOnly: true },
  "media-player":    { component: MediaPlayerSection,    title: "Media Player" },
  "legal":           { component: LegalSection,           title: "Legal & Disclaimer" },
  "updates":         { component: UpdatesSection,         title: "App Updates", adminOnly: true },
};

export default function SettingsSectionPage() {
  const params = useParams();
  const router = useRouter();
  const setPageTitle = useSetAtom(pageTitleAtom);
  const { isAdmin } = useUser();
  const slug = params.section as string;
  const section = SECTIONS[slug];

  useEffect(() => {
    if (!section || (section.adminOnly && !isAdmin)) {
      router.replace("/dashboard/settings");
      return;
    }
    setPageTitle(section.title);
    return () => setPageTitle(null);
  }, [section, setPageTitle, router, isAdmin]);

  if (!section) return null;
  if (section.adminOnly && !isAdmin) return null;

  const Component = section.component;

  return (
    <div className="mx-auto w-full max-w-2xl min-w-0 pb-12">
      <Component />
    </div>
  );
}
