"use client";

import Image from "next/image";
import { useMemo } from "react";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import { Widget } from "./widget";
import {
  HugeiconsIcon,
  PackageOpenIcon,
} from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { getHostUrl } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  resolveApplicationIcon,
  resolveApplicationIconUrl,
} from "@/components/native-app/native-app-icons";
import type { Container, ServiceStack } from "@talome/types";

export interface LaunchableApp {
  id: string;
  name: string;
  url: string;
  icon?: string;
  iconUrl?: string;
  container: Container;
  /** Identifies distinct instances of an app without exposing Docker service names. */
  collection?: string;
}

/** Native contracts and discovered/declared browser interfaces only, never arbitrary TCP ports. */
export function extractLaunchableApps(stacks: ServiceStack[]): LaunchableApp[] {
  const apps: LaunchableApp[] = [];

  for (const stack of stacks) {
    const nativePrimary = stack.nativeSurface && stack.storeId && stack.appId
      ? stack.primaryContainer
      : null;
    if (nativePrimary?.status === "running") {
      const primaryIcon = stack.containerIcons?.[nativePrimary.id];
      apps.push({
        id: nativePrimary.name,
        name: stack.name,
        url: `${typeof window === "undefined" ? "http://localhost:3000" : window.location.origin}/dashboard/native-apps/${encodeURIComponent(stack.storeId!)}/${encodeURIComponent(stack.appId!)}`,
        icon: stack.icon ?? primaryIcon?.icon,
        iconUrl: stack.iconUrl ?? primaryIcon?.iconUrl,
        container: nativePrimary,
      });
      // A native AppSpec represents the whole stack. Its internal API/database
      // containers are implementation details, not separate Launchpad apps.
      continue;
    }

    for (const container of stack.containers) {
      if (container.status !== "running") continue;
      const ui = container.webUi;
      if (!ui) continue;

      // Resolve icon: per-container icon from stack, then stack-level icon
      const containerIcon = stack.containerIcons?.[container.id];
      const iconUrl = containerIcon?.iconUrl ?? stack.iconUrl;
      const icon = containerIcon?.icon ?? stack.icon;
      const pageTitle = ui.title?.replace(/\s+(WebUI|Web UI)$/i, "").replace(/^(Sign in|Log in|Login)\s*[-|–:]\s*/i, "").trim();
      const detectedName = /\/supabase\/studio:/.test(container.image) ? "Supabase Studio" : pageTitle;
      const uiOwnerIcon = Object.values(stack.containerIcons ?? {}).find(metadata => metadata.name?.toLocaleLowerCase() === detectedName?.toLocaleLowerCase());
      const catalogName = containerIcon?.name ?? (stack.containers.length === 1 && (stack.kind === "talome" || stack.icon || stack.iconUrl) ? stack.name : undefined);
      const name = (ui.source === "configured" ? ui.title : undefined) || uiOwnerIcon?.name
        || (/gluetun/i.test(container.image) ? detectedName : catalogName)
        || (detectedName && !/^(Web app|Login|Sign in|Welcome|Home)$/i.test(detectedName) ? detectedName : container.name);
      const project = container.labels?.["com.docker.compose.project"];

      apps.push({
        // Container names survive image upgrades/recreation, unlike Docker IDs.
        id: container.name,
        name,
        url: `${getHostUrl(ui.port).replace(/^http:/, `${ui.protocol}:`)}${ui.path}`,
        // A VPN can publish another container's interface (e.g. qBittorrent).
        icon: uiOwnerIcon?.icon ?? icon,
        iconUrl: uiOwnerIcon?.iconUrl ?? iconUrl,
        container,
        collection: project ? project.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()).replace(/\bOs\b/g, "OS") : undefined,
      });
    }
  }

  return apps;
}

export function LaunchableAppIcon({ app, iconClassName, className }: { app: LaunchableApp; iconClassName?: string; className?: string }) {
  const realIconUrl = resolveApplicationIconUrl(app.iconUrl);
  const appIcon = resolveApplicationIcon(app.icon, app.name);

  return (
    <div
      className={cn(
        "relative size-12 rounded-xl bg-muted/40 border border-border/30",
        "flex items-center justify-center overflow-hidden shrink-0",
        className,
      )}
    >
      {realIconUrl ? (
        <>
          <Image
            src={realIconUrl}
            alt={`${app.name} icon`}
            className="object-cover" fill
            onError={(e) => {
              const img = e.target as HTMLImageElement;
              img.style.display = "none";
              img.nextElementSibling?.classList.remove("hidden");
            }}
          />
          <HugeiconsIcon
            icon={appIcon}
            size={26}
            className={cn("hidden text-foreground", iconClassName)}
          />
        </>
      ) : (
        <HugeiconsIcon icon={appIcon} size={26} className={cn("text-foreground", iconClassName)} />
      )}
    </div>
  );
}

interface LauncherWidgetProps {
  onLaunch?: (app: LaunchableApp) => void;
}

export function LauncherWidget({ onLaunch }: LauncherWidgetProps = {}) {
  const { stacks, isLoading } = useServiceStacks();
  const quickLook = useQuickLook();

  const apps = useMemo(() => extractLaunchableApps(stacks), [stacks]);

  if (isLoading) {
    return (
      <Widget>
        <div className="flex-1 p-4">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex flex-col items-center gap-1.5">
                <Skeleton className="size-12 rounded-xl" />
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        </div>
      </Widget>
    );
  }

  if (apps.length === 0) {
    return (
      <Widget>
        <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4">
          <HugeiconsIcon icon={PackageOpenIcon} size={20} className="text-dim-foreground" />
          <p className="text-xs text-muted-foreground">No apps with web interface</p>
        </div>
      </Widget>
    );
  }

  return (
    <Widget>
      <div className="flex-1 p-4 overflow-y-auto">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-3">
          {apps.map((app) => (
            <button
              key={app.id}
              type="button"
              aria-label={app.name}
              className={cn(
                "flex flex-col items-center gap-1.5 py-1 rounded-lg",
                "transition-all duration-150 ease-out",
                "hover:bg-muted/30 active:scale-95",
              )}
              onClick={() => onLaunch ? onLaunch(app) : quickLook.open(app.container)}
            >
              <LaunchableAppIcon app={app} />
              <span className="text-xs text-muted-foreground leading-tight text-center truncate w-full px-0.5">
                {app.name}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Widget>
  );
}
