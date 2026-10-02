"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Dialog as DialogPrimitive } from "radix-ui";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import {
  HugeiconsIcon,
  Search01Icon,
  Moon02Icon,
  Sun01Icon,
  Logout01Icon,
  UserIcon,
} from "@/components/icons";
import { adaptiveDownloadsInterval, useDownloads } from "@/hooks/use-downloads";
import { useAssistant } from "@/components/assistant/assistant-context";
import { usePendingApprovals } from "@/components/trust/api";
import { Badge } from "@/components/ui/badge";
import { TalomeMark } from "@/components/talome-mark";
import { cn } from "@/lib/utils";
import { DURATION, EASE_EXIT, enter } from "@/lib/motion";
import { openPalette } from "@/lib/palette";
import { logOut, roleLabel } from "@/lib/session";
import { allNav, approvalsNavItem, visibleNavItems, type NavItem } from "./nav-config";
import { useUser } from "@/hooks/use-user";
import { NotificationsBell } from "@/components/notifications/notifications-bell";

/** Nav download badge: 10s while something is downloading, 30s otherwise. */
const NAV_DOWNLOADS_INTERVAL = adaptiveDownloadsInterval(10_000);

/** A modal panel (spec §3.2): opacity and scale 0.98→1 in 180ms, out in 140ms; scrim fades in 150ms. No spring, no stagger. */
const PANEL_ENTER = enter(DURATION.base);
const PANEL_EXIT = { duration: DURATION.exit, ease: EASE_EXIT } as const;
const SCRIM_ENTER = { duration: DURATION.fast, ease: EASE_EXIT } as const;

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

/** The items the mobile panel shows: the nav, plus Approvals while an admin has some waiting. */
export function mobileNavItems(
  viewer: { isAdmin: boolean; hasPermission: Parameters<typeof visibleNavItems>[1]["hasPermission"] },
  pendingApprovals: number,
): NavItem[] {
  const items = visibleNavItems(allNav, viewer);
  if (viewer.isAdmin && pendingApprovals > 0) {
    const settingsIndex = items.findIndex((item) => item.url === "/dashboard/settings");
    const at = settingsIndex >= 0 ? settingsIndex : items.length;
    return [...items.slice(0, at), approvalsNavItem, ...items.slice(at)];
  }
  return items;
}

export function MobileNav({ open, onClose }: MobileNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  // 10s while something is downloading, 30s otherwise
  const { totalCount, isActivelyDownloading } = useDownloads(NAV_DOWNLOADS_INTERVAL);
  const { status: aiStatus } = useAssistant();
  const isStreaming = aiStatus === "streaming" || aiStatus === "submitted";
  const [mounted, setMounted] = useState(false);
  const initialMount = useRef(true);
  const panelRef = useRef<HTMLDivElement>(null);
  /** Where focus was when the panel opened (the menu button); it goes back there on close. */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const reduceMotion = useReducedMotion();
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = mounted && resolvedTheme === "dark";
  const { user, isAdmin, hasPermission } = useUser();
  const { count: pendingApprovals } = usePendingApprovals(isAdmin);
  const items = mobileNavItems({ isAdmin, hasPermission }, pendingApprovals);
  const accountName = user?.username ?? user?.email ?? "Account";

  useEffect(() => setMounted(true), []);

  // Close on route change (skip the initial mount)
  useEffect(() => {
    if (initialMount.current) { initialMount.current = false; return; }
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Escape, the scrim, the focus trap and hiding the page behind from
  // assistive tech come from the Radix dialog below (spec §6.3).

  function isActive(url: string) {
    if (url === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(url);
  }

  function navigate(url: string) {
    router.push(url);
    onClose();
  }

  function openSearch() {
    onClose();
    openPalette({ mode: "search" });
  }

  async function handleLogOut() {
    const result = await logOut();
    if (result.ok) {
      onClose();
      router.push("/");
      return;
    }
    toast.error(result.error, { action: { label: "Retry", onClick: () => void handleLogOut() } });
  }

  if (!mounted) return null;

  const iconButtonClass =
    "flex items-center justify-center size-11 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80 transition-colors duration-150 select-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        onClose();
      }}
    >
      <AnimatePresence>
        {open && (
          <DialogPrimitive.Portal forceMount>
            {/* Scrim */}
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                key="backdrop"
                className="fixed inset-0 z-50 bg-scrim"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1, transition: SCRIM_ENTER }}
                exit={{ opacity: 0, transition: PANEL_EXIT }}
              />
            </DialogPrimitive.Overlay>

            {/* Floating panel: a modal dialog, so Tab stays inside and the page behind is hidden. */}
            <DialogPrimitive.Content
              asChild
              forceMount
              aria-describedby={undefined}
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                panelRef.current?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                returnFocusRef.current?.focus?.();
              }}
            >
          <motion.div
            key="panel"
            ref={panelRef}
            tabIndex={-1}
            className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(340px,calc(100vw-2rem))] outline-none"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1, transition: PANEL_ENTER }}
            exit={reduceMotion
              ? { opacity: 0, transition: PANEL_EXIT }
              : { opacity: 0, scale: 0.98, transition: PANEL_EXIT }}
          >
            <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
            <div className="rounded-2xl border border-border bg-surface-modal shadow-lg max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
              <div className="flex items-center justify-center px-4 pt-4 pb-2.5 gap-2.5">
                <TalomeMark size={16} className="text-muted-foreground" />
                <span className="text-sm font-medium tracking-tight">Talome</span>
              </div>

              {/* Nav grid */}
              <nav aria-label="Main" className="grid grid-cols-3 gap-1 p-3">
                {items.map((item, i) => {
                  const active = isActive(item.url);
                  const showDownloadDot = item.title === "Media" && totalCount > 0;
                  const working = (showDownloadDot && isActivelyDownloading) || (item.title === "Assistant" && isStreaming);
                  const approvals = item.url === approvalsNavItem.url ? pendingApprovals : 0;
                  const shouldCenterSingleLastItem =
                    items.length % 3 === 1 && i === items.length - 1;

                  return (
                    <button
                      key={item.url}
                      type="button"
                      onClick={() => navigate(item.url)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "relative flex flex-col items-center justify-center gap-1.5 rounded-xl w-full min-h-16 py-3 text-center transition-colors duration-150 select-none cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        shouldCenterSingleLastItem && "col-start-2",
                        active
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80"
                      )}
                    >
                      <div className="relative flex size-6 items-center justify-center">
                        <HugeiconsIcon icon={item.icon} size={22} strokeWidth={active ? 1.8 : 1.5} />
                        {working ? (
                          <span
                            aria-hidden="true"
                            data-nav-indicator="working"
                            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-status-info motion-safe:animate-breathe"
                          />
                        ) : null}
                        {approvals > 0 ? (
                          <Badge variant="count" aria-hidden="true" className="absolute -top-1.5 -right-2.5" data-nav-indicator="needs-you">
                            {approvals}
                          </Badge>
                        ) : null}
                      </div>
                      <span className={cn("text-xs font-medium leading-none", active ? "text-foreground" : "text-muted-foreground")}>
                        {item.title}
                      </span>
                      {working ? <span className="sr-only">{item.title === "Assistant" ? ", replying" : ", downloading"}</span> : null}
                      {approvals > 0 ? <span className="sr-only">{`, ${approvals} waiting`}</span> : null}
                    </button>
                  );
                })}
              </nav>

              {/* Account */}
              <div className="flex items-center gap-3 border-t border-border px-4 py-3">
                <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-lg" aria-hidden="true">
                  <HugeiconsIcon icon={UserIcon} size={16} />
                </div>
                <div className="grid min-w-0 flex-1 leading-tight">
                  <span className="truncate text-sm font-medium">{accountName}</span>
                  <span className="truncate text-xs text-muted-foreground">{roleLabel(user?.role)}</span>
                </div>
                <button
                  type="button"
                  onClick={() => void handleLogOut()}
                  className="flex h-11 items-center gap-1.5 rounded-xl px-3 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <HugeiconsIcon icon={Logout01Icon} size={16} aria-hidden="true" />
                  Log out
                </button>
              </div>

              {/* Footer — search, notifications, theme toggle */}
              <div className="flex items-center justify-around px-4 pb-3.5 pt-2 border-t border-border">
                <button type="button" onClick={openSearch} className={iconButtonClass} aria-label="Search">
                  <HugeiconsIcon icon={Search01Icon} size={20} strokeWidth={1.5} />
                </button>

                <div className="flex items-center justify-center">
                  <NotificationsBell
                    triggerClassName="size-11 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80 transition-colors duration-150 select-none cursor-pointer"
                    iconSize={20}
                    dotClassName="top-2.5 right-2.5"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => setTheme(isDark ? "light" : "dark")}
                  className={iconButtonClass}
                  aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
                >
                  <HugeiconsIcon icon={isDark ? Sun01Icon : Moon02Icon} size={20} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
