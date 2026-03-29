"use client";

import { useIsOnline } from "@/hooks/use-is-online";
import { Wifi01Icon, AlertCircleIcon } from "@/components/icons";
import { Banner, BannerClose, BannerIcon, BannerTitle } from "@/components/kibo-ui/banner";

export function SystemHealthBanner() {
  const { status } = useIsOnline();

  if (status === "online") return null;

  const isOffline = status === "offline";

  return (
    <Banner
      key={status}
      className={
        isOffline
          ? "bg-destructive text-destructive-foreground rounded-none border-b border-destructive/20 motion-safe:animate-in motion-safe:slide-in-from-top-1 motion-safe:fade-in-80"
          : "bg-status-warning text-white rounded-none border-b border-status-warning/30 motion-safe:animate-in motion-safe:slide-in-from-top-1 motion-safe:fade-in-80"
      }
    >
      <div className="flex items-center gap-2.5">
        <BannerIcon
          icon={isOffline ? Wifi01Icon : AlertCircleIcon}
          className="border-white/20 bg-white/10 motion-safe:animate-pulse"
        />
        <BannerTitle className="text-xs font-medium">
          {isOffline
            ? "Talome server is unreachable — check that it is running"
            : "Some services are degraded — Docker or database may be down"}
        </BannerTitle>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="relative flex size-1.5 shrink-0">
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${
              isOffline ? "bg-destructive-foreground" : "bg-white"
            }`}
          />
          <span
            className={`relative inline-flex size-1.5 rounded-full ${
              isOffline ? "bg-destructive-foreground" : "bg-white"
            }`}
          />
        </span>
        <BannerClose
          aria-label="Dismiss system health banner"
          className="h-6 w-6 text-current hover:bg-white/10"
        />
      </div>
    </Banner>
  );
}
