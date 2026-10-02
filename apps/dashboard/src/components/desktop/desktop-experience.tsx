"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { flushSync } from "react-dom";
import { animate } from "motion";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  HugeiconsIcon,
  StartUp02Icon,
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
  PinIcon,
  PinOffIcon,
  HeadphonesIcon,
  PauseIcon,
  PlayIcon,
  DashboardSquareEditIcon,
  Image01Icon,
  SlidersHorizontalIcon,
  Share04Icon,
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DOCK_ICON_SIZE, DOCK_MAGNIFY_SPRING, dockMagnification } from "@/lib/dock-magnification";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IconSwap } from "@/components/ui/micro";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DesktopWindow, desktopWindowChrome } from "@/components/desktop/desktop-window";
import { DesktopLaunchpad } from "@/components/desktop/desktop-launchpad";
import { DesktopDriveIcons } from "@/components/desktop/desktop-drive-icons";
import {
  DesktopAudiobooksControlCenter,
  DesktopControlCenter,
  DesktopDownloadsControlCenter,
  type DesktopAudiobookPlayerController,
} from "@/components/desktop/desktop-control-center";
import {
  DesktopWallpaperDialog,
  DesktopWidgetsPanel,
  normalizeDesktopWallpaperUrl,
  reportWallpaperAccountSaveFailure,
  type DesktopWallpaperAttribution,
  type WallpaperAccountSave,
} from "@/components/desktop/desktop-customization";
import {
  extractLaunchableApps,
  type LaunchableApp,
} from "@/components/widgets/launcher-widget";
import { NotificationsBell } from "@/components/notifications/notifications-bell";
import { toast } from "sonner";
import { DesktopApprovalsButton } from "@/components/desktop/desktop-approvals-button";
import { DesktopServiceUnavailable } from "@/components/desktop/desktop-service-unavailable";
import { useIsOnline } from "@/hooks/use-is-online";
import { diagnosePrompt, healthBannerCopy } from "@/components/system-health-banner";
import {
  desktopDockItemName,
  desktopServiceStartPath,
  desktopServiceStateLabel,
  desktopServiceStatusLookup,
  isServiceUnavailable,
  withActiveOperation,
  type DesktopServiceStatus,
} from "@/lib/desktop-service-state";
import { useActiveAppOperations } from "@/hooks/use-active-app-operations";
import { useServiceWindowGates } from "@/hooks/use-service-window-gates";
import { DESKTOP_LAYER } from "@/lib/desktop-layers";
import {
  CSS_EASE_EXIT,
  DRAG_SETTLE_SPRING,
  DURATION,
  DURATION_MS,
  EASE_ENTER,
  EASE_EXIT,
  TRAVEL,
  enter as enterTransition,
  exit as exitTransition,
} from "@/lib/motion";
import { openPalette } from "@/lib/palette";
import { logOut as endSession, roleLabel } from "@/lib/session";
import { reportModeSave } from "@/lib/dashboard-mode-save";
import { talomePost } from "@/hooks/use-talome-api";
import { SHORTCUTS } from "@/lib/keymap";
import { ControlledWidgetGrid } from "@/components/widgets/widget-grid";
import { allNav, type NavItem } from "@/components/layout/nav-config";
import {
  isDesktopModeAvailableNow,
  persistDashboardModePreference,
  writeDashboardModePreference,
  useDesktopModeAvailable,
} from "@/hooks/use-desktop-mode";
import { useUser } from "@/hooks/use-user";
import { useServiceStacks } from "@/hooks/use-service-stacks";
import { useDesktopWidgetLayout } from "@/hooks/use-desktop-widget-layout";
import { useWidgetLayout } from "@/hooks/use-widget-layout";
import {
  bringDesktopWindowToFront,
  clampDesktopBounds,
  desktopCloseAction,
  desktopWindowZIndex,
  frontmostDesktopWindow,
  normalizeDesktopWindowStack,
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
  resolveApplicationIcon,
  resolveApplicationIconUrl,
} from "@/components/native-app/native-app-icons";
import {
  DESKTOP_APP_ACTIONS_REQUEST_MESSAGE,
  parseDesktopAppFocusMessage,
  parseDesktopAppActionsMessage,
  parseDesktopPlayerOpenMessage,
  type DesktopAppChromeDescriptor,
} from "@/atoms/desktop-app-actions";
import {
  parseDesktopAudiobookStateMessage,
  type DesktopAudiobookCommand,
} from "@/atoms/desktop-audiobook-player";
import {
  DESKTOP_OPEN_ROUTE_EVENT,
  dashboardRouteFromHref,
  desktopRouteFromEvent,
  desktopRouteFromMessage,
  desktopRouteStateFromMessage,
  shouldHandleDesktopLink,
  nativeDashboardAppKey,
  findDesktopNativeService,
  desktopRouteBelongsToWindow,
} from "@/lib/desktop-navigation";
import {
  INITIAL_AUDIO_PLAYER_STATE,
  type AudioPlayerBook,
  type AudioPlayerState,
} from "@/atoms/audio-player";
import { DESKTOP_WALLPAPER_STORAGE_KEY, readStoredWallpaper } from "@/lib/wallpaper";

interface DesktopAppDefinition {
  id: string;
  title: string;
  url: string;
  icon: IconSvgElement;
  iconUrl?: string;
  serviceApp?: PersistedDesktopServiceApp;
  permission?: FeaturePermission;
  adminOnly?: boolean;
  minimum: Pick<DesktopBounds, "width" | "height">;
}

interface DesktopWindowModel {
  /** Last rendered route; kept separate so recording navigation never reloads the iframe. */
  currentUrl?: string;
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

interface DesktopAudiobookPlayback {
  windowId: string;
  book: AudioPlayerBook | null;
  state: AudioPlayerState;
  error: string | null;
}

type DesktopControlCenterView = "main" | "dashboard" | "audiobooks" | "downloads";
type DesktopControlCenterNavigationDirection = "push" | "pop";

const DESKTOP_WALLPAPER_ATTRIBUTION_STORAGE_KEY = "talome-desktop-wallpaper-attribution-v1";
const DESKTOP_DRIVES_STORAGE_KEY = "talome-desktop-show-drives-v1";
/** Status tray buttons beside the Dock's apps (Search, Control Center, notifications, Talome menu). */
const DOCK_TRAY_BUTTON_CLASS =
  "relative flex size-10 items-center justify-center rounded-xl text-muted-foreground outline-none transition-[background-color,color,transform] duration-150 ease-out hover:bg-muted/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-safe:active:scale-95";
/** Pointer x over the Dock (Infinity when elsewhere) — drives magnification */
const DockPointerContext = createContext<MotionValue<number> | null>(null);
/** Window minimize (an exit) and restore (an entrance), spec §7.4. */
const DESKTOP_WINDOW_MOTION = {
  minimize: { duration: DURATION.base, ease: EASE_EXIT },
  restore: { duration: DURATION.sheet, ease: EASE_ENTER },
} as const;
/** Dock hover, active indicator and running dot: 150ms on the enter curve. */
const DESKTOP_DOCK_TRANSITION = { duration: DURATION.fast, ease: EASE_ENTER } as const;
const DESKTOP_DOCK_POINTER_CONSTRAINT = { distance: 6 } as const;
/** Progress fills track real data: linear, at most 250ms per update (a token, not a class literal). */
const DESKTOP_PROGRESS_TRANSITION = `width ${DURATION_MS.progress}ms linear`;
/** Under reduced motion a Control Center page change is a 120ms crossfade (spec §3.4). */
const CONTROL_CENTER_PAGE_VARIANTS_REDUCED = {
  enter: { opacity: 0 },
  center: { opacity: 1, transition: { duration: DURATION.exitFast, ease: EASE_ENTER } },
  exit: { opacity: 0, transition: { duration: DURATION.exitFast, ease: EASE_EXIT } },
};
/** Control Center subpages: 24px push in 180ms, 12px back in 140ms (no full-width slide). */
const CONTROL_CENTER_PAGE_VARIANTS = {
  enter: (direction: DesktopControlCenterNavigationDirection) => ({
    x: direction === "push" ? TRAVEL.push : TRAVEL.pushExit,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
    transition: enterTransition(DURATION.base),
  },
  exit: (direction: DesktopControlCenterNavigationDirection) => ({
    x: direction === "push" ? TRAVEL.pushExit : TRAVEL.push,
    opacity: 0,
    transition: exitTransition(DURATION.exit),
  }),
};

async function playDesktopWindowMotion(
  windowElement: HTMLElement,
  offset: { x: number; y: number },
  direction: DesktopWindowMotionDirection,
  beforeStyleCleanup?: () => void,
) {
  const keyframes = desktopWindowMotionKeyframes(offset, direction);
  const previousPointerEvents = windowElement.style.pointerEvents;
  const previousVisibility = direction === "restore"
    ? ""
    : windowElement.style.visibility;

  // Minimized windows stay mounted so their iframe/application state survives.
  // Release the visibility guard from the previous minimize before restoring.
  if (direction === "restore") {
    windowElement.style.removeProperty("visibility");
  }

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
      ...DESKTOP_WINDOW_MOTION[direction],
      times: keyframes.times,
    },
  );

  try {
    await playback;
  } catch {
    // A window can be closed while its transition is in flight.
  } finally {
    // Commit the persistent window's hidden state before releasing Motion's
    // compositor styles. This prevents WebKit from presenting the untransformed
    // iframe for one frame at the end of the animation.
    if (direction === "minimize") {
      windowElement.style.visibility = "hidden";
    }
    beforeStyleCleanup?.();

    if (direction === "minimize") {
      await Promise.race([
        new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => resolve());
          });
        }),
        // requestAnimationFrame pauses in a background tab, so keep the
        // minimize transaction from remaining locked indefinitely.
        new Promise<void>((resolve) => window.setTimeout(resolve, 80)),
      ]);
    }

    const clearAnimationStyles = () => {
      windowElement.style.removeProperty("transform");
      windowElement.style.removeProperty("transform-origin");
      windowElement.style.removeProperty("will-change");
      windowElement.style.removeProperty("opacity");
    };
    playback.cancel();
    windowElement.style.pointerEvents = previousPointerEvents;
    clearAnimationStyles();
    if (direction === "restore") {
      if (previousVisibility) {
        windowElement.style.visibility = previousVisibility;
      } else {
        windowElement.style.removeProperty("visibility");
      }
      window.requestAnimationFrame(clearAnimationStyles);
    }
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
    id: "share",
    title: "Share",
    url: "/dashboard/share",
    icon: Share04Icon,
    permission: "apps",
    minimum: { width: 480, height: 360 },
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
const PLAYER_APP_ID = "player";

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

function routeMatchesApp(pathname: string, appUrl: string) {
  if (pathname === appUrl) return true;
  return appUrl !== "/dashboard" && pathname.startsWith(`${appUrl}/`);
}

function routeTitle(pathname: string) {
  const segment = pathname.split("/").filter(Boolean)[1] ?? "App";
  return segment
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function appDefinitionFromDashboardRoute(
  url: string,
  services: readonly PersistedDesktopServiceApp[] = [],
): DesktopAppDefinition | undefined {
  const normalized = dashboardRouteFromHref(url);
  if (!normalized) return undefined;

  const parsed = new URL(normalized, "http://talome.local");
  if (parsed.pathname === "/dashboard") return undefined;

  if (parsed.pathname === "/dashboard/native-apps" || parsed.pathname.startsWith("/dashboard/native-apps/")) {
    const key = nativeDashboardAppKey(normalized);
    if (!key) return undefined;
    const service = findDesktopNativeService(normalized, services);
    const app = serviceAppDefinition(service ?? {
      id: `native:${key}`,
      name: decodeURIComponent(key.split("/")[1]).replaceAll("-", " "),
      url: normalized,
    });
    return { ...app, url: normalized };
  }

  const fixedApp = DESKTOP_APPS
    .filter((app) => routeMatchesApp(parsed.pathname, app.url))
    .sort((a, b) => b.url.length - a.url.length)[0];
  if (fixedApp) return { ...fixedApp, url: normalized };

  const navItem = allNav
    .filter((item) => !item.action && routeMatchesApp(parsed.pathname, item.url))
    .sort((a, b) => b.url.length - a.url.length)[0];
  if (navItem) return { ...appDefinitionFromNav(navItem), url: normalized };

  const rootUrl = `/${parsed.pathname.split("/").filter(Boolean).slice(0, 2).join("/")}`;
  return {
    id: appIdFromUrl(rootUrl),
    title: routeTitle(parsed.pathname),
    url: normalized,
    icon: Home01Icon,
    minimum: { width: 440, height: 340 },
  };
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
  const persistedUrl = nativeDashboardAppKey(url)
    ? new URL(url, typeof window === "undefined" ? "http://localhost:3000" : window.location.href).href
    : url;
  return {
    id: `${SERVICE_APP_PREFIX}${id}`,
    title: name,
    url,
    icon: resolveApplicationIcon(icon, name),
    iconUrl,
    serviceApp: { id, name, url: persistedUrl, icon, iconUrl },
    minimum: { width: 520, height: 360 },
  };
}

function playerArtworkFromUrl(url: string) {
  try {
    return new URL(url, "http://talome.local").searchParams.get("artwork") ?? undefined;
  } catch {
    return undefined;
  }
}

function playerAppDefinition(
  title: string,
  url: string,
  iconUrl = playerArtworkFromUrl(url),
): DesktopAppDefinition {
  return {
    id: PLAYER_APP_ID,
    title,
    url,
    icon: Film01Icon,
    iconUrl,
    permission: "media",
    minimum: { width: 480, height: 320 },
  };
}

function resolveAppDefinition(appId: string, url: string, title?: string) {
  if (
    appId === PLAYER_APP_ID &&
    title &&
    (url === "/dashboard/player" || url.startsWith("/dashboard/player?"))
  ) {
    return playerAppDefinition(title, url);
  }

  // Native service windows keep their container identity even when their
  // recorded route is relative or includes an app screen/query.
  if (appId.startsWith(SERVICE_APP_PREFIX) && title && nativeDashboardAppKey(url)) {
    return serviceAppDefinition({
      id: appId.slice(SERVICE_APP_PREFIX.length),
      name: title,
      url,
    });
  }

  const dashboardApp = appDefinitionFromDashboardRoute(url);
  if (dashboardApp?.id === appId) return dashboardApp;
  // Migrate windows saved by the old generic native-apps route fallback.
  if (appId === "native-apps" && nativeDashboardAppKey(url)) return dashboardApp;

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

  if (appId === PLAYER_APP_ID) {
    const width = Math.min(880, Math.max(480, area.width - 160));
    const height = Math.min(560, Math.max(320, area.height - 140));
    return clampDesktopBounds(
      {
        x: Math.max(24, (area.width - width) / 2),
        y: Math.max(24, (area.height - height) / 2),
        width,
        height,
      },
      area,
      { width: 480, height: 320 },
    );
  }

  const offset = (appId.length % 5) * 24;
  return clampDesktopBounds(
    // Terminal opens wide enough to show its sidebar beside the session
    { x: 160 + offset, y: 120 + offset, width: appId === "terminal" ? 860 : 720, height: 520 },
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
        zIndex: typeof candidate.zIndex === "number" && Number.isFinite(candidate.zIndex) ? candidate.zIndex : 1,
      }];
    });

    // Layouts saved by the old ever-growing counter come back as ranks 1..n.
    return normalizeDesktopWindowStack(windows);
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

interface DesktopSurfaceContextMenuContentProps {
  canEditWidgets: boolean;
  editingWidgets: boolean;
  showDesktopDrives: boolean;
  onShowDesktopDrivesChange: (show: boolean) => void;
  onEditWidgets: () => void;
  onFinishEditingWidgets: () => void;
  onOpenWallpaper: () => void;
}

function DesktopSurfaceContextMenuContent({
  canEditWidgets,
  editingWidgets,
  showDesktopDrives,
  onShowDesktopDrivesChange,
  onEditWidgets,
  onFinishEditingWidgets,
  onOpenWallpaper,
}: DesktopSurfaceContextMenuContentProps) {
  return (
    <ContextMenuContent className="z-[1300] w-56">
      <ContextMenuGroup>
        <ContextMenuCheckboxItem
          checked={showDesktopDrives}
          onCheckedChange={(checked) => onShowDesktopDrivesChange(checked === true)}
        >
          Show drives on desktop
        </ContextMenuCheckboxItem>
      </ContextMenuGroup>
      <ContextMenuSeparator />
      <ContextMenuGroup>
        {canEditWidgets ? (
          <ContextMenuItem
            onSelect={editingWidgets ? onFinishEditingWidgets : onEditWidgets}
          >
            <HugeiconsIcon
              icon={editingWidgets ? Tick01Icon : DashboardSquareEditIcon}
              size={16}
            />
            {editingWidgets ? "Finish editing widgets" : "Edit desktop widgets…"}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem onSelect={onOpenWallpaper}>
          <HugeiconsIcon icon={Image01Icon} size={16} />
          Change wallpaper…
        </ContextMenuItem>
      </ContextMenuGroup>
    </ContextMenuContent>
  );
}

export function DesktopExperience() {
  const router = useRouter();
  const desktopModeAvailable = useDesktopModeAvailable();
  const { user, hasPermission, mutate: mutateUser } = useUser();
  const canUseApp = useCallback((app: DesktopAppDefinition) => {
    if (app.adminOnly && user?.role !== "admin") return false;
    return !app.permission || hasPermission(app.permission);
  }, [hasPermission, user?.role]);
  const { stacks, isLoading: stacksLoading, error: stacksError, refresh: refreshStacks } = useServiceStacks();
  const serviceStatus = useMemo(
    () => desktopServiceStatusLookup(stacks, !stacksLoading && !stacksError),
    [stacks, stacksError, stacksLoading],
  );
  const health = useIsOnline();
  const dashboardWidgetLayoutController = useWidgetLayout();
  const desktopWidgetLayoutController = useDesktopWidgetLayout();
  const workspaceRef = useRef<HTMLDivElement>(null);
  /** The part of the workspace above the Dock: window placement, Fill, snapping
   * and the title-bar limit use it, while windows themselves may slide under
   * the Dock, which floats over them. */
  const workAreaRef = useRef<HTMLDivElement>(null);
  const appFrameRefs = useRef(new Map<string, HTMLIFrameElement>());
  const desktopWindowRefs = useRef(new Map<string, HTMLElement>());
  const dockButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const desktopWidgetDoneButtonRef = useRef<HTMLButtonElement>(null);
  const wallpaperAccountRestoredRef = useRef<string | undefined>(undefined);
  const minimizingWindowIdsRef = useRef(new Set<string>());
  const dockPointerX = useMotionValue(Number.POSITIVE_INFINITY);
  /** Windows opened in this session (not restored from a previous one) animate in */
  const openingWindowIdsRef = useRef(new Set<string>());
  const restoringWindowIdsRef = useRef(new Set<string>());
  const [area, setArea] = useState<DesktopArea>(DEFAULT_AREA);
  // A calm first run (D-P1-9): the desktop opens empty, with the widgets in view,
  // instead of two windows covering them.
  const [windows, setWindows] = useState<DesktopWindowModel[]>([]);
  const [activeWindowId, setActiveWindowId] = useState("");
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [controlCenterOpen, setControlCenterOpen] = useState(false);
  const [controlCenterView, setControlCenterView] = useState<DesktopControlCenterView>("main");
  const [controlCenterNavigationDirection, setControlCenterNavigationDirection] = useState<
    DesktopControlCenterNavigationDirection
  >("push");
  const [dashboardEditing, setDashboardEditing] = useState(false);
  const [desktopWidgetsEditing, setDesktopWidgetsEditing] = useState(false);
  const [wallpaperDialogOpen, setWallpaperDialogOpen] = useState(false);
  /** Read when an account save fails after the dialog closed: then the failure goes in a toast. */
  const wallpaperDialogOpenRef = useRef(false);
  useEffect(() => {
    wallpaperDialogOpenRef.current = wallpaperDialogOpen;
  }, [wallpaperDialogOpen]);
  const [wallpaperAccountSave, setWallpaperAccountSave] = useState<WallpaperAccountSave>({ status: "idle" });
  const launchpadButtonRef = useRef<HTMLButtonElement | null>(null);
  // Read on the first render, not in an effect: after the sign-in unlock the
  // desktop's first frame already shows this device's wallpaper (the image
  // the sign-in screen just showed), never a plain background
  const [wallpaperUrl, setWallpaperUrl] = useState<string | undefined>(
    () => normalizeDesktopWallpaperUrl(readStoredWallpaper()),
  );
  const [wallpaperAttribution, setWallpaperAttribution] = useState<
    DesktopWallpaperAttribution
  >();
  const [showDesktopDrives, setShowDesktopDrives] = useState(true);
  const [selectedDesktopDrivePath, setSelectedDesktopDrivePath] = useState<string>();
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
  const [desktopAudiobookPlayback, setDesktopAudiobookPlayback] = useState<
    DesktopAudiobookPlayback
  >();
  const reduceMotion = useReducedMotion();
  const dockSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: DESKTOP_DOCK_POINTER_CONSTRAINT,
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

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
  /** Launchpad tiles carry the Dock's window dot: open, or hollow when minimized. */
  const launchpadWindowState = useCallback((target: { item: NavItem } | { app: LaunchableApp }) => {
    const windowModel = "item" in target
      ? windowByAppId.get(appDefinitionFromNav(target.item).id)
      : windowByAppId.get(`${SERVICE_APP_PREFIX}${target.app.id}`);
    if (!windowModel) return undefined;
    return windowModel.minimized ? "minimized" as const : "open" as const;
  }, [windowByAppId]);
  // App operations are read only while a service in the dock isn't running,
  // so an update recreating its container reads "Updating", not "Not installed".
  const watchOperations = hasPermission("apps") && visibleDockApps.some((app) => {
    const serviceId = app.serviceApp?.id;
    if (!serviceId || serviceId.startsWith("native:")) return false;
    const state = serviceStatus(serviceId).state;
    return state !== "running" && state !== "unknown";
  });
  const activeOperations = useActiveAppOperations(watchOperations);
  /** Windows whose page has loaded at least once (kept through a restart). */
  const [loadedFrameIds, setLoadedFrameIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (
      !desktopModeAvailable &&
      !isDesktopModeAvailableNow()
    ) {
      router.replace("/dashboard");
    }
  }, [desktopModeAvailable, router]);

  useEffect(() => {
    const workspace = workAreaRef.current;
    if (!workspace) return;

    let measurementFrame = 0;
    const updateArea = () => {
      window.cancelAnimationFrame(measurementFrame);
      measurementFrame = window.requestAnimationFrame(() => {
        const rect = workspace.getBoundingClientRect();
        const width = workspace.clientWidth || rect.width;
        const height = workspace.clientHeight || rect.height;
        setArea((current) => (
          current.width === width && current.height === height
            ? current
            : { width, height }
        ));
      });
    };
    updateArea();
    const observer = new ResizeObserver(updateArea);
    observer.observe(workspace);
    window.addEventListener("resize", updateArea);
    window.visualViewport?.addEventListener("resize", updateArea);
    return () => {
      window.cancelAnimationFrame(measurementFrame);
      observer.disconnect();
      window.removeEventListener("resize", updateArea);
      window.visualViewport?.removeEventListener("resize", updateArea);
    };
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
      const stack = normalizeDesktopWindowStack(accessible);
      setWindows(stack);
      setActiveWindowId(frontmostDesktopWindow(stack)?.id ?? "");
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
      const storedWallpaperUrl = localStorage.getItem(DESKTOP_WALLPAPER_STORAGE_KEY);
      const nextWallpaperUrl = normalizeDesktopWallpaperUrl(storedWallpaperUrl);
      setWallpaperUrl(nextWallpaperUrl);
      if (storedWallpaperUrl && !nextWallpaperUrl) {
        localStorage.removeItem(DESKTOP_WALLPAPER_STORAGE_KEY);
        localStorage.removeItem(DESKTOP_WALLPAPER_ATTRIBUTION_STORAGE_KEY);
      }
      const storedAttribution = localStorage.getItem(
        DESKTOP_WALLPAPER_ATTRIBUTION_STORAGE_KEY,
      );
      if (storedAttribution) {
        const parsedAttribution = JSON.parse(storedAttribution) as Partial<
          DesktopWallpaperAttribution
        >;
        if (
          typeof parsedAttribution.photoUrl === "string"
          && typeof parsedAttribution.photographerName === "string"
          && typeof parsedAttribution.photographerUrl === "string"
        ) {
          setWallpaperAttribution(parsedAttribution as DesktopWallpaperAttribution);
        }
      }
      setShowDesktopDrives(localStorage.getItem(DESKTOP_DRIVES_STORAGE_KEY) !== "false");
    } catch {
      setWallpaperUrl(undefined);
      setWallpaperAttribution(undefined);
      setShowDesktopDrives(true);
    }
  }, []);

  useEffect(() => {
    if (!user?.authenticated || !user.userId) return;
    if (wallpaperAccountRestoredRef.current === user.userId) return;
    wallpaperAccountRestoredRef.current = user.userId;

    const accountWallpaper = user.preferences?.desktopWallpaper;
    if (accountWallpaper) {
      const nextWallpaperUrl = normalizeDesktopWallpaperUrl(accountWallpaper.wallpaperUrl);
      const retiredWallpaperWasSelected = Boolean(
        accountWallpaper.wallpaperUrl && !nextWallpaperUrl,
      );
      const nextAttribution = retiredWallpaperWasSelected
        ? undefined
        : accountWallpaper.attribution ?? undefined;
      setWallpaperUrl(nextWallpaperUrl);
      setWallpaperAttribution(nextAttribution);
      try {
        if (nextWallpaperUrl) {
          localStorage.setItem(DESKTOP_WALLPAPER_STORAGE_KEY, nextWallpaperUrl);
        } else {
          localStorage.removeItem(DESKTOP_WALLPAPER_STORAGE_KEY);
        }
        if (nextAttribution) {
          localStorage.setItem(
            DESKTOP_WALLPAPER_ATTRIBUTION_STORAGE_KEY,
            JSON.stringify(nextAttribution),
          );
        } else {
          localStorage.removeItem(DESKTOP_WALLPAPER_ATTRIBUTION_STORAGE_KEY);
        }
      } catch {
        // The account preference remains authoritative when browser storage is unavailable.
      }
      if (retiredWallpaperWasSelected) {
        void fetch("/api/auth/preferences/desktop", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wallpaperUrl: null, attribution: null }),
        }).then((response) => {
          if (response.ok) void mutateUser();
        }).catch(() => undefined);
      }
      return;
    }

    // One-time migration for people who selected a wallpaper before preferences
    // became account-scoped.
    try {
      const storedWallpaperUrl = normalizeDesktopWallpaperUrl(
        localStorage.getItem(DESKTOP_WALLPAPER_STORAGE_KEY),
      );
      const storedAttribution = localStorage.getItem(
        DESKTOP_WALLPAPER_ATTRIBUTION_STORAGE_KEY,
      );
      if (!storedWallpaperUrl && !storedAttribution) return;
      const parsedAttribution = storedAttribution
        ? JSON.parse(storedAttribution) as DesktopWallpaperAttribution
        : undefined;
      void fetch("/api/auth/preferences/desktop", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallpaperUrl: storedWallpaperUrl,
          attribution: parsedAttribution ?? null,
        }),
      }).then((response) => {
        if (response.ok) void mutateUser();
      }).catch(() => undefined);
    } catch {
      // Keep the existing browser-only preference if migration is unavailable.
    }
  }, [mutateUser, user?.authenticated, user?.preferences?.desktopWallpaper, user?.userId]);

  useEffect(() => {
    if (!desktopWidgetsEditing) return;

    const finishEditing = (event: KeyboardEvent) => {
      const opensGlobalPalette = (
        ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")
        || (event.key === "/" && !event.metaKey && !event.ctrlKey)
      );
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDesktopWidgetsEditing(false);
        return;
      }
      if (opensGlobalPalette) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("keydown", finishEditing, true);
    return () => window.removeEventListener("keydown", finishEditing, true);
  }, [desktopWidgetsEditing]);

  useEffect(() => {
    if (!desktopWidgetsEditing) return;
    const frame = window.requestAnimationFrame(() => {
      desktopWidgetDoneButtonRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [desktopWidgetsEditing]);

  useEffect(() => {
    if (!restored) return;
    localStorage.setItem(
      DESKTOP_WINDOW_STORAGE_KEY,
      JSON.stringify({
        version: DESKTOP_WINDOW_STORAGE_VERSION,
        windows: windows.map(({ currentUrl, ...windowModel }) => ({
          ...windowModel,
          url: currentUrl ?? windowModel.url,
        })),
      }),
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

  /** Moves keyboard focus into a window (its app frame) once it is on screen. */
  const focusWindowElement = useCallback((id: string) => {
    window.requestAnimationFrame(() => {
      const frame = appFrameRefs.current.get(id);
      const element = frame ?? desktopWindowRefs.current.get(id);
      element?.focus({ preventScroll: true });
    });
  }, []);

  // Ranks, not a global counter (D-P0-4): focusing the frontmost window is a
  // no-op, and no window can climb above the dock however often it is focused.
  const focusWindow = useCallback((id: string) => {
    setActiveWindowId(id);
    setWindows((current) => bringDesktopWindowToFront(
      current.some((windowModel) => windowModel.id === id && windowModel.minimized)
        ? current.map((windowModel) => windowModel.id === id ? { ...windowModel, minimized: false } : windowModel)
        : current,
      id,
    ));
  }, []);

  const restoreWindow = useCallback(async (
    id: string,
    appId: string,
    app?: DesktopAppDefinition,
  ) => {
    if (restoringWindowIdsRef.current.has(id)) return;
    restoringWindowIdsRef.current.add(id);

    flushSync(() => {
      setActiveWindowId(id);
      setWindows((current) => bringDesktopWindowToFront(current.map((windowModel) =>
        windowModel.id === id
          ? {
            ...windowModel,
            ...(app ? { title: app.title, url: app.url, currentUrl: app.url } : {}),
            minimized: false,
          }
          : windowModel,
      ), id));
    });

    const windowElement = desktopWindowRefs.current.get(id);
    const dockButton = dockButtonRefs.current.get(appId);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    try {
      if (!windowElement || !dockButton || reduceMotion) {
        focusWindowElement(id);
        return;
      }
      const offset = desktopMinimizeOffset(
        windowElement.getBoundingClientRect(),
        dockButton.getBoundingClientRect(),
      );
      await playDesktopWindowMotion(windowElement, offset, "restore");
      focusWindowElement(id);
    } finally {
      restoringWindowIdsRef.current.delete(id);
    }
  }, [focusWindowElement]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const actionsMessage = parseDesktopAppActionsMessage(event.data);
      const focusMessage = parseDesktopAppFocusMessage(event.data);
      const playerMessage = parseDesktopPlayerOpenMessage(event.data);
      const audiobookMessage = parseDesktopAudiobookStateMessage(event.data);
      if (!actionsMessage && !focusMessage && !playerMessage && !audiobookMessage) return;

      const frameEntry = Array.from(appFrameRefs.current.entries()).find(
        ([, frame]) => frame.contentWindow === event.source,
      );
      if (!frameEntry) return;

      const [windowId] = frameEntry;
      if (audiobookMessage) {
        setDesktopAudiobookPlayback({
          windowId,
          book: audiobookMessage.book,
          state: audiobookMessage.state,
          error: audiobookMessage.error,
        });
        return;
      }
      if (playerMessage) {
        const params = new URLSearchParams({
          path: playerMessage.filePath,
          name: playerMessage.fileName,
          original: String(playerMessage.preferOriginal),
          direct: String(playerMessage.preferDirect),
        });
        if (playerMessage.artworkUrl) params.set("artwork", playerMessage.artworkUrl);
        const app = playerAppDefinition(
          `${playerMessage.title} — Player`,
          `/dashboard/player?${params.toString()}`,
          playerMessage.artworkUrl,
        );
        setAppChromeByWindow((current) => removeWindowChrome(current, PLAYER_APP_ID));
        setWindows((current) => {
          const existing = current.find((windowModel) => windowModel.appId === PLAYER_APP_ID);
          if (existing) {
            return bringDesktopWindowToFront(current.map((windowModel) => windowModel.appId === PLAYER_APP_ID
              ? {
                ...windowModel,
                title: app.title,
                url: app.url,
                currentUrl: app.url,
                minimized: false,
              }
              : windowModel), existing.id);
          }
          return [...current, createWindow(app, area, current.length + 1)];
        });
        setActiveWindowId(PLAYER_APP_ID);
        return;
      }
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
  }, [activeWindowId, area, focusWindow]);

  const desktopAudiobookWindowId = desktopAudiobookPlayback?.windowId;
  const sendDesktopAudiobookCommand = useCallback((command: DesktopAudiobookCommand["type"]) => {
    if (!desktopAudiobookWindowId) return;
    appFrameRefs.current.get(desktopAudiobookWindowId)?.contentWindow?.postMessage(
      { type: "talome:desktop-audiobook-command", command },
      window.location.origin,
    );
  }, [desktopAudiobookWindowId]);
  const desktopAudiobookPlayer = useMemo<DesktopAudiobookPlayerController>(() => ({
    book: desktopAudiobookPlayback?.book ?? null,
    state: desktopAudiobookPlayback?.state ?? INITIAL_AUDIO_PLAYER_STATE,
    error: desktopAudiobookPlayback?.error ?? null,
    togglePlay: () => sendDesktopAudiobookCommand(
      desktopAudiobookPlayback?.state.isPlaying ? "pause" : "play",
    ),
    stop: () => sendDesktopAudiobookCommand("stop"),
  }), [desktopAudiobookPlayback, sendDesktopAudiobookCommand]);
  const desktopAudiobookProgress = desktopAudiobookPlayer.book
    && desktopAudiobookPlayer.book.totalDuration > 0
    ? Math.min(
      100,
      (desktopAudiobookPlayer.state.currentTime
        / desktopAudiobookPlayer.book.totalDuration) * 100,
    )
    : 0;

  const openApp = useCallback((app: DesktopAppDefinition, navigate = false) => {
    if (!canUseApp(app)) return;
    const nativeKey = nativeDashboardAppKey(app.url);
    const existing = windows.find((windowModel) => windowModel.appId === app.id
      || (nativeKey !== null && nativeDashboardAppKey(windowModel.url) === nativeKey));
    if (existing) {
      // A direct native link can open before stack metadata arrives. Adopt the
      // installed container identity when Launchpad subsequently activates it.
      if (existing.appId !== app.id && app.serviceApp && !app.serviceApp.id.startsWith("native:")) {
        setWindows((current) => current.map((candidate) => candidate.id === existing.id
          ? { ...candidate, appId: app.id, title: app.title }
          : candidate));
      }
      // Client-side navigation can leave the iframe's src prop at an older
      // route. An explicit link to that route must still navigate the frame.
      if (navigate && existing.url === app.url) {
        const frame = appFrameRefs.current.get(existing.id);
        try {
          if (frame?.contentWindow
            && frame.contentWindow.location.href !== new URL(app.url, window.location.href).href) {
            frame.src = app.url;
          }
        } catch {
          // External service frames own their navigation and cannot be inspected.
        }
      }
      if (existing.minimized) {
        void restoreWindow(existing.id, existing.appId, navigate ? app : undefined);
        return;
      }
      focusWindow(existing.id);
      focusWindowElement(existing.id);
      // Dock and Launchpad activate the existing app without resetting its route.
      if (!navigate) return;
      setWindows((current) => current.map((windowModel) =>
        windowModel.id === existing.id
          ? { ...windowModel, title: app.title, url: app.url, currentUrl: app.url }
          : windowModel,
      ));
      return;
    }
    const next = createWindow(app, area, windows.length + 1);
    openingWindowIdsRef.current.add(next.id);
    setWindows((current) => normalizeDesktopWindowStack([...current, { ...next, zIndex: Number.POSITIVE_INFINITY }]));
    setActiveWindowId(next.id);
    focusWindowElement(next.id);
  }, [area, canUseApp, focusWindow, focusWindowElement, restoreWindow, windows]);

  const openDashboardRoute = useCallback((url: string) => {
    const normalized = dashboardRouteFromHref(url);
    if (!normalized) return;
    const pathname = normalized.split(/[?#]/, 1)[0];
    if (pathname === "/dashboard") {
      if (!hasPermission("dashboard")) return;
      setLaunchpadOpen(false);
      setControlCenterNavigationDirection("push");
      setControlCenterView("dashboard");
      setControlCenterOpen(true);
      return;
    }

    const existingServices = windows.flatMap((windowModel) => {
      const service = resolveAppDefinition(windowModel.appId, windowModel.url, windowModel.title)?.serviceApp;
      return service ? [service] : [];
    });
    const app = appDefinitionFromDashboardRoute(normalized, [
      ...launchableServiceApps,
      ...pinnedServiceApps,
      ...existingServices,
    ]);
    if (app) openApp(app, true);
  }, [hasPermission, launchableServiceApps, openApp, pinnedServiceApps, windows]);

  useEffect(() => {
    const handleDesktopRouteRequest = (event: Event) => {
      const route = desktopRouteFromEvent(event);
      if (route) openDashboardRoute(route);
    };
    window.addEventListener(DESKTOP_OPEN_ROUTE_EVENT, handleDesktopRouteRequest);
    return () => window.removeEventListener(
      DESKTOP_OPEN_ROUTE_EVENT,
      handleDesktopRouteRequest,
    );
  }, [openDashboardRoute]);

  useEffect(() => {
    const handleDesktopRouteMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const route = desktopRouteFromMessage(event.data);
      const currentUrl = desktopRouteStateFromMessage(event.data);
      if (!route && !currentUrl) return;
      const frameEntry = Array.from(appFrameRefs.current.entries()).find(
        ([, frame]) => frame.contentWindow === event.source,
      );
      if (!frameEntry) return;
      if (currentUrl) {
        setWindows((current) => {
          const source = current.find((candidate) => candidate.id === frameEntry[0]);
          if (!source || !desktopRouteBelongsToWindow(currentUrl, source.url)
            || source.currentUrl === currentUrl) return current;
          return current.map((candidate) => candidate.id === source.id
            ? { ...candidate, currentUrl }
            : candidate);
        });
        return;
      }
      if (route) openDashboardRoute(route);
    };

    window.addEventListener("message", handleDesktopRouteMessage);
    return () => window.removeEventListener("message", handleDesktopRouteMessage);
  }, [openDashboardRoute]);

  useEffect(() => {
    const handleDesktopLink = (event: MouseEvent) => {
      const target = event.target;
      const anchor = target instanceof Element
        ? target.closest<HTMLAnchorElement>("a[href]")
        : null;
      if (!anchor || !shouldHandleDesktopLink(event, anchor)) return;

      const route = dashboardRouteFromHref(anchor.href);
      if (!route) return;
      event.preventDefault();
      openDashboardRoute(route);
    };

    document.addEventListener("click", handleDesktopLink, true);
    return () => document.removeEventListener("click", handleDesktopLink, true);
  }, [openDashboardRoute]);

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

  const handleDockDragStart = useCallback((event: DragStartEvent) => {
    setDraggingDockAppId(String(event.active.id));
  }, []);

  const finishDockDrag = useCallback(() => {
    setDraggingDockAppId(undefined);
  }, []);

  const handleDockDragEnd = useCallback((event: DragEndEvent) => {
    finishDockDrag();
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const sourceIndex = reorderableDockAppIds.indexOf(String(active.id));
    const targetIndex = reorderableDockAppIds.indexOf(String(over.id));
    if (sourceIndex < 0 || targetIndex < 0) return;
    setDockOrder(arrayMove(reorderableDockAppIds, sourceIndex, targetIndex));
  }, [finishDockDrag, reorderableDockAppIds]);

  /** After a window closes or hides, focus goes to the next window, or the dock's Launchpad button. */
  const focusAfterClose = useCallback((nextId: string | undefined) => {
    if (nextId) {
      focusWindowElement(nextId);
      return;
    }
    window.requestAnimationFrame(() => launchpadButtonRef.current?.focus({ preventScroll: true }));
  }, [focusWindowElement]);

  /** Removes a window for good (after its closing animation). */
  const removeWindow = useCallback((id: string) => {
    appFrameRefs.current.delete(id);
    setLoadedFrameIds((current) => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    setDesktopAudiobookPlayback((current) => current?.windowId === id ? undefined : current);
    setAppChromeByWindow((current) => {
      return removeWindowChrome(current, id);
    });
    const nextActive = frontmostDesktopWindow(windows, id);
    setWindows((current) => normalizeDesktopWindowStack(current.filter((windowModel) => windowModel.id !== id)));
    setActiveWindowId(nextActive?.id ?? "");
    focusAfterClose(nextActive?.id);
  }, [focusAfterClose, windows]);

  // Closing: a short fade-and-settle (an exit, 140ms on the exit curve), then
  // the window is removed. A window whose audiobook is playing hides instead.
  const closingWindowIdsRef = useRef(new Set<string>());
  const closeWindow = useCallback((id: string) => {
    const action = desktopCloseAction(id, desktopAudiobookPlayback
      ? {
        windowId: desktopAudiobookPlayback.windowId,
        bookTitle: desktopAudiobookPlayback.book?.title,
        isPlaying: desktopAudiobookPlayback.state.isPlaying,
      }
      : undefined);
    if (action.kind === "hide") {
      // Closing the audiobook window keeps playback running, and says so
      // (D-P0-5): the window hides, the book keeps playing, and the toast
      // offers Stop and Show. Never a silent minimize that looks like a close.
      const nextActive = frontmostDesktopWindow(windows, id);
      setWindows((current) => current.map((windowModel) =>
        windowModel.id === id ? { ...windowModel, minimized: true } : windowModel,
      ));
      setActiveWindowId(nextActive?.id ?? "");
      focusAfterClose(nextActive?.id);
      toast(action.message, {
        id: "desktop-audiobook-hidden",
        action: { label: "Stop", onClick: () => sendDesktopAudiobookCommand("stop") },
        cancel: { label: "Show", onClick: () => focusWindow(id) },
      });
      return;
    }
    if (closingWindowIdsRef.current.has(id)) return;
    const element = desktopWindowRefs.current.get(id);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    if (!element || reduce || typeof element.animate !== "function") {
      removeWindow(id);
      return;
    }
    closingWindowIdsRef.current.add(id);
    element.style.pointerEvents = "none";
    const animation = element.animate(
      [
        { opacity: 1, transform: "scale(1)" },
        { opacity: 0, transform: "scale(0.97)" },
      ],
      { duration: DURATION_MS.exit, easing: CSS_EASE_EXIT, fill: "forwards" },
    );
    void animation.finished
      .catch(() => undefined)
      .finally(() => {
        closingWindowIdsRef.current.delete(id);
        removeWindow(id);
      });
  }, [
    desktopAudiobookPlayback,
    focusAfterClose,
    focusWindow,
    removeWindow,
    sendDesktopAudiobookCommand,
    windows,
  ]);

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
    let minimizedStateCommitted = false;
    try {
      await playDesktopWindowMotion(windowElement, offset, "minimize", () => {
        flushSync(() => finishMinimizingWindow(id));
        minimizedStateCommitted = true;
      });
    } finally {
      if (!minimizedStateCommitted) {
        finishMinimizingWindow(id);
      }
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


  /**
   * Container state for a service app (never for Talome's own apps or
   * not-yet-identified native links). An app operation in flight (an update
   * recreating the container) reads as working, never as missing or stopped.
   */
  const serviceStatusFor = (app: DesktopAppDefinition): DesktopServiceStatus | undefined => {
    const serviceId = app.serviceApp?.id;
    if (!serviceId || serviceId.startsWith("native:")) return undefined;
    return withActiveOperation(serviceStatus(serviceId), serviceId, activeOperations);
  };

  const windowApp = (windowModel: DesktopWindowModel): DesktopAppDefinition => resolveAppDefinition(
    windowModel.appId,
    windowModel.url,
    windowModel.title,
  ) ?? appDefinitionFromNav({
    title: windowModel.title,
    url: windowModel.url,
    icon: Home01Icon,
  });
  const windowShowsServiceState = useServiceWindowGates(windows.map((windowModel) => ({
    windowId: windowModel.id,
    state: serviceStatusFor(windowApp(windowModel))?.state,
    frameLoaded: loadedFrameIds.has(windowModel.id),
  })));

  /** Fill or previous size from the Dock's menu: the same toggle as Arrange › Fill, for the keyboard. */
  const toggleZoomWindow = (id: string) => {
    const target = windows.find((windowModel) => windowModel.id === id);
    if (!target) return;
    const minimum = windowApp(target).minimum;
    updateWindow(id, (current) => current.maximized
      ? {
        ...current,
        maximized: false,
        bounds: current.restoreBounds ? clampDesktopBounds(current.restoreBounds, area, minimum) : current.bounds,
        restoreBounds: undefined,
      }
      : { ...current, maximized: true, restoreBounds: current.bounds, bounds: maximizedDesktopBounds(area) });
  };

  /** "Remove from Dock" for an app that isn't installed any more: unpin it and close its window. */
  const removeMissingService = (app: DesktopAppDefinition, windowId: string) => {
    const serviceId = app.serviceApp?.id;
    if (serviceId) setPinnedServiceApps((current) => current.filter((candidate) => candidate.id !== serviceId));
    closeWindow(windowId);
  };

  const startDockService = async (name: string, service: DesktopServiceStatus) => {
    const startPath = desktopServiceStartPath(service);
    if (!startPath || !service.container) return;
    try {
      await talomePost(startPath);
    } catch (err) {
      toast.error(`Couldn't start ${name}${err instanceof Error && err.message ? `: ${err.message}` : ""}`, {
        action: { label: "Retry", onClick: () => void startDockService(name, service) },
      });
      return;
    }
    const latest = await refreshStacks();
    const state = latest
      ? desktopServiceStatusLookup(latest, true)(service.container.name).state
      : "unknown";
    if (state === "running") toast.success(`Started ${name} · running`);
    else toast(`Asked ${name} to start · not running yet`, { description: "Check Services if it doesn't come up." });
  };

  const serverHealthy = health.status === "online";
  // The same sentence as the classic banner (one source of words).
  const healthCopy = health.status === "online"
    ? null
    : healthBannerCopy(health.status, health.checks, health.since, health.reachable);
  const healthLine = healthCopy?.title ?? "";

  const openSearch = () => {
    setControlCenterOpen(false);
    openPalette({ mode: "search" });
  };

  const saveClassicMode = () => {
    void persistDashboardModePreference(user?.userId, "classic").then((saved) => {
      if (saved) void mutateUser();
      reportModeSave(saved, "classic", saveClassicMode);
    });
  };

  const selectClassicMode = () => {
    writeDashboardModePreference(user?.userId, "classic");
    void mutateUser((current) => current ? {
      ...current,
      preferences: { ...current.preferences, desktopMode: "classic" },
    } : current, { revalidate: false });
    router.push("/dashboard");
    saveClassicMode();
  };

  const openDesktopWidgetEditor = () => {
    if (!hasPermission("dashboard")) return;
    setControlCenterOpen(false);
    setLaunchpadOpen(false);
    setWallpaperDialogOpen(false);
    setDashboardEditing(false);
    setDesktopWidgetsEditing(true);
  };

  const openWallpaperEditor = () => {
    setControlCenterOpen(false);
    setDesktopWidgetsEditing(false);
    setWallpaperDialogOpen(true);
  };

  const openControlCenterApp = useCallback((url: string) => {
    const pathname = url.split("?")[0];
    const fixedApp = DESKTOP_APPS.find((app) => app.url === pathname);
    const navItem = allNav.find((item) => item.url === pathname);
    const app = fixedApp ?? (navItem ? appDefinitionFromNav(navItem) : undefined);
    if (!app) return;
    setControlCenterOpen(false);
    openApp({ ...app, url }, true);
  }, [openApp]);

  const openNowPlayingAudiobook = useCallback(() => {
    const book = desktopAudiobookPlayer.book;
    const app = appDefinitionFromDashboardRoute(
      book ? `/dashboard/audiobooks/${book.bookId}` : "/dashboard/audiobooks",
    );
    if (!app) return;
    setControlCenterOpen(false);
    openApp(app, true);
  }, [desktopAudiobookPlayer.book, openApp]);

  const showNowPlayingAudiobookControls = useCallback(() => {
    setControlCenterNavigationDirection("push");
    setControlCenterView("audiobooks");
    setControlCenterOpen(true);
  }, []);

  const pushControlCenterView = useCallback((view: Exclude<DesktopControlCenterView, "main">) => {
    if (view === "dashboard") setDashboardEditing(false);
    setControlCenterNavigationDirection("push");
    setControlCenterView(view);
  }, []);

  const popControlCenterView = useCallback(() => {
    setControlCenterNavigationDirection("pop");
    setControlCenterView("main");
  }, []);

  /**
   * Saves the wallpaper to the account and reports a failed save (D-P0-6):
   * the new wallpaper stays on this browser, and the dialog says it wasn't
   * saved to the account, with Retry. The old code ignored the PUT's result.
   */
  const saveWallpaperToAccount = useCallback(async (
    nextWallpaperUrl?: string,
    nextAttribution?: DesktopWallpaperAttribution,
  ) => {
    setWallpaperAccountSave({ status: "saving" });
    try {
      const response = await fetch("/api/auth/preferences/desktop", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallpaperUrl: nextWallpaperUrl ?? null,
          attribution: nextAttribution ?? null,
        }),
      });
      if (!response.ok) throw new Error(String(response.status));
      setWallpaperAccountSave({ status: "idle" });
      void mutateUser();
    } catch {
      const retry = () => void saveWallpaperToAccount(nextWallpaperUrl, nextAttribution);
      setWallpaperAccountSave({ status: "failed", retry });
      // Closed already (the common flow): the inline message would never be seen.
      reportWallpaperAccountSaveFailure(wallpaperDialogOpenRef.current, retry);
    }
  }, [mutateUser]);

  const updateWallpaper = useCallback((
    nextWallpaperUrl?: string,
    nextAttribution?: DesktopWallpaperAttribution,
  ) => {
    let savedLocally = true;
    try {
      if (nextWallpaperUrl) {
        localStorage.setItem(DESKTOP_WALLPAPER_STORAGE_KEY, nextWallpaperUrl);
      } else {
        localStorage.removeItem(DESKTOP_WALLPAPER_STORAGE_KEY);
      }
      if (nextAttribution) {
        localStorage.setItem(
          DESKTOP_WALLPAPER_ATTRIBUTION_STORAGE_KEY,
          JSON.stringify(nextAttribution),
        );
      } else {
        localStorage.removeItem(DESKTOP_WALLPAPER_ATTRIBUTION_STORAGE_KEY);
      }
    } catch {
      savedLocally = false;
    }
    setWallpaperUrl(nextWallpaperUrl);
    setWallpaperAttribution(nextAttribution);
    if (user?.authenticated) void saveWallpaperToAccount(nextWallpaperUrl, nextAttribution);
    return savedLocally || user?.authenticated === true;
  }, [saveWallpaperToAccount, user?.authenticated]);

  const updateShowDesktopDrives = useCallback((show: boolean) => {
    try {
      localStorage.setItem(DESKTOP_DRIVES_STORAGE_KEY, String(show));
    } catch {
      // Keep the current-session preference even when storage is unavailable.
    }
    if (!show) setSelectedDesktopDrivePath(undefined);
    setShowDesktopDrives(show);
  }, []);

  const clearDesktopDriveSelection = useCallback((event: SyntheticEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("[data-desktop-drive-group]")) return;
    setSelectedDesktopDrivePath(undefined);
  }, []);

  const openDesktopDrive = useCallback((path: string) => {
    const filesApp = appById.get("files");
    if (!filesApp) return;
    openApp({
      ...filesApp,
      url: `/dashboard/files?path=${encodeURIComponent(path)}`,
    }, true);
  }, [openApp]);

  // Log out only navigates once the server confirmed it (D-P0-6).
  const logOut = async () => {
    const result = await endSession();
    if (result.ok) {
      router.push("/");
      return;
    }
    toast.error(result.error, { action: { label: "Retry", onClick: () => void logOut() } });
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
    setLoadedFrameIds((current) => current.has(windowId) ? current : new Set(current).add(windowId));
    event.currentTarget.contentWindow?.postMessage(
      { type: DESKTOP_APP_ACTIONS_REQUEST_MESSAGE },
      window.location.origin,
    );
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
    <div
      data-desktop-widget-editing={desktopWidgetsEditing ? "true" : undefined}
      data-desktop-root=""
      className="relative flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-foreground"
      onPointerDownCapture={clearDesktopDriveSelection}
      onClickCapture={clearDesktopDriveSelection}
    >
      {wallpaperUrl ? (
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
          <Image
            src={wallpaperUrl}
            alt=""
            fill
            unoptimized
            // The desktop's first paint: fetched eagerly, ahead of everything else
            preload
            fetchPriority="high"
            sizes="100vw"
            className="object-cover"
          />
        </div>
      ) : null}
      {wallpaperAttribution ? (
        <p className="material-island absolute bottom-2 left-3 z-10 rounded-md px-2 py-1 text-xs text-muted-foreground">
          Photo by{" "}
          <a
            href={wallpaperAttribution.photographerUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground hover:underline"
          >
            {wallpaperAttribution.photographerName}
          </a>{" "}
          on{" "}
          <a
            href={wallpaperAttribution.photoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground hover:underline"
          >
            {wallpaperAttribution.providerName ?? "Unsplash"}
          </a>
        </p>
      ) : null}

      <div ref={workspaceRef} className="relative z-[1] flex-1 min-h-0 overflow-hidden">
        <div
          ref={workAreaRef}
          aria-hidden="true"
          data-desktop-work-area=""
          className="pointer-events-none invisible absolute inset-x-0 top-0 bottom-[var(--desktop-dock-reserve)]"
        />
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              aria-hidden={desktopWidgetsEditing || undefined}
              inert={desktopWidgetsEditing}
              tabIndex={desktopWidgetsEditing ? -1 : 0}
              role="application"
              aria-roledescription="desktop"
              className="absolute inset-0 z-0 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              aria-label="Desktop. Press Shift+F10 for desktop options."
              onKeyDown={(event) => {
                if (!(
                  (event.shiftKey && event.key === "F10")
                  || event.key === "ContextMenu"
                )) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
                  bubbles: true,
                  cancelable: true,
                  clientX: bounds.left + bounds.width / 2,
                  clientY: bounds.top + bounds.height / 2,
                }));
              }}
            >
            </div>
          </ContextMenuTrigger>
          <DesktopSurfaceContextMenuContent
            canEditWidgets={hasPermission("dashboard")}
            editingWidgets={desktopWidgetsEditing}
            showDesktopDrives={showDesktopDrives}
            onShowDesktopDrivesChange={updateShowDesktopDrives}
            onEditWidgets={openDesktopWidgetEditor}
            onFinishEditingWidgets={() => setDesktopWidgetsEditing(false)}
            onOpenWallpaper={openWallpaperEditor}
          />
        </ContextMenu>

        <AnimatePresence>
          {desktopWidgetsEditing ? (
            <motion.div
              key="desktop-widget-edit-backdrop"
              data-desktop-widget-edit-blocker
              className="absolute inset-0 z-[1000] bg-scrim"
              aria-hidden="true"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: DURATION.fast, ease: EASE_ENTER } }}
              exit={{ opacity: 0, transition: { duration: DURATION.exitFast, ease: EASE_EXIT } }}
            />
          ) : null}
        </AnimatePresence>

        {hasPermission("dashboard") ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                data-desktop-widget-canvas
                data-drive-lane-reserved={showDesktopDrives && !desktopWidgetsEditing ? "true" : "false"}
                aria-label="Desktop widgets"
                className={cn(
                  "absolute top-6 left-6",
                  desktopWidgetsEditing
                    ? "z-[1100] max-h-[calc(100%-6rem-var(--desktop-dock-reserve))] overflow-y-auto overscroll-contain p-3 pb-4 pr-4"
                    : "z-[10]",
                )}
                style={{
                  width: showDesktopDrives && !desktopWidgetsEditing
                    ? "min(44rem, calc(100% - 10.5rem))"
                    : "min(44rem, calc(100% - 3rem))",
                }}
              >
                <ControlledWidgetGrid
                  controller={desktopWidgetLayoutController}
                  editMode={desktopWidgetsEditing}
                  showAddDock={desktopWidgetsEditing}
                  maxColumns={3}
                  maxWidgetCols={2}
                  maxWidgetRows={2}
                  onEditDoneRequested={() => setDesktopWidgetsEditing(false)}
                />
              </div>
            </ContextMenuTrigger>
            <DesktopSurfaceContextMenuContent
              canEditWidgets
              editingWidgets={desktopWidgetsEditing}
              showDesktopDrives={showDesktopDrives}
              onShowDesktopDrivesChange={updateShowDesktopDrives}
              onEditWidgets={openDesktopWidgetEditor}
              onFinishEditingWidgets={() => setDesktopWidgetsEditing(false)}
              onOpenWallpaper={openWallpaperEditor}
            />
          </ContextMenu>
        ) : null}

        <AnimatePresence>
          {desktopWidgetsEditing ? (
            <motion.div
              key="desktop-widget-edit-toolbar"
              role="toolbar"
              aria-label="Desktop widget editing"
              className="material-island absolute bottom-6 left-1/2 z-[1200] flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-border p-2 pl-3 shadow-lg"
              initial={{ opacity: 0, y: TRAVEL.rise }}
              animate={{ opacity: 1, y: 0, transition: { duration: DURATION.fast, ease: EASE_ENTER } }}
              exit={{ opacity: 0, y: TRAVEL.rise, transition: { duration: DURATION.exitFast, ease: EASE_EXIT } }}
            >
              <HugeiconsIcon icon={DashboardSquareEditIcon} size={16} />
              <span className="whitespace-nowrap text-sm font-medium">Desktop widgets</span>
              <span className="h-5 w-px bg-border" />
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                Drag to reorder · Esc to finish
              </span>
              <button
                ref={desktopWidgetDoneButtonRef}
                type="button"
                data-desktop-widget-edit-done
                className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors duration-150 hover:bg-primary/90 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onPointerDown={() => setDesktopWidgetsEditing(false)}
                onClick={() => setDesktopWidgetsEditing(false)}
              >
                <HugeiconsIcon icon={Tick01Icon} size={13} />
                Done
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {showDesktopDrives && !desktopWidgetsEditing ? (
          <DesktopDriveIcons
            onOpen={openDesktopDrive}
            onHide={() => updateShowDesktopDrives(false)}
            selectedPath={selectedDesktopDrivePath}
            onSelectionChange={setSelectedDesktopDrivePath}
            disabled={desktopWidgetsEditing}
          />
        ) : null}

        {windows.map((windowModel) => {
          const appChrome = appChromeByWindow[windowModel.id];
          const app = windowApp(windowModel);
          const service = serviceStatusFor(app);
          // A page that loaded is kept through a restart or update; it is
          // replaced only once the service has stayed down (useServiceWindowGates).
          const unavailable = Boolean(service && isServiceUnavailable(service.state) && windowShowsServiceState(windowModel.id));
          return (
            <DesktopWindow
              key={windowModel.id}
              id={windowModel.id}
              // A Talome page draws the unified toolbar itself (its title is
              // the page's place); a service's own page, or the "unavailable"
              // state, gets the window's title bar instead. The window's
              // accessible names (Close, Minimize, Arrange) stay the app's.
              chrome={desktopWindowChrome(windowModel.url, unavailable)}
              title={appChrome?.title ?? windowModel.title}
              appTitle={windowModel.title}
              bounds={windowModel.bounds}
              restoreBounds={windowModel.restoreBounds}
              area={area}
              minimum={app.minimum}
              active={windowModel.id === activeWindowId}
              maximized={windowModel.maximized}
              minimized={windowModel.minimized}
              disabled={desktopWidgetsEditing}
              zIndex={desktopWindowZIndex(windowModel.zIndex)}
              actions={unavailable ? undefined : appChrome?.actions}
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
              animateIn={openingWindowIdsRef.current.has(windowModel.id)}
              onTile={(bounds, restoreBounds) => updateWindow(windowModel.id, (current) => ({
                ...current,
                maximized: false,
                bounds,
                restoreBounds,
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
              {unavailable && service ? (
                // Talome's own state instead of the browser's error page (D-P0-3).
                <DesktopServiceUnavailable
                  name={app.title}
                  state={service.state}
                  startPath={desktopServiceStartPath(service)}
                  canStart={hasPermission("apps")}
                  onStarted={() => refreshStacks()}
                  onRemoveFromDock={service.state === "missing" ? () => removeMissingService(app, windowModel.id) : undefined}
                  onOpenAppStore={service.state === "missing" && hasPermission("apps")
                    ? () => openDashboardRoute("/dashboard/apps")
                    : undefined}
                />
              ) : (
                <DesktopAppFrame
                  // A new URL (the window navigated to another app route) is a new page.
                  key={windowModel.url}
                  // When the page comes back after its service was down, it reopens
                  // where the person was, not at the app's start page.
                  initialSrc={windowModel.currentUrl ?? windowModel.url}
                  frameRef={(frame) => {
                    if (frame) appFrameRefs.current.set(windowModel.id, frame);
                    else appFrameRefs.current.delete(windowModel.id);
                  }}
                  title={windowModel.title}
                  onLoad={(event) => handleAppFrameLoad(windowModel.id, event)}
                />
              )}
            </DesktopWindow>
          );
        })}

        <DesktopLaunchpad
          open={launchpadOpen}
          zIndex={DESKTOP_LAYER.menus}
          onOpenChange={setLaunchpadOpen}
          onLaunch={launchNavItem}
          onLaunchService={launchService}
          anchorRef={launchpadButtonRef}
          windowState={launchpadWindowState}
        />
      </div>

      <div
        data-desktop-dock-band=""
        // Floats over the bottom of the workspace, so windows slide under the
        // Dock; only the Dock itself takes the pointer.
        className="pointer-events-none absolute inset-x-0 bottom-0 z-[2] flex h-[var(--desktop-dock-reserve)] items-end justify-center px-4"
      >
        {!desktopWidgetsEditing ? (
          <nav
            aria-label="Desktop applications"
            className={cn(
              "desktop-dock tm-glass pointer-events-auto relative flex max-w-full items-end gap-1 rounded-2xl border p-2 transition-[background-color,border-color,box-shadow,opacity] duration-150",
              draggingDockAppId && "border-foreground/20",
            )}
            data-dock-dragging={draggingDockAppId || undefined}
            onPointerMove={(event) => {
              if (event.pointerType !== "mouse" || draggingDockAppId) return;
              // React bubbles events from portals (Control Center, notifications,
              // the Talome menu) through the Dock's tree; only the Dock itself
              // drives magnification, and pointing into an open panel settles it.
              if (!event.currentTarget.contains(event.target as Node)) {
                dockPointerX.set(Number.POSITIVE_INFINITY);
                return;
              }
              dockPointerX.set(event.clientX);
            }}
            onPointerLeave={() => dockPointerX.set(Number.POSITIVE_INFINITY)}
          >
            {/* Names appear the moment you point at an item, as in the macOS Dock */}
            <TooltipProvider delayDuration={0}>
            <DockPointerContext.Provider value={draggingDockAppId ? null : dockPointerX}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <span className="flex">
                  <DockButton
                    label="Launchpad"
                    icon={StartUp02Icon}
                    active={launchpadOpen}
                    expanded={launchpadOpen}
                    running={false}
                    buttonRef={(button) => { launchpadButtonRef.current = button; }}
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
            <DndContext
              sensors={dockSensors}
              collisionDetection={closestCenter}
              onDragStart={handleDockDragStart}
              onDragCancel={finishDockDrag}
              onDragEnd={handleDockDragEnd}
            >
              <SortableContext
                items={reorderableDockAppIds}
                strategy={horizontalListSortingStrategy}
              >
                {visibleDockApps.map((app) => {
                  const windowModel = windowByAppId.get(app.id);
                  const dockIndex = reorderableDockAppIds.indexOf(app.id);
                  const canReorder = dockIndex >= 0;
                  const service = serviceStatusFor(app);
                  const playingHidden = Boolean(
                    windowModel?.minimized
                    && windowModel.id === desktopAudiobookWindowId
                    && desktopAudiobookPlayer.state.isPlaying,
                  );
                  const dockButton = (dragHandle?: DockDragHandle) => (
                    <DockButton
                      label={app.title}
                      icon={app.icon}
                      iconUrl={app.iconUrl}
                      active={
                        !launchpadOpen
                        && windowModel?.id === activeWindowId
                        && !windowModel.minimized
                      }
                      running={!!windowModel}
                      loading={!!windowModel && !windowModel.minimized && !loadedFrameIds.has(windowModel.id)}
                      minimized={windowModel?.minimized}
                      serviceState={service?.state}
                      serviceActivity={service?.activity}
                      stateNote={playingHidden ? "playing, window hidden" : undefined}
                      dragHandle={dragHandle}
                      buttonRef={(button) => {
                        if (button) dockButtonRefs.current.set(app.id, button);
                        else dockButtonRefs.current.delete(app.id);
                      }}
                      onClick={() => openApp(app)}
                    />
                  );
                  const contextMenu = (dragHandle?: DockDragHandle) => (
                    <DockAppContextMenu
                      title={app.title}
                      windowModel={windowModel}
                      serviceState={service?.state}
                      onStartService={service && desktopServiceStartPath(service) && hasPermission("apps") && (service.state === "stopped" || service.state === "unhealthy")
                        ? () => void startDockService(app.title, service)
                        : undefined}
                      pinned={app.serviceApp
                        ? pinnedServiceIds.has(app.serviceApp.id)
                        : pinnedAppIdSet.has(app.id)}
                      onOpen={() => openApp(app)}
                      onMinimize={windowModel
                        ? () => void minimizeWindow(windowModel.id, windowModel.appId)
                        : undefined}
                      onToggleZoom={windowModel
                        ? () => toggleZoomWindow(windowModel.id)
                        : undefined}
                      onClose={windowModel
                        ? () => closeWindow(windowModel.id)
                        : undefined}
                      onTogglePin={app.serviceApp || (!appById.has(app.id) && app.id !== PLAYER_APP_ID)
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
                      {dockButton(dragHandle)}
                    </DockAppContextMenu>
                  );

                  if (canReorder) {
                    return (
                      <SortableDockItem key={app.id} id={app.id}>
                        {contextMenu}
                      </SortableDockItem>
                    );
                  }

                  return (
                    <div key={app.id} className="flex items-center gap-1">
                      <span className="mx-1 h-9 w-px bg-border" />
                      {contextMenu()}
                    </div>
                  );
                })}
              </SortableContext>
            </DndContext>
            </DockPointerContext.Provider>
            </TooltipProvider>
            <span className="mx-1 h-9 w-px self-center bg-border" aria-hidden="true" />
            {/* The status tray: what the menu bar used to hold (now playing, approvals,
                search, Control Center, notifications, the Talome menu with health). */}
            <div role="group" aria-label="Status" className="flex items-center gap-0.5 self-center">
              <AnimatePresence initial={false}>
                {desktopAudiobookPlayer.book ? (
                  <motion.div
                    key={desktopAudiobookPlayer.book.bookId}
                    role="group"
                    aria-label={`Now playing ${desktopAudiobookPlayer.book.title}`}
                    className="relative mr-1 flex h-10 max-w-48 items-center overflow-hidden rounded-xl bg-muted/45 text-sm"
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1, transition: enterTransition(DURATION.pill) }}
                    exit={{ opacity: 0, transition: { duration: DURATION.exitFast, ease: EASE_EXIT } }}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 self-stretch pl-3 pr-1 text-left outline-none transition-colors duration-150 hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      aria-label={`Open now playing audiobook: ${desktopAudiobookPlayer.book.title}`}
                      aria-haspopup="dialog"
                      aria-expanded={controlCenterOpen && controlCenterView === "audiobooks"}
                      onClick={showNowPlayingAudiobookControls}
                    >
                      <HugeiconsIcon icon={HeadphonesIcon} size={16} className="shrink-0 text-muted-foreground" />
                      <span className="truncate">{desktopAudiobookPlayer.book.title}</span>
                    </button>
                    <button
                      type="button"
                      className="flex size-10 shrink-0 items-center justify-center text-muted-foreground outline-none transition-[background-color,color,transform] duration-100 hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-safe:active:scale-95"
                      aria-label={desktopAudiobookPlayer.state.isPlaying ? "Pause audiobook" : "Play audiobook"}
                      onClick={desktopAudiobookPlayer.togglePlay}
                    >
                      <IconSwap
                        active={desktopAudiobookPlayer.state.isPlaying ? "a" : "b"}
                        a={<HugeiconsIcon icon={PauseIcon} size={15} />}
                        b={<HugeiconsIcon icon={PlayIcon} size={15} />}
                      />
                    </button>
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground/10" aria-hidden="true">
                      <span
                        className="block h-full bg-foreground/55 motion-reduce:transition-none"
                        style={{ width: `${desktopAudiobookProgress}%`, transition: DESKTOP_PROGRESS_TRANSITION }}
                      />
                    </span>
                  </motion.div>
                ) : null}
              </AnimatePresence>
              {/* Approvals waiting for an admin (D-P0-1): hidden when none wait and for members. */}
              <DesktopApprovalsButton
                isAdmin={user?.role === "admin"}
                side="top"
                triggerClassName={DOCK_TRAY_BUTTON_CLASS}
                iconSize={19}
                onReviewAll={(href) => openDashboardRoute(href ?? "/dashboard/settings/approvals")}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={DOCK_TRAY_BUTTON_CLASS}
                    aria-label="Search Talome"
                    aria-haspopup="dialog"
                    onClick={openSearch}
                  >
                    <HugeiconsIcon icon={Search01Icon} size={19} strokeWidth={1.6} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={14}>
                  Search <span className="ml-2 opacity-70">{SHORTCUTS.palette.hint}</span>
                </TooltipContent>
              </Tooltip>
              <Popover
                open={controlCenterOpen}
                onOpenChange={(open) => {
                  if (open) {
                    setControlCenterNavigationDirection("push");
                    setControlCenterView("main");
                  }
                  setControlCenterOpen(open);
                }}
              >
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(DOCK_TRAY_BUTTON_CLASS, controlCenterOpen && "bg-muted/60 text-foreground")}
                    aria-label="Control Center"
                    aria-haspopup="dialog"
                  >
                    <HugeiconsIcon icon={SlidersHorizontalIcon} size={19} strokeWidth={1.6} />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="end"
                  side="top"
                  sideOffset={12}
                  className={cn(
                    "z-[1300] w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border-border bg-surface-popover p-0 shadow-lg",
                  )}
                  aria-label="Control Center"
                >
                  <motion.div
                    layout={!reduceMotion}
                    className="relative overflow-hidden"
                    transition={{
                      layout: reduceMotion
                        ? { duration: 0 }
                        : { duration: DURATION.fast, ease: EASE_ENTER },
                    }}
                  >
                    <AnimatePresence
                      initial={false}
                      custom={controlCenterNavigationDirection}
                      mode="popLayout"
                    >
                      <motion.div
                        key={controlCenterView}
                        data-control-center-view={controlCenterView}
                        className="relative w-full bg-surface-popover"
                        custom={controlCenterNavigationDirection}
                        variants={reduceMotion ? CONTROL_CENTER_PAGE_VARIANTS_REDUCED : CONTROL_CENTER_PAGE_VARIANTS}
                        initial="enter"
                        animate="center"
                        exit="exit"
                      >
                        {controlCenterView === "dashboard" && hasPermission("dashboard") ? (
                          <DesktopWidgetsPanel
                            controller={dashboardWidgetLayoutController}
                            title="Widgets"
                            subtitle={`${dashboardWidgetLayoutController.layout.filter((widget) => widget.visible).length} widgets`}
                            editing={dashboardEditing}
                            onEditingChange={setDashboardEditing}
                            onBack={popControlCenterView}
                          />
                        ) : controlCenterView === "audiobooks" ? (
                          <DesktopAudiobooksControlCenter
                            audiobookPlayer={desktopAudiobookPlayer}
                            onBack={popControlCenterView}
                            onOpenApp={openNowPlayingAudiobook}
                          />
                        ) : controlCenterView === "downloads" ? (
                          <DesktopDownloadsControlCenter
                            onBack={popControlCenterView}
                            onOpenApp={() => openControlCenterApp("/dashboard/media?tab=downloads")}
                          />
                        ) : (
                          <DesktopControlCenter
                            audiobookPlayer={desktopAudiobookPlayer}
                            canOpenDashboard={hasPermission("dashboard")}
                            onOpenAudiobooks={() => pushControlCenterView("audiobooks")}
                            onOpenDownloads={() => pushControlCenterView("downloads")}
                            onOpenDashboard={() => pushControlCenterView("dashboard")}
                            onOpenWallpaper={openWallpaperEditor}
                          />
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </motion.div>
                </PopoverContent>
              </Popover>
              <NotificationsBell side="top" triggerClassName={DOCK_TRAY_BUTTON_CLASS} iconSize={19} dotClassName="top-2 right-2" />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    data-desktop-health={serverHealthy ? undefined : health.status}
                    className={DOCK_TRAY_BUTTON_CLASS}
                    aria-label={serverHealthy ? "Talome menu" : `Talome menu: ${healthLine}`}
                  >
                    <span className="relative flex size-7 items-center justify-center rounded-full border border-border bg-card">
                      <HugeiconsIcon icon={UserIcon} size={14} />
                      {/* Core health on the Talome menu (D-P0-2): the classic banner isn't shown on the desktop. */}
                      {!serverHealthy ? (
                        <span
                          aria-hidden="true"
                          data-desktop-health-dot
                          className={cn(
                            "tm-badge-in absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card",
                            healthCopy?.unreachable ? "bg-status-critical" : "bg-status-warning",
                          )}
                        />
                      ) : null}
                    </span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" sideOffset={12} className="w-72">
                  {healthCopy ? (
                    <>
                      {/* A label, not a live region: role=menu holds only items, groups and
                          separators. Retry is described by it, and the trigger's name carries it. */}
                      <DropdownMenuLabel id="desktop-health-line" className="grid gap-1 font-normal">
                        <span className={cn("text-sm font-medium", healthCopy.unreachable ? "text-status-critical" : "text-status-warning")}>
                          {healthCopy.title}
                        </span>
                        <span className="text-xs text-muted-foreground">{healthCopy.detail}</span>
                      </DropdownMenuLabel>
                      <DropdownMenuItem aria-describedby="desktop-health-line" onSelect={() => health.recheck()}>Retry</DropdownMenuItem>
                      {!healthCopy.unreachable && hasPermission("chat") ? (
                        <DropdownMenuItem
                          onSelect={() => openPalette({ mode: "chat", prefill: diagnosePrompt(health.checks) })}
                        >
                          Diagnose with Talome
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuSeparator />
                    </>
                  ) : null}
                  <DropdownMenuLabel className="flex items-center justify-between gap-3">
                    <span className="truncate">{user?.username ?? "Account"}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      {roleLabel(user?.role)}
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {appById.get("settings") && canUseApp(appById.get("settings")!) ? (
                    <DropdownMenuItem onSelect={() => openApp(appById.get("settings")!)}>
                      <HugeiconsIcon icon={Settings01Icon} size={14} />
                      Settings…
                    </DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={selectClassicMode}>
                    <HugeiconsIcon icon={ArrowRight01Icon} size={14} />
                    Switch to classic layout
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => void logOut()}>
                    <HugeiconsIcon icon={Logout01Icon} size={14} />
                    Log out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </nav>
        ) : null}
      </div>

      <DesktopWallpaperDialog
        open={wallpaperDialogOpen}
        wallpaperUrl={wallpaperUrl}
        wallpaperAttribution={wallpaperAttribution}
        onOpenChange={setWallpaperDialogOpen}
        onWallpaperChange={updateWallpaper}
        accountSave={wallpaperAccountSave}
      />
    </div>
  );
}

/**
 * A window's page. `src` is read once when the frame mounts: in-app
 * navigation is reported back as `currentUrl`, and writing that into `src`
 * would reload the page on every navigation.
 */
function DesktopAppFrame({
  initialSrc,
  title,
  frameRef,
  onLoad,
}: {
  initialSrc: string;
  title: string;
  frameRef: (frame: HTMLIFrameElement | null) => void;
  onLoad: (event: SyntheticEvent<HTMLIFrameElement>) => void;
}) {
  const [src] = useState(initialSrc);
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={title}
      // Transparent: the window's glass shows through wherever the app doesn't
      // paint (its sidebar); the app's content column paints the background.
      className="size-full border-0 bg-transparent"
      allow="autoplay; fullscreen; picture-in-picture; microphone"
      allowFullScreen
      onLoad={onLoad}
    />
  );
}

type DockDragHandle = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
> & {
  dragging: boolean;
};

interface SortableDockItemProps {
  id: string;
  children: (dragHandle: DockDragHandle) => ReactNode;
}

function SortableDockItem({ id, children }: SortableDockItemProps) {
  const reduceMotion = useReducedMotion();
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: reduceMotion ? undefined : transition,
    zIndex: isDragging ? 20 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-dock-app-id={id}
      data-dock-sortable
      data-dock-dragging={isDragging || undefined}
      className="relative flex touch-none items-center"
    >
      <motion.div
        initial={false}
        animate={reduceMotion
          ? undefined
          : { y: isDragging ? -TRAVEL.lift : 0, scale: isDragging ? 1.04 : 1 }}
        // Lift is a 150ms tween; the settle after release is the one allowed spring.
        transition={isDragging ? DESKTOP_DOCK_TRANSITION : DRAG_SETTLE_SPRING}
        className={cn(
          "relative flex transform-gpu items-center rounded-xl will-change-transform",
          isDragging && "shadow-lg",
        )}
      >
        {children({
          attributes,
          listeners,
          setActivatorNodeRef,
          dragging: isDragging,
        })}
      </motion.div>
    </div>
  );
}

interface DockAppContextMenuProps {
  title: string;
  windowModel?: DesktopWindowModel;
  pinned?: boolean;
  serviceState?: DesktopServiceStatus["state"];
  children: ReactNode;
  onOpen: () => void;
  onStartService?: () => void;
  onMinimize?: () => void;
  /** Fill the desktop or go back (the old Window › Zoom), for the keyboard. */
  onToggleZoom?: () => void;
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
  serviceState,
  children,
  onOpen,
  onStartService,
  onMinimize,
  onToggleZoom,
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
  const missing = serviceState === "missing";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span className="flex">{children}</span>
      </ContextMenuTrigger>
      <ContextMenuContent className="z-[1400] w-52">
        <ContextMenuGroup>
          {onStartService ? (
            <ContextMenuItem onSelect={onStartService}>Start {title}</ContextMenuItem>
          ) : null}
          {!missing ? <ContextMenuItem onSelect={onOpen}>{primaryLabel}</ContextMenuItem> : null}
          {windowModel && !windowModel.minimized && onMinimize ? (
            <ContextMenuItem onSelect={onMinimize}>Minimize {title}</ContextMenuItem>
          ) : null}
          {windowModel && !windowModel.minimized && onToggleZoom ? (
            <ContextMenuItem onSelect={onToggleZoom}>
              {windowModel.maximized ? `Previous size` : `Fill desktop`}
            </ContextMenuItem>
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
                Move left
              </ContextMenuItem>
              <ContextMenuItem disabled={!onMoveRight} onSelect={onMoveRight}>
                <HugeiconsIcon icon={ArrowRight01Icon} size={16} />
                Move right
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
  iconUrl?: string;
  active: boolean;
  running: boolean;
  /** The app's window is still loading */
  loading?: boolean;
  minimized?: boolean;
  /** Container state for a service app: stopped and missing dim the icon, unhealthy adds a critical dot, working breathes. */
  serviceState?: DesktopServiceStatus["state"];
  /** What a working service is doing ("Restarting", "Updating"). */
  serviceActivity?: string;
  /** For a button that opens an overlay (Launchpad): its open state, as aria-expanded. */
  expanded?: boolean;
  /** Extra state for the name, e.g. "playing, window hidden". */
  stateNote?: string;
  dragHandle?: DockDragHandle;
  buttonRef?: (button: HTMLButtonElement | null) => void;
  onClick: () => void;
}

function DockButton({
  label,
  icon,
  iconUrl,
  active,
  running,
  loading = false,
  minimized,
  serviceState,
  serviceActivity,
  expanded,
  stateNote,
  dragHandle,
  buttonRef,
  onClick,
}: DockButtonProps) {
  const reduceMotion = useReducedMotion();
  const dimmed = serviceState === "stopped" || serviceState === "missing";
  const name = desktopDockItemName({ label, running, minimized, serviceState, serviceActivity, stateNote });
  const serviceLabel = serviceState ? desktopServiceStateLabel(serviceState, serviceActivity) : null;
  const tooltip = [label, serviceLabel, stateNote ? stateNote.charAt(0).toUpperCase() + stateNote.slice(1) : minimized ? "Minimized" : null]
    .filter(Boolean)
    .join(" · ");

  // Magnification, as on macOS: grow with closeness to the pointer (cosine
  // falloff) from the shelf, while the slot widens so neighbours make room and
  // the Dock grows. A near-critically damped spring (lib/dock-magnification)
  // tracks the pointer almost directly and never overshoots; off under reduced
  // motion, and snapped back at once when a drag starts.
  const dockPointer = useContext(DockPointerContext);
  const idlePointer = useMotionValue(Number.POSITIVE_INFINITY);
  const localButton = useRef<HTMLButtonElement | null>(null);
  const magnification = useTransform(dockPointer ?? idlePointer, (pointerX) => {
    const rect = localButton.current?.getBoundingClientRect();
    if (reduceMotion || !rect || !Number.isFinite(pointerX)) return 1;
    return dockMagnification(pointerX - (rect.left + rect.width / 2));
  });
  const scale = useSpring(magnification, DOCK_MAGNIFY_SPRING);
  const slotWidth = useTransform(scale, (value) => DOCK_ICON_SIZE * value);
  useEffect(() => {
    if (!dockPointer) scale.jump(1);
  }, [dockPointer, scale]);
  const button = (
    <motion.button
      ref={(button) => {
        localButton.current = button;
        dragHandle?.setActivatorNodeRef(button);
        buttonRef?.(button);
      }}
      {...dragHandle?.attributes}
      {...dragHandle?.listeners}
      type="button"
      aria-label={name}
      // An overlay toggle says whether it is open; an app says which window is in front.
      aria-expanded={expanded}
      aria-haspopup={expanded === undefined ? undefined : "dialog"}
      aria-current={expanded === undefined && active ? "true" : undefined}
      aria-pressed={undefined}
      data-dock-drag-handle={dragHandle ? "" : undefined}
      data-dock-service-state={serviceState}
      style={{ scale }}
      className={cn(
        "relative isolate flex size-12 origin-bottom transform-gpu items-center justify-center rounded-xl border border-transparent bg-transparent outline-none transition-[background-color,border-color] duration-150 ease-out will-change-transform hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        dragHandle && "cursor-grab touch-none active:cursor-grabbing",
        active && "bg-muted",
      )}
      onClick={onClick}
    >
      <motion.span
        data-dock-icon
        className={cn(
          "relative z-10 flex transition-opacity duration-150 ease-out",
          dimmed && "opacity-50",
        )}
        whileTap={reduceMotion ? undefined : { scale: 0.96, transition: { duration: DURATION.press } }}
      >
        <DockAppIcon
          label={label}
          icon={icon}
          iconUrl={iconUrl}
        />
        {serviceState === "unhealthy" ? (
          <span
            aria-hidden="true"
            data-dock-failed-indicator
            className="absolute -right-1 -top-1 size-2 rounded-full bg-status-critical ring-2 ring-card"
          />
        ) : serviceState === "working" ? (
          <span
            aria-hidden="true"
            data-dock-working-indicator
            className="absolute -right-1 -top-1 size-2 rounded-full bg-status-info ring-2 ring-card motion-safe:animate-breathe"
          />
        ) : null}
      </motion.span>
      <AnimatePresence initial={false}>
        {running ? (
          <motion.span
            key="running"
            aria-hidden="true"
            data-dock-running-indicator
            data-minimized={minimized || undefined}
            data-loading={loading || undefined}
            initial={{ opacity: 0 }}
            // A window still loading shows a faint dot until its page arrives.
            animate={{ opacity: loading ? 0.35 : 1, transition: DESKTOP_DOCK_TRANSITION }}
            exit={{ opacity: 0, transition: { duration: DURATION.exitFast, ease: EASE_EXIT } }}
            className={cn(
              "absolute -bottom-1 z-10 size-1 rounded-full",
              // Minimized is a hollow dot: state by shape, not by dimming.
              minimized ? "ring-1 ring-foreground/70" : "bg-foreground/70",
            )}
          />
        ) : null}
      </AnimatePresence>
    </motion.button>
  );

  return (
    <motion.span className="flex shrink-0 justify-center" style={{ width: slotWidth }}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="top" sideOffset={14}>{tooltip}</TooltipContent>
      </Tooltip>
    </motion.span>
  );
}

function DockAppIcon({
  label,
  icon,
  iconUrl,
}: Pick<DockButtonProps, "label" | "icon" | "iconUrl">) {
  const [failedUrl, setFailedUrl] = useState<string>();
  const candidateIconUrl = resolveApplicationIconUrl(iconUrl);
  const realIconUrl = candidateIconUrl && failedUrl !== candidateIconUrl
    ? candidateIconUrl
    : undefined;
  const resolvedIcon = typeof icon === "string"
    ? resolveApplicationIcon(icon, label)
    : icon;

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

  return <HugeiconsIcon icon={resolvedIcon} size={24} strokeWidth={1.4} />;
}
