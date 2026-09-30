"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  HugeiconsIcon,
  UserIcon,
  Logout01Icon,
  MoreHorizontalIcon,
  Sun01Icon,
  Moon02Icon,
} from "@/components/icons";
import { toast } from "sonner";
import { useUser } from "@/hooks/use-user";
import { logOut, roleLabel } from "@/lib/session";

const subscribeToHydration = () => () => {};

export function NavUser() {
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();
  // Track hydration so theme-dependent content renders correctly.
  // The DropdownMenu wrapper is always rendered to keep a stable component
  // tree — the previous conditional early-return produced a different tree
  // depth for SidebarMenuButton, shifting every subsequent React.useId()
  // and causing Radix UI ID mismatches during hydration.
  const mounted = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const isDark = mounted && resolvedTheme === "dark";
  const { user } = useUser();
  const name = user?.username ?? user?.email ?? "Account";
  const role = roleLabel(user?.role);

  const handleLogOut = async () => {
    const result = await logOut();
    if (result.ok) {
      router.push("/");
      return;
    }
    toast.error(result.error, { action: { label: "Retry", onClick: () => void handleLogOut() } });
  };

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" tooltip={`${name} · ${role}`}>
              <div className="bg-muted flex aspect-square size-8 items-center justify-center rounded-lg">
                <HugeiconsIcon icon={UserIcon} size={18} />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">{name}</span>
                <span className="truncate text-xs text-muted-foreground">{role}</span>
              </div>
              <HugeiconsIcon icon={MoreHorizontalIcon} size={16} className="ml-auto" aria-hidden="true" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" side="top" align="start" sideOffset={4}>
            <DropdownMenuItem onSelect={() => setTheme(isDark ? "light" : "dark")}>
              <HugeiconsIcon icon={isDark ? Sun01Icon : Moon02Icon} size={16} />
              <span>{isDark ? "Light mode" : "Dark mode"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void handleLogOut()}>
              <HugeiconsIcon icon={Logout01Icon} size={16} />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
