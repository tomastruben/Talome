"use client";

import Image from "next/image";
import { useMemo } from "react";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import { useQuickLook } from "@/components/quick-look/quick-look-context";
import { Widget } from "./widget";
import {
  HugeiconsIcon,
  Package01Icon,
  PackageOpenIcon,
} from "@/components/icons";
import { Skeleton } from "@/components/ui/skeleton";
import { getHostUrl } from "@/lib/constants";
import { cn } from "@/lib/utils";
import type { Container, ServiceStack } from "@talome/types";

export interface LaunchableApp {
  id: string;
  name: string;
  url: string;
  icon?: string;
  iconUrl?: string;
  container: Container;
}

const COMMON_WEB_CONTAINER_PORTS = new Set([
  80,
  443,
  3000,
  3001,
  4000,
  5000,
  8000,
  8001,
  8080,
  8081,
  8090,
  8096,
  8123,
  8181,
  8191,
  8345,
  8443,
  8787,
  8920,
  8989,
  9000,
  9117,
  9443,
  9696,
  13378,
  54323,
]);

const NON_WEB_CONTAINER_PORTS = new Set([
  53,
  1900,
  5353,
  5432,
  6379,
  6881,
  7359,
]);

/** Prefer the container's conventional web UI port over discovery or protocol ports. */
export function getContainerWebPort(container: Container) {
  const tcpPorts = container.ports.filter((port) => port.protocol === "tcp" && port.host > 0);
  return tcpPorts.find((port) => COMMON_WEB_CONTAINER_PORTS.has(port.container))?.host
    ?? tcpPorts.find((port) => !NON_WEB_CONTAINER_PORTS.has(port.container))?.host
    ?? tcpPorts[0]?.host;
}

/** Extract individual launchable apps (running containers with web ports) from stacks. */
export function extractLaunchableApps(stacks: ServiceStack[]): LaunchableApp[] {
  const apps: LaunchableApp[] = [];

  for (const stack of stacks) {
    for (const container of stack.containers) {
      if (container.status !== "running") continue;
      const webPort = getContainerWebPort(container);
      if (!webPort) continue;

      // Resolve icon: per-container icon from stack, then stack-level icon
      const containerIcon = stack.containerIcons?.[container.id];
      const iconUrl = containerIcon?.iconUrl ?? stack.iconUrl;
      const icon = containerIcon?.icon ?? stack.icon;
      const name = containerIcon?.name ?? (stack.containers.length === 1 ? stack.name : container.name);

      apps.push({
        // Container names survive image upgrades/recreation, unlike Docker IDs.
        id: container.name,
        name,
        url: getHostUrl(webPort),
        icon,
        iconUrl,
        container,
      });
    }
  }

  return apps;
}

function AppIcon({ app }: { app: LaunchableApp }) {
  const realIconUrl = app.iconUrl && !app.iconUrl.startsWith("file://") ? app.iconUrl : null;

  return (
    <div
      className={cn(
        "relative size-12 rounded-xl bg-muted/40 border border-border/30",
        "flex items-center justify-center overflow-hidden shrink-0",
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
          <span className="hidden text-xl">{app.icon || "📦"}</span>
        </>
      ) : app.icon && app.icon !== "📦" ? (
        <span className="text-xl">{app.icon}</span>
      ) : (
        <HugeiconsIcon icon={Package01Icon} size={20} className="text-dim-foreground" />
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
              <AppIcon app={app} />
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
