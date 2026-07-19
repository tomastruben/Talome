export interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DesktopArea {
  width: number;
  height: number;
}

export interface DesktopRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type DesktopWindowMotionDirection = "minimize" | "restore";

export interface DesktopWindowMotionKeyframes {
  transform: string[];
  opacity: number[];
  times: number[];
}

export const DESKTOP_WINDOW_STORAGE_KEY = "talome-desktop-windows-v1";
export const DESKTOP_WINDOW_STORAGE_VERSION = 1;
export const DESKTOP_DOCK_STORAGE_KEY = "talome-desktop-dock-v1";
export const DESKTOP_DOCK_STORAGE_VERSION = 1;

export interface PersistedDesktopServiceApp {
  id: string;
  name: string;
  url: string;
  icon?: string;
  iconUrl?: string;
}

const EDGE_INSET = 16;
const MIN_VISIBLE_TITLEBAR = 120;

export function desktopMinimizeOffset(
  windowRect: DesktopRect,
  dockRect: DesktopRect,
) {
  return {
    x: dockRect.left + dockRect.width / 2 -
      (windowRect.left + windowRect.width / 2),
    y: dockRect.top + dockRect.height / 2 -
      (windowRect.top + windowRect.height / 2),
  };
}

function windowTransform(x: number, y: number, scale: number): string {
  return `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
}

export function desktopWindowMotionKeyframes(
  offset: { x: number; y: number },
  direction: DesktopWindowMotionDirection,
): DesktopWindowMotionKeyframes {
  const minimizeTransforms = [
    windowTransform(0, 0, 1),
    windowTransform(offset.x * 0.72, offset.y * 0.72, 0.3),
    windowTransform(offset.x, offset.y, 0.04),
  ];
  const minimizeOpacity = [1, 0.72, 0];

  if (direction === "minimize") {
    return {
      transform: minimizeTransforms,
      opacity: minimizeOpacity,
      times: [0, 0.72, 1],
    };
  }

  return {
    transform: [...minimizeTransforms].reverse(),
    opacity: [...minimizeOpacity].reverse(),
    times: [0, 0.28, 1],
  };
}

export function clampDesktopBounds(
  bounds: DesktopBounds,
  area: DesktopArea,
  minimum: Pick<DesktopBounds, "width" | "height">,
): DesktopBounds {
  const maxWidth = Math.max(minimum.width, area.width - EDGE_INSET * 2);
  const maxHeight = Math.max(minimum.height, area.height - EDGE_INSET * 2);
  const width = Math.min(Math.max(bounds.width, minimum.width), maxWidth);
  const height = Math.min(Math.max(bounds.height, minimum.height), maxHeight);
  const minX = Math.min(EDGE_INSET, area.width - MIN_VISIBLE_TITLEBAR);
  const maxX = Math.max(minX, area.width - Math.min(MIN_VISIBLE_TITLEBAR, width));
  const minY = EDGE_INSET;
  const maxY = Math.max(minY, area.height - 44);

  return {
    x: Math.min(Math.max(bounds.x, minX), maxX),
    y: Math.min(Math.max(bounds.y, minY), maxY),
    width,
    height,
  };
}

export function maximizedDesktopBounds(area: DesktopArea): DesktopBounds {
  return {
    x: EDGE_INSET,
    y: EDGE_INSET,
    width: Math.max(0, area.width - EDGE_INSET * 2),
    height: Math.max(0, area.height - EDGE_INSET * 2),
  };
}

export function isPersistedDesktopLayout(value: unknown): value is {
  version: number;
  windows: unknown[];
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; windows?: unknown };
  return (
    candidate.version === DESKTOP_WINDOW_STORAGE_VERSION &&
    Array.isArray(candidate.windows)
  );
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isPersistedDesktopServiceApp(
  value: unknown,
): value is PersistedDesktopServiceApp {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedDesktopServiceApp>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.url === "string" &&
    isHttpUrl(candidate.url) &&
    (candidate.icon === undefined || typeof candidate.icon === "string") &&
    (candidate.iconUrl === undefined || typeof candidate.iconUrl === "string")
  );
}

export function isPersistedDesktopDock(value: unknown): value is {
  version: number;
  apps: PersistedDesktopServiceApp[];
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { version?: unknown; apps?: unknown };
  return (
    candidate.version === DESKTOP_DOCK_STORAGE_VERSION &&
    Array.isArray(candidate.apps) &&
    candidate.apps.every(isPersistedDesktopServiceApp)
  );
}
