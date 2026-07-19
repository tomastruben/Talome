"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  HugeiconsIcon,
  LayoutGridIcon,
  Home01Icon,
  HardDriveIcon,
  Film01Icon,
  Message01Icon,
  ComputerTerminal01Icon,
  Settings01Icon,
  Search01Icon,
  UserIcon,
  Logout01Icon,
  ArrowRight01Icon,
  Package01Icon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import type { FeaturePermission } from "@talome/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DesktopWindow } from "@/components/desktop/desktop-window";
import { DesktopLaunchpad } from "@/components/desktop/desktop-launchpad";
import type { LaunchableApp } from "@/components/widgets/launcher-widget";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { CpuWidget } from "@/components/widgets/cpu-widget";
import { MemoryWidget } from "@/components/widgets/memory-widget";
import { DiskWidget } from "@/components/widgets/disk-widget";
import { allNav, type NavItem } from "@/components/layout/nav-config";
import { useDesktopModeAvailable } from "@/hooks/use-desktop-mode";
import { useUser } from "@/hooks/use-user";
import { CORE_URL } from "@/lib/constants";
import {
  clampDesktopBounds,
  DESKTOP_WINDOW_STORAGE_KEY,
  DESKTOP_WINDOW_STORAGE_VERSION,
  isPersistedDesktopLayout,
  maximizedDesktopBounds,
  type DesktopArea,
  type DesktopBounds,
} from "@/lib/desktop-window-state";
import { cn } from "@/lib/utils";

interface DesktopAppDefinition {
  id: string;
  title: string;
  url: string;
  icon: IconSvgElement;
  permission?: FeaturePermission;
  adminOnly?: boolean;
  minimum: Pick<DesktopBounds, "width" | "height">;
}

interface DesktopWindowModel {
  id: string;
  appId: string;
  title: string;
  url: string;
  bounds: DesktopBounds;
  restoreBounds?: DesktopBounds;
  minimized: boolean;
  maximized: boolean;
  zIndex: number;
}

const DESKTOP_APPS: DesktopAppDefinition[] = [
  {
    id: "home",
    title: "Home",
    url: "/dashboard",
    icon: Home01Icon,
    permission: "dashboard",
    minimum: { width: 480, height: 340 },
  },
  {
    id: "files",
    title: "Files",
    url: "/dashboard/files",
    icon: HardDriveIcon,
    permission: "files",
    minimum: { width: 420, height: 320 },
  },
  {
    id: "media",
    title: "Media",
    url: "/dashboard/media",
    icon: Film01Icon,
    permission: "media",
    minimum: { width: 420, height: 320 },
  },
  {
    id: "assistant",
    title: "Assistant",
    url: "/dashboard/assistant",
    icon: Message01Icon,
    permission: "chat",
    minimum: { width: 420, height: 360 },
  },
  {
    id: "terminal",
    title: "Terminal",
    url: "/dashboard/terminal",
    icon: ComputerTerminal01Icon,
    adminOnly: true,
    minimum: { width: 520, height: 340 },
  },
  {
    id: "settings",
    title: "Settings",
    url: "/dashboard/settings",
    icon: Settings01Icon,
    adminOnly: true,
    minimum: { width: 480, height: 360 },
  },
];

const appById = new Map(DESKTOP_APPS.map((app) => [app.id, app]));
const DEFAULT_AREA: DesktopArea = { width: 1440, height: 820 };
const SERVICE_APP_PREFIX = "service:";

function appIdFromUrl(url: string) {
  if (url === "/dashboard") return "home";
  return url.replace(/^\/dashboard\/?/, "").replaceAll("/", "-") || "home";
}

function appDefinitionFromNav(item: NavItem): DesktopAppDefinition {
  return (
    DESKTOP_APPS.find((app) => app.url === item.url) ?? {
      id: appIdFromUrl(item.url),
      title: item.title,
      url: item.url,
      icon: item.icon,
      permission: item.permission,
      adminOnly: item.adminOnly,
      minimum: { width: 440, height: 340 },
    }
  );
}

function serviceAppDefinition({
  id,
  name,
  url,
}: Pick<LaunchableApp, "id" | "name" | "url">): DesktopAppDefinition {
  return {
    id: `${SERVICE_APP_PREFIX}${id}`,
    title: name,
    url,
    icon: Package01Icon,
    minimum: { width: 520, height: 360 },
  };
}

function resolveAppDefinition(appId: string, url: string, title?: string) {
  const fixed = appById.get(appId);
  if (fixed) return fixed;
  const navItem = allNav.find((item) => item.url === url);
  if (navItem) return appDefinitionFromNav(navItem);

  if (appId.startsWith(SERVICE_APP_PREFIX) && title) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return undefined;
      return serviceAppDefinition({
        id: appId.slice(SERVICE_APP_PREFIX.length),
        name: title,
        url,
      });
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function defaultBounds(appId: string, area: DesktopArea): DesktopBounds {
  if (appId === "files") {
    return clampDesktopBounds(
      { x: 72, y: 144, width: 760, height: 560 },
      area,
      { width: 420, height: 320 },
    );
  }

  if (appId === "media") {
    return clampDesktopBounds(
      {
        x: Math.max(360, area.width - 620),
        y: 200,
        width: 560,
        height: 430,
      },
      area,
      { width: 420, height: 320 },
    );
  }

  const offset = (appId.length % 5) * 24;
  return clampDesktopBounds(
    { x: 160 + offset, y: 120 + offset, width: 720, height: 520 },
    area,
    { width: 440, height: 340 },
  );
}

function createWindow(
  app: DesktopAppDefinition,
  area: DesktopArea,
  zIndex: number,
): DesktopWindowModel {
  return {
    id: app.id,
    appId: app.id,
    title: app.title,
    url: app.url,
    bounds: defaultBounds(app.id, area),
    minimized: false,
    maximized: false,
    zIndex,
  };
}

function readPersistedWindows(area: DesktopArea): DesktopWindowModel[] | null {
  try {
    const raw = localStorage.getItem(DESKTOP_WINDOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedDesktopLayout(parsed)) return null;

    const windows = parsed.windows.flatMap((value): DesktopWindowModel[] => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Partial<DesktopWindowModel>;
      const app = candidate.appId && candidate.url
        ? resolveAppDefinition(candidate.appId, candidate.url, candidate.title)
        : undefined;
      if (!app || !candidate.bounds) return [];
      const bounds = candidate.bounds as Partial<DesktopBounds>;
      if (
        typeof bounds.x !== "number" ||
        typeof bounds.y !== "number" ||
        typeof bounds.width !== "number" ||
        typeof bounds.height !== "number"
      ) {
        return [];
      }

      return [{
        id: app.id,
        appId: app.id,
        title: app.title,
        url: app.url,
        bounds: candidate.maximized
          ? maximizedDesktopBounds(area)
          : clampDesktopBounds(bounds as DesktopBounds, area, app.minimum),
        restoreBounds: candidate.restoreBounds,
        minimized: candidate.minimized === true,
        maximized: candidate.maximized === true,
        zIndex: typeof candidate.zIndex === "number" ? candidate.zIndex : 1,
      }];
    });

    return windows;
  } catch {
    return null;
  }
}

function TalomeMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="12" cy="4.5" r="1.7" />
      <circle cx="17.1" cy="7" r="1.27" opacity="0.56" />
      <circle cx="12" cy="9.5" r="0.72" opacity="0.12" />
      <circle cx="6.5" cy="12" r="1.27" opacity="0.56" />
      <circle cx="12" cy="14.5" r="1.7" />
      <circle cx="17.5" cy="17" r="1.27" opacity="0.56" />
      <circle cx="12" cy="19.5" r="0.72" opacity="0.12" />
      <circle cx="12" cy="4.5" r="0.72" opacity="0.12" />
      <circle cx="6.5" cy="7" r="1.27" opacity="0.56" />
      <circle cx="12" cy="9.5" r="1.7" />
      <circle cx="17.5" cy="12" r="1.27" opacity="0.56" />
      <circle cx="12" cy="14.5" r="0.72" opacity="0.12" />
      <circle cx="6.5" cy="17" r="1.27" opacity="0.56" />
      <circle cx="12" cy="19.5" r="1.7" />
    </svg>
  );
}

function DesktopClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <time className="text-xs tabular-nums text-muted-foreground" suppressHydrationWarning>
      {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
    </time>
  );
}

export function DesktopExperience() {
  const router = useRouter();
  const desktopModeAvailable = useDesktopModeAvailable();
  const { user, hasPermission } = useUser();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const zIndexRef = useRef(4);
  const [area, setArea] = useState<DesktopArea>(DEFAULT_AREA);
  const [windows, setWindows] = useState<DesktopWindowModel[]>(() => [
    createWindow(appById.get("files")!, DEFAULT_AREA, 2),
    createWindow(appById.get("media")!, DEFAULT_AREA, 1),
  ]);
  const [activeWindowId, setActiveWindowId] = useState("files");
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [restored, setRestored] = useState(false);

  const canUseApp = useCallback((app: DesktopAppDefinition) => {
    if (app.adminOnly && user?.role !== "admin") return false;
    return !app.permission || hasPermission(app.permission);
  }, [hasPermission, user?.role]);

  const dockApps = useMemo(
    () => DESKTOP_APPS.filter(canUseApp),
    [canUseApp],
  );

  const visibleDockApps = useMemo(() => {
    const fixedWithoutSettings = dockApps.filter((app) => app.id !== "settings");
    const fixedIds = new Set(dockApps.map((app) => app.id));
    const runningApps = windows.flatMap((windowModel): DesktopAppDefinition[] => {
      if (fixedIds.has(windowModel.appId)) return [];
      const app = resolveAppDefinition(
        windowModel.appId,
        windowModel.url,
        windowModel.title,
      );
      return app && canUseApp(app) ? [app] : [];
    });
    const settings = dockApps.filter((app) => app.id === "settings");
    return [...fixedWithoutSettings, ...runningApps, ...settings];
  }, [canUseApp, dockApps, windows]);

  useEffect(() => {
    if (!desktopModeAvailable) router.replace("/dashboard");
  }, [desktopModeAvailable, router]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    const updateArea = () => {
      const rect = workspace.getBoundingClientRect();
      setArea({ width: rect.width, height: rect.height });
    };
    updateArea();
    const observer = new ResizeObserver(updateArea);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [desktopModeAvailable]);

  useEffect(() => {
    if (!desktopModeAvailable) return;
    const saved = readPersistedWindows(area);
    if (saved) {
      const accessible = saved.filter((windowModel) => {
        const app = resolveAppDefinition(
          windowModel.appId,
          windowModel.url,
          windowModel.title,
        );
        return app ? canUseApp(app) : false;
      });
      setWindows(accessible);
      const top = accessible
        .filter((windowModel) => !windowModel.minimized)
        .sort((a, b) => b.zIndex - a.zIndex)[0];
      setActiveWindowId(top?.id ?? "");
      zIndexRef.current = Math.max(4, ...accessible.map((windowModel) => windowModel.zIndex + 1));
    } else {
      setWindows([
        createWindow(appById.get("files")!, area, 2),
        createWindow(appById.get("media")!, area, 1),
      ].filter((windowModel) => canUseApp(appById.get(windowModel.appId)!)));
    }
    setRestored(true);
  // Restore once after the real workspace dimensions are available.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopModeAvailable]);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(
      DESKTOP_WINDOW_STORAGE_KEY,
      JSON.stringify({ version: DESKTOP_WINDOW_STORAGE_VERSION, windows }),
    );
  }, [restored, windows]);

  useEffect(() => {
    setWindows((current) => current.map((windowModel) => {
      const app = resolveAppDefinition(
        windowModel.appId,
        windowModel.url,
        windowModel.title,
      );
      if (!app) return windowModel;
      return {
        ...windowModel,
        bounds: windowModel.maximized
          ? maximizedDesktopBounds(area)
          : clampDesktopBounds(windowModel.bounds, area, app.minimum),
      };
    }));
  }, [area]);

  const focusWindow = useCallback((id: string) => {
    const zIndex = zIndexRef.current++;
    setActiveWindowId(id);
    setWindows((current) => current.map((windowModel) =>
      windowModel.id === id
        ? { ...windowModel, minimized: false, zIndex }
        : windowModel,
    ));
  }, []);

  const openApp = useCallback((app: DesktopAppDefinition) => {
    if (!canUseApp(app)) return;
    const existing = windows.find((windowModel) => windowModel.appId === app.id);
    if (existing) {
      focusWindow(existing.id);
      setWindows((current) => current.map((windowModel) =>
        windowModel.id === existing.id
          ? { ...windowModel, title: app.title, url: app.url }
          : windowModel,
      ));
      return;
    }
    const zIndex = zIndexRef.current++;
    const next = createWindow(app, area, zIndex);
    setWindows((current) => [...current, next]);
    setActiveWindowId(next.id);
  }, [area, canUseApp, focusWindow, windows]);

  const launchNavItem = useCallback((item: NavItem) => {
    setLaunchpadOpen(false);
    openApp(appDefinitionFromNav(item));
  }, [openApp]);

  const launchService = useCallback((app: LaunchableApp) => {
    setLaunchpadOpen(false);
    openApp(serviceAppDefinition(app));
  }, [openApp]);

  const closeWindow = useCallback((id: string) => {
    setWindows((current) => {
      const remaining = current.filter((windowModel) => windowModel.id !== id);
      const nextActive = remaining
        .filter((windowModel) => !windowModel.minimized)
        .sort((a, b) => b.zIndex - a.zIndex)[0];
      setActiveWindowId(nextActive?.id ?? "");
      return remaining;
    });
  }, []);

  const minimizeWindow = useCallback((id: string) => {
    setWindows((current) => {
      const next = current.map((windowModel) =>
        windowModel.id === id ? { ...windowModel, minimized: true } : windowModel,
      );
      const nextActive = next
        .filter((windowModel) => !windowModel.minimized && windowModel.id !== id)
        .sort((a, b) => b.zIndex - a.zIndex)[0];
      setActiveWindowId(nextActive?.id ?? "");
      return next;
    });
  }, []);

  const updateWindow = useCallback((
    id: string,
    update: (windowModel: DesktopWindowModel) => DesktopWindowModel,
  ) => {
    setWindows((current) => current.map((windowModel) =>
      windowModel.id === id ? update(windowModel) : windowModel,
    ));
  }, []);

  const activeWindow = windows.find((windowModel) => windowModel.id === activeWindowId);
  const activeTitle = activeWindow?.title ?? "Desktop";

  const openSearch = () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  };

  const logOut = async () => {
    await fetch(`${CORE_URL}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    router.push("/");
  };

  if (!desktopModeAvailable) return null;

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <header className="relative z-[1100] flex h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-background/90 px-3 backdrop-blur-md">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 items-center gap-2 rounded-md px-2 text-sm font-medium transition-colors duration-150 hover:bg-muted/40"
              aria-label="Talome menu"
            >
              <TalomeMark />
              <span>Talome</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuLabel>Talome</DropdownMenuLabel>
            <DropdownMenuItem asChild>
              <Link href="/dashboard">
                Classic mode
                <HugeiconsIcon icon={ArrowRight01Icon} size={14} className="ml-auto" />
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void logOut()}>
              <HugeiconsIcon icon={Logout01Icon} size={14} />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className="h-8 rounded-md px-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground">
            File
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onSelect={() => openApp(appById.get("files")!)}>
              Open Files
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLaunchpadOpen(true)}>
              Open Launchpad
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!activeWindow}
              onSelect={() => activeWindow && closeWindow(activeWindow.id)}
            >
              Close Window
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className="h-8 rounded-md px-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground">
            View
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onSelect={openSearch}>
              <HugeiconsIcon icon={Search01Icon} size={14} />
              Search
              <span className="ml-auto text-xs text-dim-foreground">⌘K</span>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/dashboard">Classic mode</Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger className="h-8 rounded-md px-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground">
            Window
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            {windows.length === 0 ? (
              <DropdownMenuItem disabled>No open windows</DropdownMenuItem>
            ) : windows.map((windowModel) => (
              <DropdownMenuItem
                key={windowModel.id}
                onSelect={() => focusWindow(windowModel.id)}
              >
                {windowModel.title}
                {windowModel.id === activeWindowId && (
                  <span className="ml-auto size-1.5 rounded-full bg-foreground" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="mx-2 h-4 w-px bg-border" />
        <span className="truncate text-sm font-medium">{activeTitle}</span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="hidden h-7 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground xl:flex"
            onClick={openSearch}
          >
            <HugeiconsIcon icon={Search01Icon} size={14} />
            <span>Search</span>
            <kbd className="rounded border border-border px-1 text-dim-foreground">⌘K</kbd>
          </button>
          <NotificationsBell triggerClassName="size-7" iconSize={15} />
          <DesktopClock />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="ml-1 flex size-7 items-center justify-center rounded-full border border-border bg-card text-muted-foreground transition-colors duration-150 hover:text-foreground"
                aria-label="Account menu"
              >
                <HugeiconsIcon icon={UserIcon} size={14} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel>{user?.username ?? "Account"}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => openApp(appById.get("settings")!)}>
                <HugeiconsIcon icon={Settings01Icon} size={14} />
                Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void logOut()}>
                <HugeiconsIcon icon={Logout01Icon} size={14} />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div ref={workspaceRef} className="relative flex-1 min-h-0 overflow-hidden bg-background">
        <div className="pointer-events-none absolute top-6 left-6 z-0 grid w-[min(44rem,calc(100%-3rem))] grid-cols-3 gap-3 opacity-75">
          <CpuWidget />
          <MemoryWidget />
          <DiskWidget />
        </div>

        {windows.map((windowModel) => {
          if (windowModel.minimized) return null;
          const app = resolveAppDefinition(
            windowModel.appId,
            windowModel.url,
            windowModel.title,
          ) ?? appDefinitionFromNav({
            title: windowModel.title,
            url: windowModel.url,
            icon: Home01Icon,
          });
          return (
            <DesktopWindow
              key={windowModel.id}
              id={windowModel.id}
              title={windowModel.title}
              bounds={windowModel.bounds}
              restoreBounds={windowModel.restoreBounds}
              area={area}
              minimum={app.minimum}
              active={windowModel.id === activeWindowId}
              maximized={windowModel.maximized}
              zIndex={windowModel.zIndex}
              onFocus={() => focusWindow(windowModel.id)}
              onClose={() => closeWindow(windowModel.id)}
              onMinimize={() => minimizeWindow(windowModel.id)}
              onBoundsChange={(bounds) => updateWindow(windowModel.id, (current) => ({
                ...current,
                bounds,
              }))}
              onMaximizeChange={(maximized, restoreBounds) => updateWindow(windowModel.id, (current) => ({
                ...current,
                maximized,
                restoreBounds: maximized ? restoreBounds : undefined,
                bounds: !maximized && restoreBounds
                  ? clampDesktopBounds(restoreBounds, area, app.minimum)
                  : current.bounds,
              }))}
            >
              <iframe
                src={windowModel.url}
                title={windowModel.title}
                className="size-full border-0 bg-background"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
              />
            </DesktopWindow>
          );
        })}

        <DesktopLaunchpad
          open={launchpadOpen}
          onOpenChange={setLaunchpadOpen}
          onLaunch={launchNavItem}
          onLaunchService={launchService}
        />

        <nav
          aria-label="Desktop applications"
          className="absolute bottom-4 left-1/2 z-[1050] flex -translate-x-1/2 items-end gap-1 rounded-2xl border border-border bg-card/90 p-2 backdrop-blur-md"
        >
          <DockButton
            label="Launchpad"
            icon={LayoutGridIcon}
            active={launchpadOpen}
            running={false}
            onClick={() => setLaunchpadOpen((current) => !current)}
          />
          {visibleDockApps.map((app) => {
            const windowModel = windows.find((candidate) => candidate.appId === app.id);
            return (
              <div key={app.id} className="flex items-center gap-1">
                {app.id === "settings" && (
                  <span className="mx-1 h-9 w-px bg-border" />
                )}
                <DockButton
                  label={app.title}
                  icon={app.icon}
                  active={windowModel?.id === activeWindowId && !windowModel.minimized}
                  running={!!windowModel}
                  minimized={windowModel?.minimized}
                  onClick={() => openApp(app)}
                />
              </div>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

interface DockButtonProps {
  label: string;
  icon: IconSvgElement;
  active: boolean;
  running: boolean;
  minimized?: boolean;
  onClick: () => void;
}

function DockButton({
  label,
  icon,
  active,
  running,
  minimized,
  onClick,
}: DockButtonProps) {
  const button = (
    <button
      type="button"
      aria-label={label}
      className={cn(
        "relative flex size-12 items-center justify-center rounded-xl border transition-[background-color,border-color,transform] duration-150 ease-out",
        active
          ? "border-foreground/20 bg-muted/70"
          : "border-transparent bg-transparent hover:-translate-y-1 hover:border-border hover:bg-muted/40",
        minimized && "opacity-70",
      )}
      onClick={onClick}
    >
      <HugeiconsIcon icon={icon} size={24} strokeWidth={1.4} />
      {running && (
        <span className="absolute -bottom-1 size-1 rounded-full bg-foreground/80" />
      )}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  );
}
