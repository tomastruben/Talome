"use client";

import { useCallback } from "react";
import Link from "next/link";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";
import { SidebarNotifications } from "@/components/notifications/sidebar-notifications";
import { SidebarAudioPlayer } from "@/components/audiobooks/sidebar-audio-player";
import { SidebarOptimization } from "@/components/media/sidebar-optimization";
import { HugeiconsIcon, Search01Icon } from "@/components/icons";

function useOpenCommandPalette() {
  return useCallback(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
    );
  }, []);
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const openPalette = useOpenCommandPalette();

  return (
    <Sidebar collapsible="icon" variant="inset" className="hidden md:flex" {...props}>
      <SidebarHeader className="p-0">
        <div className="px-2 pt-2">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                tooltip="Talome"
                className="hover:bg-transparent active:bg-transparent"
              >
                <Link href="/dashboard" className="flex items-center gap-2.5">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="4.5" r="1.7" opacity="1"/><circle cx="17.1" cy="7" r="1.27" opacity="0.56"/><circle cx="12" cy="9.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="12" r="1.27" opacity="0.56"/><circle cx="12" cy="14.5" r="1.7" opacity="1"/><circle cx="17.5" cy="17" r="1.27" opacity="0.56"/><circle cx="12" cy="19.5" r="0.72" opacity="0.12"/><circle cx="12" cy="4.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="7" r="1.27" opacity="0.56"/><circle cx="12" cy="9.5" r="1.7" opacity="1"/><circle cx="17.5" cy="12" r="1.27" opacity="0.56"/><circle cx="12" cy="14.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="17" r="1.27" opacity="0.56"/><circle cx="12" cy="19.5" r="1.7" opacity="1"/>
                  </svg>
                  <span className="truncate text-sm font-medium tracking-tight group-data-[collapsible=icon]:hidden">
                    Talome
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>

        <div className="p-2 pt-1.5 group-data-[collapsible=icon]:p-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={openPalette}
                tooltip="Search (⌘K)"
                className="text-muted-foreground hover:text-foreground"
              >
                <HugeiconsIcon icon={Search01Icon} size={15} className="shrink-0" />
                <span className="flex-1 text-sm group-data-[collapsible=icon]:hidden">Search...</span>
                <kbd className="pointer-events-none ml-auto inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-xs font-medium text-muted-foreground opacity-100 group-data-[collapsible=icon]:hidden">
                  <span className="text-xs">⌘</span>K
                </kbd>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <NavMain />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarAudioPlayer />
          <SidebarOptimization />
          <SidebarNotifications />
        </SidebarMenu>
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
