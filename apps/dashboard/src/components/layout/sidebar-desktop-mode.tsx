"use client";

import { useRouter } from "next/navigation";
import { HugeiconsIcon, BrowserIcon } from "@/components/icons";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { useUser } from "@/hooks/use-user";
import {
  persistDashboardModePreference,
  useDesktopModeAvailable,
  writeDashboardModePreference,
} from "@/hooks/use-desktop-mode";
import { reportModeSave } from "@/lib/dashboard-mode-save";

export function SidebarDesktopMode() {
  const router = useRouter();
  const available = useDesktopModeAvailable();
  const { user, mutate } = useUser();
  if (!available) return null;

  const save = () => {
    void persistDashboardModePreference(user?.userId, "desktop").then((saved) => {
      if (saved) void mutate();
      reportModeSave(saved, "desktop", save);
    });
  };

  const switchMode = () => {
    writeDashboardModePreference(user?.userId, "desktop");
    void mutate((current) => current ? {
      ...current,
      preferences: { ...current.preferences, desktopMode: "desktop" },
    } : current, { revalidate: false });
    router.push("/dashboard/desktop");
    save();
  };

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={switchMode}
        tooltip="Desktop mode"
        className="text-muted-foreground hover:text-foreground"
      >
        <HugeiconsIcon icon={BrowserIcon} size={16} className="shrink-0" aria-hidden="true" />
        <span>Desktop mode</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
