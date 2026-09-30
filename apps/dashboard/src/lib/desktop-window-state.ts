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

export interface PersistedDesktopDock {
  version: number;
  apps: PersistedDesktopServiceApp[];
  appIds?: string[];
  order?: string[];
}

export type DesktopDockPlacement = "before" | "after";

export function orderDesktopDockIds(
  visibleIds: string[],
  preferredOrder: string[],
): string[] {
  const visible = new Set(visibleIds);
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const appId of preferredOrder) {
    if (!visible.has(appId) || seen.has(appId)) continue;
    seen.add(appId);
    ordered.push(appId);
  }

  for (const appId of visibleIds) {
    if (seen.has(appId)) continue;
    seen.add(appId);
    ordered.push(appId);
  }

  return ordered;
}

export function reorderDesktopDockIds(
  visibleIds: string[],
  sourceId: string,
  targetId: string,
  placement: DesktopDockPlacement,
): string[] {
  const ordered = Array.from(new Set(visibleIds));
  if (sourceId === targetId || !ordered.includes(sourceId) || !ordered.includes(targetId)) {
    return ordered;
  }

  const withoutSource = ordered.filter((appId) => appId !== sourceId);
  const targetIndex = withoutSource.indexOf(targetId);
  withoutSource.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceId);
  return withoutSource;
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
    x: 0,
    y: 0,
    width: Math.max(0, area.width),
    height: Math.max(0, area.height),
  };
}

export type DesktopResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * Resize from any edge or corner. The opposite edge stays put, sizes respect the
 * window minimum, and the window stays inside the desktop area.
 */
export function resizeDesktopBounds(
  origin: DesktopBounds,
  edge: DesktopResizeEdge,
  delta: { x: number; y: number },
  area: DesktopArea,
  minimum: Pick<DesktopBounds, "width" | "height">,
): DesktopBounds {
  let { x, y, width, height } = origin;
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;

  if (edge.includes("e")) {
    width = Math.min(Math.max(origin.width + delta.x, minimum.width), area.width - origin.x);
  }
  if (edge.includes("s")) {
    height = Math.min(Math.max(origin.height + delta.y, minimum.height), area.height - origin.y);
  }
  if (edge.includes("w")) {
    x = Math.min(Math.max(origin.x + delta.x, 0), right - minimum.width);
    width = right - x;
  }
  if (edge.includes("n")) {
    y = Math.min(Math.max(origin.y + delta.y, 0), bottom - minimum.height);
    height = bottom - y;
  }
  return { x, y, width, height };
}

export type DesktopSnapZone = "maximize" | "left" | "right";

/** Distance from the desktop edge (px) at which a dragged window offers to snap. */
export const DESKTOP_SNAP_THRESHOLD = 8;

/** Where a window dragged with the pointer at `point` (desktop coordinates) would snap. */
export function desktopSnapZoneAt(point: { x: number; y: number }, area: DesktopArea): DesktopSnapZone | null {
  if (point.y <= DESKTOP_SNAP_THRESHOLD) return "maximize";
  if (point.x <= DESKTOP_SNAP_THRESHOLD) return "left";
  if (point.x >= area.width - DESKTOP_SNAP_THRESHOLD) return "right";
  return null;
}

/** Bounds a window takes when snapped to half of the desktop. */
export function snappedDesktopBounds(zone: Exclude<DesktopSnapZone, "maximize">, area: DesktopArea): DesktopBounds {
  const half = Math.round(area.width / 2);
  return zone === "left"
    ? { x: 0, y: 0, width: half, height: area.height }
    : { x: half, y: 0, width: area.width - half, height: area.height };
}

/**
 * Dragging a maximized or snapped window gives it back its previous size, keeping
 * the pointer at the same relative spot of the title bar (like macOS).
 */
export function unsnapDesktopBounds(
  current: DesktopBounds,
  restore: DesktopBounds,
  pointer: { x: number; y: number },
  area: DesktopArea,
  minimum: Pick<DesktopBounds, "width" | "height">,
): DesktopBounds {
  const ratio = current.width > 0 ? (pointer.x - current.x) / current.width : 0.5;
  return clampDesktopBounds(
    {
      x: pointer.x - restore.width * ratio,
      y: current.y,
      width: restore.width,
      height: restore.height,
    },
    area,
    minimum,
  );
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

export function isPersistedDesktopDock(value: unknown): value is PersistedDesktopDock {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    version?: unknown;
    apps?: unknown;
    appIds?: unknown;
    order?: unknown;
  };
  return (
    candidate.version === DESKTOP_DOCK_STORAGE_VERSION &&
    Array.isArray(candidate.apps) &&
    candidate.apps.every(isPersistedDesktopServiceApp) &&
    (
      candidate.appIds === undefined ||
      (
        Array.isArray(candidate.appIds) &&
        candidate.appIds.every((appId) => typeof appId === "string" && appId.length > 0)
      )
    ) &&
    (
      candidate.order === undefined ||
      (
        Array.isArray(candidate.order) &&
        candidate.order.every((appId) => typeof appId === "string" && appId.length > 0)
      )
    )
  );
}
