"use client";

import { useIsOnline } from "@/hooks/use-is-online";
import { Wifi01Icon, AlertCircleIcon } from "@/components/icons";
import { Banner, BannerClose, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";
import { cn } from "@/lib/utils";

/**
 * Tint recipe only (spec §2.2: a solid banner is never used). A solid
 * bg-destructive / bg-status-warning fill with white text fails AA in dark
 * mode, where the status fills are light.
 */
export const HEALTH_BANNER_TONE = {
  offline: {
    banner: "bg-status-critical/12 border-status-critical/30",
    accent: "text-status-critical",
    dot: "bg-status-critical",
  },
  degraded: {
    banner: "bg-status-warning/12 border-status-warning/30",
    accent: "text-status-warning",
    dot: "bg-status-warning",
  },
} as const;

export function SystemHealthBanner() {
  const { status } = useIsOnline();

  if (status === "online") return null;

  const isOffline = status === "offline";
  const tone = isOffline ? HEALTH_BANNER_TONE.offline : HEALTH_BANNER_TONE.degraded;

  return (
    <Banner
      key={status}
      role="status"
      className={cn(
        "text-foreground rounded-none border-b motion-safe:animate-in motion-safe:slide-in-from-top-1 motion-safe:fade-in-80",
        tone.banner,
      )}
    >
      <div className="flex items-center gap-2.5">
        <BannerIcon
          icon={isOffline ? Wifi01Icon : AlertCircleIcon}
          className={cn("border-current/20 bg-transparent shadow-none", tone.accent)}
        />
        <BannerTitle className="text-xs font-medium">
          {isOffline
            ? "Talome server is unreachable — check that it is running"
            : "Some services are degraded — Docker or database may be down"}
        </BannerTitle>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
          <span
            className={cn("absolute inline-flex h-full w-full motion-safe:animate-ping rounded-full opacity-75", tone.dot)}
          />
          <span className={cn("relative inline-flex size-1.5 rounded-full", tone.dot)} />
        </span>
        <BannerClose
          aria-label="Dismiss system health banner"
          className="h-6 w-6 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        />
      </div>
    </Banner>
  );
}
