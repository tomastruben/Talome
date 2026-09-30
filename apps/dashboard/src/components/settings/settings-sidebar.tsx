"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import { HugeiconsIcon, Search01Icon, Settings01Icon } from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import { useUser } from "@/hooks/use-user";
import { cn } from "@/lib/utils";
import { SETTINGS_CATEGORIES } from "@/components/settings/settings-nav";
import { usePendingApprovals } from "@/components/trust/api";
import { DURATION, EASE_ENTER } from "@/lib/motion";

function SidebarLink({ href, icon, title, active, badge }: { href: string; icon: IconSvgElement; title: string; active: boolean; badge?: number }) {
  const reduceMotion = useReducedMotion();
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex h-8 items-center gap-2.5 rounded-lg px-2 text-sm transition-colors duration-150 ease-out",
        active ? "text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {/* One highlight that slides to the section you pick */}
      {active && (
        <motion.span
          layoutId="settings-sidebar-selection"
          className="absolute inset-0 -z-10 rounded-lg bg-muted"
          transition={reduceMotion ? { duration: 0 } : { duration: DURATION.base, ease: EASE_ENTER }}
        />
      )}
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md transition-colors duration-150",
          active ? "bg-foreground/10 text-foreground" : "bg-muted/60 text-muted-foreground",
        )}
      >
        <HugeiconsIcon icon={icon} size={14} />
      </span>
      <span className="truncate">{title}</span>
      {/* Amber count = needs you (status grammar); only approvals carry one. */}
      {badge ? (
        <span className="ml-auto rounded-full bg-status-warning/15 px-1.5 text-xs font-medium tabular-nums text-status-warning">
          {badge}
          <span className="sr-only"> waiting</span>
        </span>
      ) : null}
    </Link>
  );
}

/** System Settings–style sidebar: search, General, then grouped sections. */
export function SettingsSidebar() {
  const pathname = usePathname();
  const { isAdmin } = useUser();
  const { count: pendingApprovals } = usePendingApprovals(isAdmin);
  const [query, setQuery] = useState("");

  const categories = useMemo(() => {
    const q = query.trim().toLowerCase();
    return SETTINGS_CATEGORIES.map((category) => ({
      ...category,
      items: category.items.filter(
        (item) =>
          (!item.adminOnly || isAdmin) &&
          (!q || item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)),
      ),
    })).filter((category) => category.items.length > 0);
  }, [isAdmin, query]);

  const showGeneral = !query.trim() || "general dark mode server mode services log out".includes(query.trim().toLowerCase());

  return (
    <nav aria-label="Settings sections" className="isolate flex flex-col gap-4">
      <label className="relative block">
        <span className="sr-only">Search settings</span>
        <HugeiconsIcon
          icon={Search01Icon}
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          className="h-8 w-full rounded-lg border border-border bg-muted/40 pl-8 pr-2 text-sm placeholder:text-muted-foreground outline-none transition-colors duration-150 focus:border-foreground/30 focus:bg-muted/60"
        />
      </label>

      {showGeneral && (
        <SidebarLink href="/dashboard/settings" icon={Settings01Icon} title="General" active={pathname === "/dashboard/settings"} />
      )}

      {categories.map((category) => (
        <div key={category.label} className="flex flex-col gap-0.5">
          <p className="px-2 pb-1 text-xs text-muted-foreground">{category.label}</p>
          {category.items.map((item) => (
            <SidebarLink
              key={item.slug}
              href={`/dashboard/settings/${item.slug}`}
              icon={item.icon}
              title={item.title}
              active={pathname === `/dashboard/settings/${item.slug}`}
              badge={item.slug === "approvals" ? pendingApprovals : undefined}
            />
          ))}
        </div>
      ))}

      {categories.length === 0 && !showGeneral && (
        <p className="px-2 text-sm text-muted-foreground">No settings match “{query.trim()}”.</p>
      )}
    </nav>
  );
}
