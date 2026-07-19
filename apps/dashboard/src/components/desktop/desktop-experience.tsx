"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { animate } from "motion";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Package01Icon,
  PinIcon,
  PinOffIcon,
  DashboardSquareEditIcon,
  Image01Icon,
  SlidersHorizontalIcon,
  Tick01Icon,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DesktopWindow } from "@/components/desktop/desktop-window";
import { DesktopLaunchpad } from "@/components/desktop/desktop-launchpad";
import { DesktopDriveIcons } from "@/components/desktop/desktop-drive-icons";
import { DesktopControlCenter } from "@/components/desktop/desktop-control-center";
import {
  DesktopWallpaperDialog,
  DesktopWidgetsPanel,
} from "@/components/desktop/desktop-customization";
import {
  extractLaunchableApps,
  type LaunchableApp,
} from "@/components/widgets/launcher-widget";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { ControlledWidgetGrid } from "@/components/widgets/widget-grid";
import { allNav, type NavItem } from "@/components/layout/nav-config";
import {
  DESKTOP_MODE_MEDIA_QUERY,
  useDesktopModeAvailable,
} from "@/hooks/use-desktop-mode";
import { useUser } from "@/hooks/use-user";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import { useDesktopWidgetLayout } from "@/hooks/use-desktop-widget-layout";
import { useWidgetLayout } from "@/hooks/use-widget-layout";
import { CORE_URL } from "@/lib/constants";
import {
  clampDesktopBounds,
  desktopMinimizeOffset,
  desktopWindowMotionKeyframes,
  DESKTOP_DOCK_STORAGE_KEY,
  DESKTOP_DOCK_STORAGE_VERSION,
  DESKTOP_WINDOW_STORAGE_KEY,
  DESKTOP_WINDOW_STORAGE_VERSION,
  isPersistedDesktopDock,
  isPersistedDesktopLayout,
  maximizedDesktopBounds,
  orderDesktopDockIds,
  reorderDesktopDockIds,
  type DesktopDockPlacement,
  type PersistedDesktopServiceApp,
  type DesktopArea,
  type DesktopBounds,
  type DesktopWindowMotionDirection,
} from "@/lib/desktop-window-state";
import { cn } from "@/lib/utils";
import {
  parseDesktopAppFocusMessage,
  parseDesktopAppActionsMessage,
  type DesktopAppChromeDescriptor,
} from "@/atoms/desktop-app-actions";

interface DesktopAppDefinition {
  id: string;
  title: string;
  url: string;
  icon: IconSvgElement;
  iconText?: string;
  iconUrl?: string;
  serviceApp?: PersistedDesktopServiceApp;
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

type DesktopControlCenterView = "main" | "dashboard";

const DESKTOP_WALLPAPER_STORAGE_KEY = "talome-desktop-wallpaper-v1";
const DESKTOP_DRIVES_STORAGE_KEY = "talome-desktop-show-drives-v1";
const DESKTOP_WINDOW_MOTION_SECONDS = 0.19;
const DESKTOP_WINDOW_MOTION_EASE = [0.22, 1, 0.36, 1] as const;
const DESKTOP_DOCK_MOTION_SECONDS = 0.16;
const DESKTOP_DOCK_MOTION_EASE = [0.22, 1, 0.36, 1] as const;

async function playDesktopWindowMotion(
  windowElement: HTMLElement,
  offset: { x: number; y: number },
  direction: DesktopWindowMotionDirection,
) {
  const keyframes = desktopWindowMotionKeyframes(offset, direction);
  const previousPointerEvents = windowElement.style.pointerEvents;
  windowElement.style.pointerEvents = "none";
  windowElement.style.transformOrigin = "center";
  windowElement.style.willChange = "transform, opacity";
  windowElement.style.transform = keyframes.transform[0];
  windowElement.style.opacity = String(keyframes.opacity[0]);

  const playback = animate(
    windowElement,
    {
      transform: keyframes.transform,
      opacity: keyframes.opacity,
    },
    {
      duration: DESKTOP_WINDOW_MOTION_SECONDS,
      ease: DESKTOP_WINDOW_MOTION_EASE,
      times: keyframes.times,
    },
  );

  try {
    await playback;
  } catch {
    // A window can be closed while its transition is in flight.
  } finally {
    const clearAnimationStyles = () => {
      windowElement.style.removeProperty("transform");
      windowElement.style.removeProperty("transform-origin");
      windowElement.style.removeProperty("will-change");
      windowElement.style.removeProperty("opacity");
    };
    playback.cancel();
    windowElement.style.pointerEvents = previousPointerEvents;
    clearAnimationStyles();
    window.requestAnimationFrame(clearAnimationStyles);
  }
}

function removeWindowChrome(
  current: Record<string, DesktopAppChromeDescriptor>,
  windowId: string,
) {
  if (!(windowId in current)) return current;
  return Object.fromEntries(
    Object.entries(current).filter(([candidateId]) => candidateId !== windowId),
  );
}

const DESKTOP_APPS: DesktopAppDefinition[] = [
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

const pinnableTalomeAppById = new Map(
  allNav
    .filter((item) => !item.action && item.url !== "/dashboard")
    .map(appDefinitionFromNav)
    .map((app) => [app.id, app]),
);

function serviceAppDefinition({
  id,
  name,
  url,
  icon,
  iconUrl,
}: PersistedDesktopServiceApp): DesktopAppDefinition {
  return {
    id: `${SERVICE_APP_PREFIX}${id}`,
    title: name,
    url,
    icon: Package01Icon,
    iconText: icon,
    iconUrl,
    serviceApp: { id, name, url, icon, iconUrl },
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
      if (candidate.appId === "home" || candidate.url === "/dashboard") return [];
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

function readPersistedDock(): {
  serviceApps: PersistedDesktopServiceApp[];
  appIds: string[];
  order: string[];
} {
  try {
    const raw = localStorage.getItem(DESKTOP_DOCK_STORAGE_KEY);
    if (!raw) return { serviceApps: [], appIds: [], order: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!isPersistedDesktopDock(parsed)) return { serviceApps: [], appIds: [], order: [] };
    return {
      serviceApps: Array.from(
        new Map(parsed.apps.map((app) => [app.id, app])).values(),
      ),
      appIds: Array.from(new Set(parsed.appIds ?? [])).filter((appId) => appId !== "home"),
      order: Array.from(new Set(parsed.order ?? [])).filter(
        (appId) => appId !== "home" && appId !== "settings",
      ),
    };
  } catch {
    return { serviceApps: [], appIds: [], order: [] };
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
  const { stacks } = useServiceStacks();
  const dashboardWidgetLayoutController = useWidgetLayout();
  const desktopWidgetLayoutController = useDesktopWidgetLayout();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const appFrameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const desktopWindowRefs = useRef(new Map<string, HTMLElement>());
  const dockButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const draggingDockAppIdRef = useRef<string | undefined>(undefined);
  const minimizingWindowIdsRef = useRef(new Set<string>());
  const restoringWindowIdsRef = useRef(new Set<string>());
  const zIndexRef = useRef(4);
  const [area, setArea] = useState<DesktopArea>(DEFAULT_AREA);
  const [windows, setWindows] = useState<DesktopWindowModel[]>(() => [
    createWindow(appById.get("files")!, DEFAULT_AREA, 2),
    createWindow(appById.get("media")!, DEFAULT_AREA, 1),
  ]);
  const [activeWindowId, setActiveWindowId] = useState("files");
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [controlCenterOpen, setControlCenterOpen] = useState(false);
  const [controlCenterView, setControlCenterView] = useState<DesktopControlCenterView>("main");
  const [dashboardEditing, setDashboardEditing] = useState(false);
  const [desktopWidgetsEditing, setDesktopWidgetsEditing] = useState(false);
  const [wallpaperDialogOpen, setWallpaperDialogOpen] = useState(false);
  const [wallpaperUrl, setWallpaperUrl] = useState<string>();
  const [showDesktopDrives, setShowDesktopDrives] = useState(true);
  const [restored, setRestored] = useState(false);
  const [dockRestored, setDockRestored] = useState(false);
  const [pinnedServiceApps, setPinnedServiceApps] = useState<
    PersistedDesktopServiceApp[]
  >([]);
  const [pinnedAppIds, setPinnedAppIds] = useState<string[]>([]);
  const [dockOrder, setDockOrder] = useState<string[]>([]);
  const [draggingDockAppId, setDraggingDockAppId] = useState<string>();
  const [appChromeByWindow, setAppChromeByWindow] = useState<
    Record<string, DesktopAppChromeDescriptor>
  >({});

  const canUseApp = useCallback((app: DesktopAppDefinition) => {
    if (app.adminOnly && user?.role !== "admin") return false;
    return !app.permission || hasPermission(app.permission);
  }, [hasPermission, user?.role]);

  const dockApps = useMemo(
    () => DESKTOP_APPS.filter(canUseApp),
    [canUseApp],
  );

  const launchableServiceApps = useMemo(
    () => extractLaunchableApps(stacks),
    [stacks],
  );
  const launchableServiceAppById = useMemo(
    () => new Map(launchableServiceApps.map((app) => [app.id, app])),
    [launchableServiceApps],
  );
  const pinnedServiceIds = useMemo(
    () => new Set(pinnedServiceApps.map((app) => app.id)),
    [pinnedServiceApps],
  );
  const pinnedAppIdSet = useMemo(() => new Set(pinnedAppIds), [pinnedAppIds]);

  const visibleDockApps = useMemo(() => {
    const fixedWithoutSettings = dockApps.filter((app) => app.id !== "settings");
    const fixedIds = new Set(dockApps.map((app) => app.id));
    const pinnedTalomeApps = pinnedAppIds.flatMap((appId): DesktopAppDefinition[] => {
      const app = pinnableTalomeAppById.get(appId);
      if (!app) return [];
      return canUseApp(app) && !fixedIds.has(app.id) ? [app] : [];
    });
    const pinnedServiceDefinitions = pinnedServiceApps.map((app) => {
      const current = launchableServiceAppById.get(app.id);
      return serviceAppDefinition(current ?? app);
    });
    const pinnedDefinitionIds = new Set([
      ...pinnedTalomeApps.map((app) => app.id),
      ...pinnedServiceDefinitions.map((app) => app.id),
    ]);
    const runningApps = windows.flatMap((windowModel): DesktopAppDefinition[] => {
      if (fixedIds.has(windowModel.appId) || pinnedDefinitionIds.has(windowModel.appId)) return [];
      const serviceId = windowModel.appId.startsWith(SERVICE_APP_PREFIX)
        ? windowModel.appId.slice(SERVICE_APP_PREFIX.length)
        : undefined;
      const currentService = serviceId
        ? launchableServiceAppById.get(serviceId)
        : undefined;
      const app = currentService
        ? serviceAppDefinition(currentService)
        : resolveAppDefinition(
          windowModel.appId,
          windowModel.url,
          windowModel.title,
        );
      return app && canUseApp(app) ? [app] : [];
    });
    const settings = dockApps.filter((app) => app.id === "settings");
    const naturalApps = [
      ...fixedWithoutSettings,
      ...pinnedTalomeApps,
      ...pinnedServiceDefinitions,
      ...runningApps,
    ];
    const naturalById = new Map(naturalApps.map((app) => [app.id, app]));
    const orderedIds = orderDesktopDockIds(
      naturalApps.map((app) => app.id),
      dockOrder,
    );
    return [
      ...orderedIds.flatMap((appId) => {
        const app = naturalById.get(appId);
        return app ? [app] : [];
      }),
      ...settings,
    ];
  }, [
    canUseApp,
    dockOrder,
    dockApps,
    launchableServiceAppById,
    pinnedAppIds,
    pinnedServiceApps,
    windows,
  ]);

  const reorderableDockAppIds = useMemo(
    () => visibleDockApps
      .filter((app) => app.id !== "settings")
      .map((app) => app.id),
    [visibleDockApps],
  );

  const windowByAppId = useMemo(
    () => new Map(windows.map((windowModel) => [windowModel.appId, windowModel])),
    [windows],
  );

  useEffect(() => {
    if (
      !desktopModeAvailable &&
      !window.matchMedia(DESKTOP_MODE_MEDIA_QUERY).matches
    ) {
      router.replace("/dashboard");
    }
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
    if (!desktopModeAvailable) return;
    const persistedDock = readPersistedDock();
    setPinnedServiceApps(persistedDock.serviceApps);
    setPinnedAppIds(persistedDock.appIds);
    setDockOrder(persistedDock.order);
    setDockRestored(true);
  }, [desktopModeAvailable]);

  useEffect(() => {
    try {
      setWallpaperUrl(localStorage.getItem(DESKTOP_WALLPAPER_STORAGE_KEY) ?? undefined);
      setShowDesktopDrives(localStorage.getItem(DESKTOP_DRIVES_STORAGE_KEY) !== "false");
    } catch {
      setWallpaperUrl(undefined);
      setShowDesktopDrives(true);
    }
  }, []);

  useEffect(() => {
    if (!desktopWidgetsEditing) return;

    const finishEditing = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDesktopWidgetsEditing(false);
    };
    window.addEventListener("keydown", finishEditing, true);
    return () => window.removeEventListener("keydown", finishEditing, true);
  }, [desktopWidgetsEditing]);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(
      DESKTOP_WINDOW_STORAGE_KEY,
      JSON.stringify({ version: DESKTOP_WINDOW_STORAGE_VERSION, windows }),
    );
  }, [restored, windows]);

  useEffect(() => {
    if (!dockRestored) return;
    localStorage.setItem(
      DESKTOP_DOCK_STORAGE_KEY,
      JSON.stringify({
        version: DESKTOP_DOCK_STORAGE_VERSION,
        apps: pinnedServiceApps,
        appIds: pinnedAppIds,
        order: dockOrder,
      }),
    );
  }, [dockOrder, dockRestored, pinnedAppIds, pinnedServiceApps]);

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

  const restoreWindow = useCallback(async (
    id: string,
    appId: string,
    app: DesktopAppDefinition,
  ) => {
    if (restoringWindowIdsRef.current.has(id)) return;
    restoringWindowIdsRef.current.add(id);

    const zIndex = zIndexRef.current++;
    flushSync(() => {
      setActiveWindowId(id);
      setWindows((current) => current.map((windowModel) =>
        windowModel.id === id
          ? {
            ...windowModel,
            title: app.title,
            url: app.url,
            minimized: false,
            zIndex,
          }
          : windowModel,
      ));
    });

    const windowElement = desktopWindowRefs.current.get(id);
    const dockButton = dockButtonRefs.current.get(appId);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    try {
      if (!windowElement || !dockButton || reduceMotion) return;
      const offset = desktopMinimizeOffset(
        windowElement.getBoundingClientRect(),
        dockButton.getBoundingClientRect(),
      );
      await playDesktopWindowMotion(windowElement, offset, "restore");
    } finally {
      restoringWindowIdsRef.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const actionsMessage = parseDesktopAppActionsMessage(event.data);
      const focusMessage = parseDesktopAppFocusMessage(event.data);
      if (!actionsMessage && !focusMessage) return;

      const frameEntry = Array.from(appFrameRefs.current.entries()).find(
        ([, frame]) => frame.contentWindow === event.source,
      );
      if (!frameEntry) return;

      const [windowId] = frameEntry;
      if (focusMessage) {
        if (activeWindowId !== windowId) focusWindow(windowId);
        return;
      }

      if (!actionsMessage) return;
      setAppChromeByWindow((current) => {
        if (actionsMessage.actions.length === 0 && !actionsMessage.title) {
          return removeWindowChrome(current, windowId);
        }
        return {
          ...current,
          [windowId]: {
            title: actionsMessage.title,
            actions: actionsMessage.actions,
          },
        };
      });
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [activeWindowId, focusWindow]);

  const openApp = useCallback((app: DesktopAppDefinition) => {
    if (!canUseApp(app)) return;
    const existing = windows.find((windowModel) => windowModel.appId === app.id);
    if (existing) {
      if (existing.minimized) {
        void restoreWindow(existing.id, existing.appId, app);
        return;
      }
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
  }, [area, canUseApp, focusWindow, restoreWindow, windows]);

  const launchNavItem = useCallback((item: NavItem) => {
    setLaunchpadOpen(false);
    if (item.url === "/dashboard") return;
    openApp(appDefinitionFromNav(item));
  }, [openApp]);

  const launchService = useCallback((app: LaunchableApp) => {
    setLaunchpadOpen(false);
    openApp(serviceAppDefinition(app));
  }, [openApp]);

  const toggleDockPin = useCallback((app: DesktopAppDefinition) => {
    const serviceApp = app.serviceApp;
    if (serviceApp) {
      setPinnedServiceApps((current) => {
        const pinned = current.some((candidate) => candidate.id === serviceApp.id);
        if (pinned) {
          return current.filter((candidate) => candidate.id !== serviceApp.id);
        }
        return [...current, serviceApp];
      });
      return;
    }
    if (appById.has(app.id)) return;
    setPinnedAppIds((current) => (
      current.includes(app.id)
        ? current.filter((appId) => appId !== app.id)
        : [...current, app.id]
    ));
  }, []);

  const reorderDockApp = useCallback((
    sourceId: string,
    targetId: string,
    placement: DesktopDockPlacement,
  ) => {
    setDockOrder(reorderDesktopDockIds(
      reorderableDockAppIds,
      sourceId,
      targetId,
      placement,
    ));
  }, [reorderableDockAppIds]);

  const moveDockApp = useCallback((appId: string, direction: "left" | "right") => {
    const appIndex = reorderableDockAppIds.indexOf(appId);
    const targetIndex = appIndex + (direction === "left" ? -1 : 1);
    const targetId = reorderableDockAppIds[targetIndex];
    if (!targetId) return;
    reorderDockApp(
      appId,
      targetId,
      direction === "left" ? "before" : "after",
    );
  }, [reorderableDockAppIds, reorderDockApp]);

  const handleDockDragStart = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    appId: string,
  ) => {
    draggingDockAppIdRef.current = appId;
    setDraggingDockAppId(appId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", appId);
  }, []);

  const handleDockDragOver = useCallback((
    event: ReactDragEvent<HTMLDivElement>,
    targetId: string,
  ) => {
    const sourceId = draggingDockAppIdRef.current;
    if (!sourceId || sourceId === targetId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = event.clientX < bounds.left + bounds.width / 2
      ? "before"
      : "after";
    reorderDockApp(sourceId, targetId, placement);
  }, [reorderDockApp]);

  const finishDockDrag = useCallback(() => {
    draggingDockAppIdRef.current = undefined;
    setDraggingDockAppId(undefined);
  }, []);

  const closeWindow = useCallback((id: string) => {
    appFrameRefs.current.delete(id);
    setAppChromeByWindow((current) => {
      return removeWindowChrome(current, id);
    });
    setWindows((current) => {
      const remaining = current.filter((windowModel) => windowModel.id !== id);
      const nextActive = remaining
        .filter((windowModel) => !windowModel.minimized)
        .sort((a, b) => b.zIndex - a.zIndex)[0];
      setActiveWindowId(nextActive?.id ?? "");
      return remaining;
    });
  }, []);

  const finishMinimizingWindow = useCallback((id: string) => {
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

  const minimizeWindow = useCallback(async (id: string, appId: string) => {
    if (minimizingWindowIdsRef.current.has(id)) return;
    minimizingWindowIdsRef.current.add(id);

    const windowElement = desktopWindowRefs.current.get(id);
    const dockButton = dockButtonRefs.current.get(appId);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (!windowElement || !dockButton || reduceMotion) {
      finishMinimizingWindow(id);
      minimizingWindowIdsRef.current.delete(id);
      return;
    }

    const offset = desktopMinimizeOffset(
      windowElement.getBoundingClientRect(),
      dockButton.getBoundingClientRect(),
    );
    try {
      await playDesktopWindowMotion(windowElement, offset, "minimize");
    } finally {
      finishMinimizingWindow(id);
      minimizingWindowIdsRef.current.delete(id);
    }
  }, [finishMinimizingWindow]);

  const updateWindow = useCallback((
    id: string,
    update: (windowModel: DesktopWindowModel) => DesktopWindowModel,
  ) => {
    setWindows((current) => current.map((windowModel) =>
      windowModel.id === id ? update(windowModel) : windowModel,
    ));
  }, []);

  const activeWindow = windows.find((windowModel) => windowModel.id === activeWindowId);
  const activeTitle = appChromeByWindow[activeWindowId]?.title
    ?? activeWindow?.title
    ?? "Desktop";

  const openSearch = () => {
    setControlCenterOpen(false);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
    );
  };

  const openDesktopWidgetEditor = () => {
    setControlCenterOpen(false);
    setLaunchpadOpen(false);
    setDesktopWidgetsEditing(true);
  };

  const openWallpaperEditor = () => {
    setControlCenterOpen(false);
    setWallpaperDialogOpen(true);
  };

  const openControlCenterApp = useCallback((url: string) => {
    const pathname = url.split("?")[0];
    const fixedApp = DESKTOP_APPS.find((app) => app.url === pathname);
    const navItem = allNav.find((item) => item.url === pathname);
    const app = fixedApp ?? (navItem ? appDefinitionFromNav(navItem) : undefined);
    if (!app) return;
    setControlCenterOpen(false);
    openApp({ ...app, url });
  }, [openApp]);

  const updateWallpaper = useCallback((nextWallpaperUrl?: string) => {
    try {
      if (nextWallpaperUrl) {
        localStorage.setItem(DESKTOP_WALLPAPER_STORAGE_KEY, nextWallpaperUrl);
      } else {
        localStorage.removeItem(DESKTOP_WALLPAPER_STORAGE_KEY);
      }
      setWallpaperUrl(nextWallpaperUrl);
      return true;
    } catch {
      return false;
    }
  }, []);

  const updateShowDesktopDrives = useCallback((show: boolean) => {
    try {
      localStorage.setItem(DESKTOP_DRIVES_STORAGE_KEY, String(show));
    } catch {
      // Keep the current-session preference even when storage is unavailable.
    }
    setShowDesktopDrives(show);
  }, []);

  const openDesktopDrive = useCallback((path: string) => {
    const filesApp = appById.get("files");
    if (!filesApp) return;
    openApp({
      ...filesApp,
      url: `/dashboard/files?path=${encodeURIComponent(path)}`,
    });
  }, [openApp]);

  const logOut = async () => {
    await fetch(`${CORE_URL}/api/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
    router.push("/");
  };

  const triggerAppAction = useCallback((windowId: string, actionId: string) => {
    const frame = appFrameRefs.current.get(windowId);
    frame?.contentWindow?.postMessage(
      { type: "talome:desktop-app-action-trigger", actionId },
      window.location.origin,
    );
  }, []);

  const handleAppFrameLoad = useCallback((
    windowId: string,
    event: SyntheticEvent<HTMLIFrameElement>,
  ) => {
    setAppChromeByWindow((current) => {
      return removeWindowChrome(current, windowId);
    });
    try {
      const pathname = event.currentTarget.contentWindow?.location.pathname;
      if (pathname === "/login") {
        router.replace("/login?from=%2Fdashboard%2Fdesktop");
      }
    } catch {
      // Cross-origin service windows cannot expose their location, which is expected.
    }
  }, [router]);

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
            <DropdownMenuItem onSelect={() => openApp(appById.get("settings")!)}>
              <HugeiconsIcon icon={Settings01Icon} size={14} />
              Settings
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
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground"
                aria-label="Search Talome"
                aria-haspopup="dialog"
                onClick={openSearch}
              >
                <HugeiconsIcon icon={Search01Icon} size={15} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={8}>
              Search <span className="ml-2 text-dim-foreground">⌘K</span>
            </TooltipContent>
          </Tooltip>
          <Popover
            open={controlCenterOpen}
            onOpenChange={(open) => {
              if (open) setControlCenterView("main");
              setControlCenterOpen(open);
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground",
                  controlCenterOpen && "bg-muted/60 text-foreground",
                )}
                aria-label="Control Center"
                aria-haspopup="dialog"
              >
                <HugeiconsIcon icon={SlidersHorizontalIcon} size={15} />
              </button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              side="bottom"
              sideOffset={8}
              className={cn(
                "z-[1300] overflow-hidden rounded-2xl border-border/80 bg-background/95 p-0 shadow-xl backdrop-blur-md",
                controlCenterView !== "main"
                  ? "w-[min(26rem,calc(100vw-2rem))]"
                  : "w-[min(23rem,calc(100vw-2rem))]",
              )}
              aria-label="Control Center"
            >
              {controlCenterView === "dashboard" ? (
                <DesktopWidgetsPanel
                  controller={dashboardWidgetLayoutController}
                  title="Dashboard"
                  subtitle={`${dashboardWidgetLayoutController.layout.filter((widget) => widget.visible).length} widgets · same layout as classic mode`}
                  editing={dashboardEditing}
                  onEditingChange={setDashboardEditing}
                  onBack={() => setControlCenterView("main")}
                />
              ) : (
                <DesktopControlCenter
                  onOpenAudiobooks={() => openControlCenterApp("/dashboard/audiobooks")}
                  onOpenDownloads={() => openControlCenterApp("/dashboard/media?tab=downloads")}
                  onOpenDashboard={() => {
                    setDashboardEditing(false);
                    setControlCenterView("dashboard");
                  }}
                  onOpenWallpaper={openWallpaperEditor}
                />
              )}
            </PopoverContent>
          </Popover>
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
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className="absolute inset-0 z-0 overflow-hidden"
              aria-label="Desktop background"
            >
              {wallpaperUrl ? (
                <Image
                  src={wallpaperUrl}
                  alt=""
                  fill
                  unoptimized
                  sizes="100vw"
                  className="object-cover"
                />
              ) : null}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="z-[1300] w-56">
            <ContextMenuGroup>
              <ContextMenuCheckboxItem
                checked={showDesktopDrives}
                onCheckedChange={(checked) => updateShowDesktopDrives(checked === true)}
              >
                Show Drives on Desktop
              </ContextMenuCheckboxItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={openDesktopWidgetEditor}>
                <HugeiconsIcon icon={DashboardSquareEditIcon} size={16} />
                Edit Desktop Widgets…
              </ContextMenuItem>
              <ContextMenuItem onSelect={openWallpaperEditor}>
                <HugeiconsIcon icon={Image01Icon} size={16} />
                Change Wallpaper…
              </ContextMenuItem>
            </ContextMenuGroup>
          </ContextMenuContent>
        </ContextMenu>

        <AnimatePresence>
          {desktopWidgetsEditing ? (
            <motion.div
              key="desktop-widget-edit-backdrop"
              className="absolute inset-0 z-[1000] bg-background/45 backdrop-blur-[2px]"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
          ) : null}
        </AnimatePresence>

        <div
          data-desktop-widget-canvas
          data-drive-lane-reserved={showDesktopDrives ? "true" : "false"}
          aria-label="Desktop widgets"
          className={cn(
            "absolute top-6 left-6 opacity-90 transition-opacity duration-150",
            desktopWidgetsEditing
              ? "z-[1100] max-h-[calc(100%-7rem)] overflow-y-auto p-1 pr-3 opacity-100"
              : "z-[1]",
          )}
          style={{
            width: showDesktopDrives
              ? "min(44rem, calc(100% - 10.5rem))"
              : "min(44rem, calc(100% - 3rem))",
          }}
        >
          <ControlledWidgetGrid
            controller={desktopWidgetLayoutController}
            editMode={desktopWidgetsEditing}
            showAddDock={desktopWidgetsEditing}
            maxColumns={3}
            onEditDoneRequested={() => setDesktopWidgetsEditing(false)}
          />
        </div>

        <AnimatePresence>
          {desktopWidgetsEditing ? (
            <motion.div
              key="desktop-widget-edit-toolbar"
              role="toolbar"
              aria-label="Desktop widget editing"
              className="absolute bottom-20 left-1/2 z-[1200] flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-border bg-card/95 p-2 pl-3 shadow-xl backdrop-blur-md"
              initial={{ opacity: 0, y: 10, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 10, scale: 0.97 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
            >
              <HugeiconsIcon icon={DashboardSquareEditIcon} size={16} />
              <span className="whitespace-nowrap text-sm font-medium">Desktop Widgets</span>
              <span className="h-5 w-px bg-border" />
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                Drag to reorder · Esc to finish
              </span>
              <button
                type="button"
                data-desktop-widget-edit-done
                className="flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-85"
                onPointerDown={() => setDesktopWidgetsEditing(false)}
                onClick={() => setDesktopWidgetsEditing(false)}
              >
                <HugeiconsIcon icon={Tick01Icon} size={13} />
                Done
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {showDesktopDrives ? (
          <DesktopDriveIcons
            onOpen={openDesktopDrive}
            onHide={() => updateShowDesktopDrives(false)}
          />
        ) : null}

        {windows.map((windowModel) => {
          if (windowModel.minimized) return null;
          const appChrome = appChromeByWindow[windowModel.id];
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
              title={appChrome?.title ?? windowModel.title}
              bounds={windowModel.bounds}
              restoreBounds={windowModel.restoreBounds}
              area={area}
              minimum={app.minimum}
              active={windowModel.id === activeWindowId}
              maximized={windowModel.maximized}
              zIndex={windowModel.zIndex}
              actions={appChrome?.actions}
              windowRef={(element) => {
                if (element) desktopWindowRefs.current.set(windowModel.id, element);
                else desktopWindowRefs.current.delete(windowModel.id);
              }}
              onFocus={() => focusWindow(windowModel.id)}
              onClose={() => closeWindow(windowModel.id)}
              onMinimize={() => void minimizeWindow(windowModel.id, windowModel.appId)}
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
              onAction={(actionId) => triggerAppAction(windowModel.id, actionId)}
            >
              <iframe
                ref={(frame) => {
                  if (frame) appFrameRefs.current.set(windowModel.id, frame);
                  else appFrameRefs.current.delete(windowModel.id);
                }}
                src={windowModel.url}
                title={windowModel.title}
                className="size-full border-0 bg-background"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                onLoad={(event) => handleAppFrameLoad(windowModel.id, event)}
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
          className={cn(
            "absolute bottom-4 left-1/2 z-[1050] flex -translate-x-1/2 items-end gap-1 rounded-2xl border border-border bg-card/90 p-2 backdrop-blur-md transition-opacity duration-150",
            desktopWidgetsEditing && "pointer-events-none opacity-45",
          )}
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <span className="flex">
                <DockButton
                  label="Launchpad"
                  icon={LayoutGridIcon}
                  active={launchpadOpen}
                  running={false}
                  onClick={() => setLaunchpadOpen((current) => !current)}
                />
              </span>
            </ContextMenuTrigger>
            <ContextMenuContent className="z-[1200] w-48">
              <ContextMenuItem onSelect={() => setLaunchpadOpen((current) => !current)}>
                {launchpadOpen ? "Close Launchpad" : "Open Launchpad"}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
          {visibleDockApps.map((app) => {
            const windowModel = windowByAppId.get(app.id);
            const dockIndex = reorderableDockAppIds.indexOf(app.id);
            const canReorder = dockIndex >= 0;
            const dockButton = (
              <DockButton
                label={app.title}
                icon={app.icon}
                iconText={app.iconText}
                iconUrl={app.iconUrl}
                active={
                  !launchpadOpen
                  && windowModel?.id === activeWindowId
                  && !windowModel.minimized
                }
                running={!!windowModel}
                minimized={windowModel?.minimized}
                buttonRef={(button) => {
                  if (button) dockButtonRefs.current.set(app.id, button);
                  else dockButtonRefs.current.delete(app.id);
                }}
                onClick={() => openApp(app)}
              />
            );
            return (
              <div
                key={app.id}
                data-dock-app-id={app.id}
                draggable={canReorder}
                aria-grabbed={canReorder ? draggingDockAppId === app.id : undefined}
                className={cn(
                  "flex items-center gap-1",
                  canReorder && "cursor-grab active:cursor-grabbing",
                  draggingDockAppId === app.id && "opacity-60",
                )}
                onDragStart={canReorder
                  ? (event) => handleDockDragStart(event, app.id)
                  : undefined}
                onDragOver={canReorder
                  ? (event) => handleDockDragOver(event, app.id)
                  : undefined}
                onDrop={canReorder
                  ? (event) => {
                    event.preventDefault();
                    finishDockDrag();
                  }
                  : undefined}
                onDragEnd={canReorder ? finishDockDrag : undefined}
              >
                {app.id === "settings" && (
                  <span className="mx-1 h-9 w-px bg-border" />
                )}
                <DockAppContextMenu
                  title={app.title}
                  windowModel={windowModel}
                  pinned={app.serviceApp
                    ? pinnedServiceIds.has(app.serviceApp.id)
                    : pinnedAppIdSet.has(app.id)}
                  onOpen={() => openApp(app)}
                  onMinimize={windowModel
                    ? () => void minimizeWindow(windowModel.id, windowModel.appId)
                    : undefined}
                  onClose={windowModel
                    ? () => closeWindow(windowModel.id)
                    : undefined}
                  onTogglePin={app.serviceApp || !appById.has(app.id)
                    ? () => toggleDockPin(app)
                    : undefined}
                  showReorder={canReorder}
                  onMoveLeft={dockIndex > 0
                    ? () => moveDockApp(app.id, "left")
                    : undefined}
                  onMoveRight={dockIndex < reorderableDockAppIds.length - 1
                    ? () => moveDockApp(app.id, "right")
                    : undefined}
                >
                  {dockButton}
                </DockAppContextMenu>
              </div>
            );
          })}
        </nav>
      </div>

      <DesktopWallpaperDialog
        open={wallpaperDialogOpen}
        wallpaperUrl={wallpaperUrl}
        onOpenChange={setWallpaperDialogOpen}
        onWallpaperChange={updateWallpaper}
      />
    </div>
  );
}

interface DockAppContextMenuProps {
  title: string;
  windowModel?: DesktopWindowModel;
  pinned?: boolean;
  children: ReactNode;
  onOpen: () => void;
  onMinimize?: () => void;
  onClose?: () => void;
  onTogglePin?: () => void;
  showReorder?: boolean;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
}

function DockAppContextMenu({
  title,
  windowModel,
  pinned,
  children,
  onOpen,
  onMinimize,
  onClose,
  onTogglePin,
  showReorder,
  onMoveLeft,
  onMoveRight,
}: DockAppContextMenuProps) {
  const primaryLabel = windowModel
    ? windowModel.minimized
      ? `Restore ${title}`
      : `Show ${title}`
    : `Open ${title}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="flex">{children}</span>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[1200] w-48">
        <ContextMenuGroup>
          <ContextMenuItem onSelect={onOpen}>{primaryLabel}</ContextMenuItem>
          {windowModel && !windowModel.minimized && onMinimize ? (
            <ContextMenuItem onSelect={onMinimize}>Minimize {title}</ContextMenuItem>
          ) : null}
          {windowModel && onClose ? (
            <ContextMenuItem onSelect={onClose}>Close {title}</ContextMenuItem>
          ) : null}
        </ContextMenuGroup>
        {showReorder ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem disabled={!onMoveLeft} onSelect={onMoveLeft}>
                <HugeiconsIcon icon={ArrowLeft01Icon} size={16} />
                Move Left
              </ContextMenuItem>
              <ContextMenuItem disabled={!onMoveRight} onSelect={onMoveRight}>
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
                Move Right
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        ) : null}
        {onTogglePin ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuGroup>
              <ContextMenuItem onSelect={onTogglePin}>
                <HugeiconsIcon icon={pinned ? PinOffIcon : PinIcon} size={16} />
                {pinned ? "Remove from Dock" : "Keep in Dock"}
              </ContextMenuItem>
            </ContextMenuGroup>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

interface DockButtonProps {
  label: string;
  icon: IconSvgElement;
  iconText?: string;
  iconUrl?: string;
  active: boolean;
  running: boolean;
  minimized?: boolean;
  buttonRef?: (button: HTMLButtonElement | null) => void;
  onClick: () => void;
}

function DockButton({
  label,
  icon,
  iconText,
  iconUrl,
  active,
  running,
  minimized,
  buttonRef,
  onClick,
}: DockButtonProps) {
  const reduceMotion = useReducedMotion();
  const motionTransition = {
    duration: reduceMotion ? 0 : DESKTOP_DOCK_MOTION_SECONDS,
    ease: DESKTOP_DOCK_MOTION_EASE,
  };
  const button = (
    <motion.button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-pressed={active}
      initial={false}
      animate={reduceMotion ? undefined : { y: active ? -2 : 0 }}
      whileHover={reduceMotion ? undefined : { y: -7, scale: 1.12 }}
      whileTap={reduceMotion ? undefined : { scale: 0.94 }}
      transition={motionTransition}
      className={cn(
        "relative isolate flex size-12 origin-bottom transform-gpu items-center justify-center rounded-xl border border-transparent bg-transparent transition-[background-color,border-color,opacity] duration-150 ease-out will-change-transform hover:border-border hover:bg-muted/40",
        minimized && "opacity-70",
      )}
      onClick={onClick}
    >
      <AnimatePresence initial={false}>
        {active ? (
          <motion.span
            key="active"
            layoutId="desktop-dock-active"
            data-dock-active-indicator
            className="pointer-events-none absolute inset-0 z-0 rounded-xl border border-foreground/20 bg-muted/70"
            transition={motionTransition}
          />
        ) : null}
      </AnimatePresence>
      <span className="relative z-10 flex">
        <DockAppIcon
          label={label}
          icon={icon}
          iconText={iconText}
          iconUrl={iconUrl}
        />
      </span>
      <AnimatePresence initial={false}>
        {running ? (
          <motion.span
            key="running"
            data-dock-running-indicator
            initial={reduceMotion ? false : { opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, scale: 0.5 }}
            transition={motionTransition}
            className="absolute -bottom-1 z-10 size-1 rounded-full bg-foreground/80"
          />
        ) : null}
      </AnimatePresence>
    </motion.button>
  );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={8}>{label}</TooltipContent>
    </Tooltip>
  );
}

function DockAppIcon({
  label,
  icon,
  iconText,
  iconUrl,
}: Pick<DockButtonProps, "label" | "icon" | "iconText" | "iconUrl">) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const realIconUrl = iconUrl &&
    !iconUrl.startsWith("file://") &&
    failedUrl !== iconUrl
    ? iconUrl
    : undefined;

  if (realIconUrl) {
    return (
      <span className="relative size-9 overflow-hidden rounded-lg bg-muted/30">
        <Image
          src={realIconUrl}
          alt={`${label} icon`}
          fill
          sizes="36px"
          className="object-contain p-0.5"
          onError={() => setFailedUrl(realIconUrl)}
        />
      </span>
    );
  }

  if (iconText && iconText !== "📦") {
    return <span className="text-2xl leading-none">{iconText}</span>;
  }

  return <HugeiconsIcon icon={icon} size={24} strokeWidth={1.4} />;
}
