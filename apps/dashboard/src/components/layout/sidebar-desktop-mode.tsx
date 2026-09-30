"use client";

import { useRouter } from "next/navigation";
import { AppWindowMacIcon } from "lucide-react";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useUser } from "@/hooks/use-user";
import {
  persistDashboardModePreference,
  useDesktopModeAvailable,
  writeDashboardModePreference,
} from "@/hooks/use-desktop-mode";

export function SidebarDesktopMode() {
  const router = useRouter();
  const available = useDesktopModeAvailable();
  const { user, mutate } = useUser();
  if (!available) return null;

  const switchMode = () => {
    writeDashboardModePreference(user?.userId, "desktop");
    void mutate((current) => current ? {
      ...current,
      preferences: { ...current.preferences, desktopMode: "desktop" },
    } : current, { revalidate: false });
    router.push("/dashboard/desktop");
    void persistDashboardModePreference(user?.userId, "desktop").then((saved) => {
      if (saved) void mutate();
    });
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={switchMode}
        tooltip="Desktop mode"
        className="text-muted-foreground hover:text-foreground"
      >
        <AppWindowMacIcon className="size-4 shrink-0" aria-hidden="true" />
        <span>Desktop mode</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
