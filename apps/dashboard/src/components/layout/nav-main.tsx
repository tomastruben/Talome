"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import useSWR from "swr";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { HugeiconsIcon } from "@/components/icons";
import { useAssistant } from "@/components/assistant/assistant-context";
import { useBugHunt } from "@/components/bug-hunt/bug-hunt-context";
import { useDownloads } from "@/hooks/use-downloads";
import { useUser } from "@/hooks/use-user";
import { CORE_URL } from "@/lib/constants";
import { startNav, contentNav, operationsNav, systemNav } from "./nav-config";
import type { NavItem } from "./nav-config";

function NavItemRow({ item, isActive, totalCount, isActivelyDownloading, isStreaming, isIntelligenceActive, onAction }: {
  item: NavItem;
  isActive: boolean;
  totalCount?: number;
  isActivelyDownloading?: boolean;
  isStreaming?: boolean;
  isIntelligenceActive?: boolean;
  onAction?: () => void;
}) {
  const content = (
    <>
      <HugeiconsIcon icon={item.icon} size={20} />
      <span>{item.title}</span>
      {item.title === "Media" && totalCount !== undefined && totalCount > 0 && (
        isActivelyDownloading ? (
          <span className="ml-auto flex items-center">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75" />
              <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
            </span>
          </span>
        ) : (
          <span className="ml-auto text-xs font-medium tabular-nums bg-primary/15 text-primary rounded-full px-1.5 py-0.5 leading-none">
            {totalCount}
          </span>
        )
      )}
      {item.title === "Assistant" && isStreaming && (
        <span className="ml-auto flex items-center">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-primary" />
          </span>
        </span>
      )}
      {item.title === "Intelligence" && isIntelligenceActive && (
        <span className="ml-auto flex items-center">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-warning/60 opacity-75" />
            <span className="relative inline-flex size-1.5 rounded-full bg-status-warning" />
          </span>
        </span>
      )}
    </>
  );

  return (
    <SidebarMenuItem>
      {onAction ? (
        <SidebarMenuButton isActive={isActive} onClick={onAction}>
          {content}
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton asChild isActive={isActive}>
          <Link href={item.url}>{content}</Link>
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  );
}

export function NavMain() {
  const pathname = usePathname();
  const { totalCount, isActivelyDownloading } = useDownloads(10000);
  const { status: aiStatus } = useAssistant();
  const isStreaming = aiStatus === "streaming" || aiStatus === "submitted";
  const { isAdmin, hasPermission } = useUser();
  const bugHunt = useBugHunt();

  // Poll for active intelligence tasks (amber dot)
  // Must use the same fetcher shape as intelligence/page.tsx — SWR shares cache by key,
  // so both hooks must agree on whether they store the raw response or the unwrapped array.
  const { data: activeTasks } = useSWR<{ id: string }[]>(
    isAdmin ? `${CORE_URL}/api/evolution/suggestions?status=in_progress` : null,
    async (url: string) => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      const data = await res.json();
      return data.suggestions;
    },
    { refreshInterval: 30_000, dedupingInterval: 10_000 },
  );
  const isIntelligenceActive = (activeTasks?.length ?? 0) > 0;

  const actionHandlers: Record<string, () => void> = {
    "bug-hunt": () => bugHunt.open(),
  };

  function isVisible(item: NavItem): boolean {
    if (item.adminOnly && !isAdmin) return false;
    if (item.permission && !hasPermission(item.permission)) return false;
    return true;
  }

  const filteredSystem = systemNav.filter(isVisible);

  function checkActive(url: string) {
    if (url === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(url);
  }

  return (
    <>
      {/* Starting points */}
      <SidebarGroup>
        <SidebarMenu>
          {startNav.filter(isVisible).map((item) => (
            <NavItemRow
              key={item.title}
              item={item}
              isActive={checkActive(item.url)}
              totalCount={totalCount}
              isActivelyDownloading={isActivelyDownloading}
              isStreaming={isStreaming}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>

      {/* Content & apps */}
      <SidebarGroup>
        <SidebarMenu>
          {contentNav.filter(isVisible).map((item) => (
            <NavItemRow
              key={item.title}
              item={item}
              isActive={checkActive(item.url)}
              totalCount={totalCount}
              isActivelyDownloading={isActivelyDownloading}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>

      {/* Operations */}
      <SidebarGroup>
        <SidebarMenu>
          {operationsNav.filter(isVisible).map((item) => (
            <NavItemRow
              key={item.title}
              item={item}
              isActive={checkActive(item.url)}
              isIntelligenceActive={isIntelligenceActive}
              onAction={item.action ? actionHandlers[item.action] : undefined}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>

      {/* System — pinned to bottom */}
      <SidebarGroup className="mt-auto">
        <SidebarMenu>
          {filteredSystem.map((item) => (
            <NavItemRow
              key={item.title}
              item={item}
              isActive={checkActive(item.url)}
            />
          ))}
        </SidebarMenu>
      </SidebarGroup>
    </>
  );
}
