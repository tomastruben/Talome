"use client";

import { AnimatePresence, motion } from "framer-motion";
import { HugeiconsIcon, Cancel01Icon } from "@/components/icons";
import { allNav, type NavItem } from "@/components/layout/nav-config";
import {
  LauncherWidget,
  type LaunchableApp,
} from "@/components/widgets/launcher-widget";
import { Button } from "@/components/ui/button";
import { useUser } from "@/hooks/use-user";

interface DesktopLaunchpadProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLaunch: (item: NavItem) => void;
  onLaunchService: (app: LaunchableApp) => void;
}
export function DesktopLaunchpad({
  open,
  onOpenChange,
  onLaunch,
  onLaunchService,
}: DesktopLaunchpadProps) {
  const { user, hasPermission } = useUser();
  const apps = allNav.filter((item) => {
    if (item.action) return false;
    if (item.url === "/dashboard") return false;
    if (item.adminOnly && user?.role !== "admin") return false;
    return !item.permission || hasPermission(item.permission);
  });

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-background/95 px-6 pt-20 pb-28 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          role="dialog"
          aria-modal="true"
          aria-label="Launchpad"
        >
          <motion.div
            className="w-full max-w-4xl"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            <div className="mb-6 flex items-center justify-between">
              <h1 className="text-2xl font-medium">Launchpad</h1>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-foreground"
                onClick={() => onOpenChange(false)}
                aria-label="Close Launchpad"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={18} />
              </Button>
            </div>

            <section aria-labelledby="talome-applications" className="grid gap-4">
              <h2 id="talome-applications" className="text-sm font-medium text-muted-foreground">
                Applications
              </h2>
              <div className="grid grid-cols-4 gap-6 sm:grid-cols-6 lg:grid-cols-8">
                {apps.map((item) => (
                  <button
                    key={item.url}
                    type="button"
                    className="group flex min-w-0 flex-col items-center gap-2 rounded-xl px-2 py-3 transition-colors duration-150 hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => onLaunch(item)}
                  >
                    <span className="flex size-14 items-center justify-center rounded-xl border border-border bg-card transition-colors duration-150 group-hover:border-foreground/20">
                      <HugeiconsIcon icon={item.icon} size={26} strokeWidth={1.4} />
                    </span>
                    <span className="w-full truncate text-center text-xs text-muted-foreground group-hover:text-foreground">
                      {item.title}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section aria-labelledby="installed-services" className="mt-8 grid gap-4">
              <h2 id="installed-services" className="text-sm font-medium text-muted-foreground">
                Installed services
              </h2>
              <div className="min-h-36 overflow-hidden rounded-xl">
                <LauncherWidget onLaunch={onLaunchService} />
              </div>
            </section>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
