"use client";

import { useState, useEffect } from "react";
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
import { CORE_URL } from "@/lib/constants";

export function NavUser() {
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();
  // Track hydration so theme-dependent content renders correctly.
  // The DropdownMenu wrapper is always rendered to keep a stable component
  // tree — the previous conditional early-return produced a different tree
  // depth for SidebarMenuButton, shifting every subsequent React.useId()
  // and causing Radix UI ID mismatches during hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = mounted && resolvedTheme === "dark";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg">
              <div className="bg-muted flex aspect-square size-8 items-center justify-center rounded-lg">
                <HugeiconsIcon icon={UserIcon} size={18} />
              </div>
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">Admin</span>
                <span className="truncate text-sm text-muted-foreground">Local</span>
              </div>
              <HugeiconsIcon icon={MoreHorizontalIcon} size={16} className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" side="top" align="start" sideOffset={4}>
            <DropdownMenuItem onSelect={() => setTheme(isDark ? "light" : "dark")}>
              <HugeiconsIcon icon={isDark ? Sun01Icon : Moon02Icon} size={16} />
              <span>{isDark ? "Light mode" : "Dark mode"}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                await fetch(`${CORE_URL}/api/auth/logout`, {
                  method: "POST",
                  credentials: "include",
                });
                router.push("/");
              }}
            >
              <HugeiconsIcon icon={Logout01Icon} size={16} />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
