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
import { adaptiveDownloadsInterval, useDownloads } from "@/hooks/use-downloads";
import { useUser } from "@/hooks/use-user";
import { CORE_URL } from "@/lib/constants";
import { usePendingApprovals } from "@/components/trust/api";
import { Badge } from "@/components/ui/badge";
import { startNav, contentNav, operationsNav, systemNav, approvalsNavItem, canSeeNavItem } from "./nav-config";
import type { NavItem } from "./nav-config";

/** Nav download badge: 10s while something is downloading, 30s otherwise. */
const NAV_DOWNLOADS_INTERVAL = adaptiveDownloadsInterval(10_000);

/**
 * One status grammar (spec §4.6): a breathing info dot means work in flight,
 * a plain muted number is a quantity, and only "needs you" gets the amber
 * count badge. Every indicator carries screen-reader text.
 */
function WorkingDot({ label }: { label: string }) {
  return (
    <span className="ml-auto flex items-center" data-nav-indicator="working">
      <span aria-hidden="true" className="size-1.5 rounded-full bg-status-info motion-safe:animate-breathe" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function NavItemRow({ item, isActive, totalCount, isActivelyDownloading, isStreaming, isIntelligenceActive, badgeCount, onAction }: {
  item: NavItem;
  isActive: boolean;
  totalCount?: number;
  isActivelyDownloading?: boolean;
  isStreaming?: boolean;
  isIntelligenceActive?: boolean;
  /** "Needs you" count (pending approvals): the amber count badge. */
  badgeCount?: number;
  onAction?: () => void;
}) {
  const content = (
    <>
      <HugeiconsIcon icon={item.icon} size={20} />
      <span>{item.title}</span>
      {item.title === "Media" && totalCount !== undefined && totalCount > 0 && (
        isActivelyDownloading ? (
          <WorkingDot label="Downloading" />
        ) : (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground" data-nav-indicator="quantity">
            {totalCount}
            <span className="sr-only"> in the download queue</span>
          </span>
        )
      )}
      {item.title === "Assistant" && isStreaming && <WorkingDot label="Assistant is replying" />}
      {item.title === "Intelligence" && isIntelligenceActive && <WorkingDot label="Self-improvement running" />}
      {badgeCount !== undefined && badgeCount > 0 && (
        <Badge variant="count" className="ml-auto" data-nav-indicator="needs-you">
          {badgeCount}
          <span className="sr-only"> waiting</span>
        </Badge>
      )}
    </>
  );

  return (
    <SidebarMenuItem>
      {onAction ? (
        <SidebarMenuButton isActive={isActive} onClick={onAction} tooltip={item.title}>
          {content}
        </SidebarMenuButton>
      ) : (
        <SidebarMenuButton asChild isActive={isActive} tooltip={item.title}>
          <Link href={item.url} aria-current={isActive ? "page" : undefined}>{content}</Link>
        </SidebarMenuButton>
      )}
    </SidebarMenuItem>
  );
}

export function NavMain() {
  const pathname = usePathname();
  // 10s while something is downloading, 30s otherwise
  const { totalCount, isActivelyDownloading } = useDownloads(NAV_DOWNLOADS_INTERVAL);
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

  // Agent actions waiting for an admin (shares the SWR cache with Settings).
  const { count: pendingApprovals } = usePendingApprovals(isAdmin);

  const actionHandlers: Record<string, () => void> = {
    "bug-hunt": () => bugHunt.open(),
  };

  const isVisible = (item: NavItem) => canSeeNavItem(item, { isAdmin, hasPermission });

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
          {isAdmin && pendingApprovals > 0 && (
            <NavItemRow
              item={approvalsNavItem}
              isActive={checkActive(approvalsNavItem.url)}
              badgeCount={pendingApprovals}
            />
          )}
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
