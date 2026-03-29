"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { useTheme } from "next-themes";
import {
  HugeiconsIcon,
  Search01Icon,
  Moon02Icon,
  Sun01Icon,
} from "@/components/icons";
import { useDownloads } from "@/hooks/use-downloads";
import { useAssistant } from "@/components/assistant/assistant-context";
import { cn } from "@/lib/utils";
import { allNav } from "./nav-config";
import { useUser } from "@/hooks/use-user";
import { NotificationsBell } from "@/components/notifications/notifications-bell";

interface MobileNavProps {
  open: boolean;
  onClose: () => void;
}

export function MobileNav({ open, onClose }: MobileNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { totalCount, isActivelyDownloading } = useDownloads(10000);
  const { status: aiStatus } = useAssistant();
  const isStreaming = aiStatus === "streaming" || aiStatus === "submitted";
  const [mounted, setMounted] = useState(false);
  const initialMount = useRef(true);
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = mounted && resolvedTheme === "dark";
  const { isAdmin, hasPermission } = useUser();
  const filteredNav = allNav.filter((item) => {
    if (item.adminOnly && !isAdmin) return false;
    if (item.permission && !hasPermission(item.permission)) return false;
    return true;
  });

  useEffect(() => setMounted(true), []);

  // Close on route change (skip the initial mount)
  useEffect(() => {
    if (initialMount.current) { initialMount.current = false; return; }
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    setTimeout(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
      );
    }, 150);
  }

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          {/* Floating panel */}
          <motion.div
            key="panel"
            className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(340px,calc(100vw-2rem))]"
            initial={{ opacity: 0, scale: 0.88, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.88, y: 16 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
          >
            <div className="rounded-2xl border border-border/60 bg-background/85 shadow-2xl backdrop-blur-2xl overflow-hidden">
              <div className="flex items-center justify-center px-4 pt-4 pb-2.5 gap-2.5">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-muted-foreground">
                  <circle cx="12" cy="4.5" r="1.7" opacity="1"/><circle cx="17.1" cy="7" r="1.27" opacity="0.56"/><circle cx="12" cy="9.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="12" r="1.27" opacity="0.56"/><circle cx="12" cy="14.5" r="1.7" opacity="1"/><circle cx="17.5" cy="17" r="1.27" opacity="0.56"/><circle cx="12" cy="19.5" r="0.72" opacity="0.12"/><circle cx="12" cy="4.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="7" r="1.27" opacity="0.56"/><circle cx="12" cy="9.5" r="1.7" opacity="1"/><circle cx="17.5" cy="12" r="1.27" opacity="0.56"/><circle cx="12" cy="14.5" r="0.72" opacity="0.12"/><circle cx="6.5" cy="17" r="1.27" opacity="0.56"/><circle cx="12" cy="19.5" r="1.7" opacity="1"/>
                </svg>
                <span className="text-sm font-medium tracking-tight">Talome</span>
              </div>

              {/* Nav grid */}
              <div className="grid grid-cols-3 gap-1 p-3">
                {filteredNav.map((item, i) => {
                  const active = isActive(item.url);
                  const showDownloadDot = item.title === "Media" && totalCount > 0;
                  const showAiDot = item.title === "Assistant" && isStreaming;
                  const shouldCenterSingleLastItem =
                    filteredNav.length % 3 === 1 && i === filteredNav.length - 1;

                  return (
                    <motion.button
                      key={item.title}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.04 + i * 0.028, duration: 0.22 }}
                      onClick={() => navigate(item.url)}
                      className={cn(
                        "relative flex flex-col items-center justify-center gap-1.5 rounded-xl w-full py-3 text-center transition-colors duration-150 select-none cursor-pointer",
                        shouldCenterSingleLastItem && "col-start-2",
                        active
                          ? "bg-primary/12 text-primary"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80"
                      )}
                    >
                      <div className="relative flex size-6 items-center justify-center">
                        <HugeiconsIcon icon={item.icon} size={22} strokeWidth={active ? 1.8 : 1.5} />
                        {(showDownloadDot || showAiDot) && (
                          <span className="absolute -top-1 -right-1 flex size-2">
                            {isActivelyDownloading || showAiDot ? (
                              <>
                                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60 opacity-75" />
                                <span className="relative inline-flex size-2 rounded-full bg-primary" />
                              </>
                            ) : (
                              <span className="relative inline-flex size-2 rounded-full bg-primary/80" />
                            )}
                          </span>
                        )}
                      </div>
                      <span className={cn("text-xs font-medium leading-none", active ? "text-primary" : "text-muted-foreground")}>
                        {item.title}
                      </span>
                    </motion.button>
                  );
                })}
              </div>

              {/* Footer — search, notifications, theme toggle */}
              <div className="flex items-center justify-around px-4 pb-3.5 pt-2 border-t border-border/40">
                <motion.button
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.32, duration: 0.2 }}
                  onClick={openSearch}
                  className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80 transition-colors duration-150 select-none cursor-pointer"
                  aria-label="Search"
                >
                  <HugeiconsIcon icon={Search01Icon} size={20} strokeWidth={1.5} />
                </motion.button>

                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.34, duration: 0.2 }}
                  className="flex items-center justify-center"
                >
                  <NotificationsBell
                    triggerClassName="size-10 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80 transition-colors duration-150 select-none cursor-pointer"
                    iconSize={20}
                    dotClassName="top-2 right-2"
                  />
                </motion.div>

                <motion.button
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.36, duration: 0.2 }}
                  onClick={() => setTheme(isDark ? "light" : "dark")}
                  className="flex items-center justify-center size-10 rounded-xl text-muted-foreground hover:bg-muted/60 hover:text-foreground active:bg-muted/80 transition-colors duration-150 select-none cursor-pointer"
                  aria-label="Toggle theme"
                >
                  <HugeiconsIcon icon={isDark ? Sun01Icon : Moon02Icon} size={20} strokeWidth={1.5} />
                </motion.button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body
  );
}
