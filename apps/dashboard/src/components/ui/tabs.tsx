"use client";

import type { HTMLAttributes } from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

type TabsVariant = "default" | "underline";

// ── Root ─────────────────────────────────────────────────────────────────────

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      className={cn(
        "flex flex-col gap-2 data-[orientation=vertical]:flex-row",
        className,
      )}
      data-slot="tabs"
      {...props}
    />
  );
}

// ── List ─────────────────────────────────────────────────────────────────────

function TabsList({
  variant = "default",
  className,
  children,
  ...props
}: TabsPrimitive.List.Props & {
  variant?: TabsVariant;
}) {
  return (
    <TabsPrimitive.List
      className={cn(
        "relative z-0 flex w-fit items-center justify-center gap-x-0.5 text-muted-foreground",
        "data-[orientation=vertical]:flex-col",
        variant === "default"
          ? "h-9 rounded-lg bg-muted p-0.5 text-muted-foreground"
          : "data-[orientation=vertical]:px-1 data-[orientation=horizontal]:py-1 *:data-[slot=tabs-tab]:hover:bg-accent",
        className,
      )}
      data-slot="tabs-list"
      {...props}
    >
      {children}
      <TabsPrimitive.Indicator
        className={cn(
          "-translate-y-(--active-tab-bottom) absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) transition-[width,translate] duration-200 ease-in-out",
          variant === "underline"
            ? "data-[orientation=vertical]:-translate-x-px z-10 bg-primary data-[orientation=horizontal]:h-0.5 data-[orientation=vertical]:w-0.5 data-[orientation=horizontal]:translate-y-px"
            : "-z-1 rounded-md bg-background shadow-sm/5 dark:bg-input",
        )}
        data-slot="tab-indicator"
      />
    </TabsPrimitive.List>
  );
}

// ── Tab trigger ───────────────────────────────────────────────────────────────

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "[&_svg]:-mx-0.5 relative flex h-[30px] shrink-0 grow cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] border border-transparent px-2.5 text-sm font-medium outline-none transition-[color,background-color,box-shadow] hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring data-disabled:pointer-events-none data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start data-active:text-foreground data-disabled:opacity-64 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="tabs-tab"
      suppressHydrationWarning
      {...props}
    />
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn("flex-1 outline-none", className)}
      data-slot="tabs-content"
      suppressHydrationWarning
      {...props}
    />
  );
}

// ── TabsBadge — count chip inside a tab trigger ───────────────────────────────
// Usage: <TabsTab value="running">Running <TabsBadge>14</TabsBadge></TabsTab>

function TabsBadge({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center min-w-[1.25rem] h-4 rounded-sm px-1",
        "bg-foreground/8 text-muted-foreground text-xs font-medium tabular-nums",
        "group-data-[active]:bg-foreground/10 group-data-[active]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

// ── TabsDot — colored status dot inside a tab trigger ────────────────────────
// Usage: <TabsTab value="running"><TabsDot color="emerald" />Running</TabsTab>

type DotColor = "emerald" | "red" | "amber" | "sky" | "blue" | "muted";

const dotColorMap: Record<DotColor, string> = {
  emerald: "bg-status-healthy",
  red:     "bg-status-critical",
  amber:   "bg-status-warning",
  sky:     "bg-status-info",
  blue:    "bg-status-info",
  muted:   "bg-muted-foreground/40",
};

function TabsDot({
  color = "muted",
  pulse = false,
  className,
}: {
  color?: DotColor;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative flex size-1.5 shrink-0", className)}>
      {pulse && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
            dotColorMap[color],
          )}
        />
      )}
      <span className={cn("relative inline-flex size-1.5 rounded-full", dotColorMap[color])} />
    </span>
  );
}

export {
  Tabs,
  TabsList,
  TabsTab,
  TabsTab as TabsTrigger,
  TabsPanel,
  TabsPanel as TabsContent,
  TabsBadge,
  TabsDot,
  TabsPrimitive,
};
