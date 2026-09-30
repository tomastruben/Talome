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

function windowTransform(
  x: number,
  y: number,
  scaleX: number,
  scaleY = scaleX,
): string {
  return `translate3d(${x}px, ${y}px, 0) scale3d(${scaleX}, ${scaleY}, 1)`;
}

/** Final scale of a minimized window at the dock icon (spec §7.4). Uniform: no genie squash. */
export const DESKTOP_MINIMIZE_SCALE = 0.2;

/**
 * Minimize travels toward the dock icon with a uniform scale down to 0.2,
 * and the opacity is gone by 70% of the way (spec §7.4). Restore is the exact
 * reverse, so the window comes back out of the same icon.
 */
export function desktopWindowMotionKeyframes(
  offset: { x: number; y: number },
  direction: DesktopWindowMotionDirection,
): DesktopWindowMotionKeyframes {
  const minimizeTransforms = [
    windowTransform(0, 0, 1),
    windowTransform(offset.x * 0.16, offset.y * 0.16, 0.9),
    windowTransform(offset.x * 0.7, offset.y * 0.7, 0.44),
    windowTransform(offset.x, offset.y, DESKTOP_MINIMIZE_SCALE),
  ];
  const minimizeOpacity = [1, 0.85, 0, 0];
  const minimizeTimes = [0, 0.24, 0.7, 1];

  if (direction === "minimize") {
    return {
      transform: minimizeTransforms,
      opacity: minimizeOpacity,
      times: minimizeTimes,
    };
  }

  return {
    transform: [...minimizeTransforms].reverse(),
    opacity: [...minimizeOpacity].reverse(),
    times: [...minimizeTimes].reverse().map((t) => Math.round((1 - t) * 100) / 100),
  };
}

// ── Stacking order ──────────────────────────────────────────────────────────

/**
 * Windows live in their own z band (spec §2.10): 100 + their rank. The dock
 * (1050), menu bar (1100) and overlays sit above the band, so no number of
 * focus changes can paint a window over them.
 */
export const DESKTOP_WINDOW_Z_BASE = 100;

/** CSS z-index for a window's rank (1 = back-most). */
export function desktopWindowZIndex(rank: number): number {
  return DESKTOP_WINDOW_Z_BASE + Math.max(1, Math.floor(rank));
}

/**
 * Re-ranks windows 1..n in their current stacking order (ties keep list
 * order). Used on read, so layouts persisted by the old ever-growing counter
 * (z 5000 and up) come back as small ranks.
 */
export function normalizeDesktopWindowStack<T extends { id: string; zIndex: number }>(windows: readonly T[]): T[] {
  const ranked = windows
    .map((windowModel, index) => ({ windowModel, index }))
    .sort((a, b) => (a.windowModel.zIndex - b.windowModel.zIndex) || (a.index - b.index));
  const rankById = new Map(ranked.map(({ windowModel }, rank) => [windowModel.id, rank + 1]));
  let changed = false;
  const next = windows.map((windowModel) => {
    const zIndex = rankById.get(windowModel.id) ?? 1;
    if (zIndex === windowModel.zIndex) return windowModel;
    changed = true;
    return { ...windowModel, zIndex };
  });
  return changed ? next : (windows as T[]);
}

/**
 * Brings one window to the front. A no-op (same array) when it already is
 * frontmost, so focusing the active window never churns state; otherwise the
 * stack is re-ranked 1..n. The old code incremented a global counter on every
 * pointerdown and focus, so after about 1,000 focuses a window covered the
 * dock and the widget-edit scrim.
 */
export function bringDesktopWindowToFront<T extends { id: string; zIndex: number }>(windows: readonly T[], id: string): T[] {
  const target = windows.find((windowModel) => windowModel.id === id);
  if (!target) return windows as T[];
  const others = windows.filter((windowModel) => windowModel.id !== id);
  const alreadyFront = others.every((windowModel) => windowModel.zIndex < target.zIndex)
    && target.zIndex === windows.length
    && normalizeDesktopWindowStack(windows) === windows;
  if (alreadyFront) return windows as T[];
  const lifted = windows.map((windowModel) => windowModel.id === id
    ? { ...windowModel, zIndex: Number.POSITIVE_INFINITY }
    : windowModel);
  return normalizeDesktopWindowStack(lifted);
}

/** The frontmost window that isn't minimized (or excluded), if any. */
export function frontmostDesktopWindow<T extends { id: string; zIndex: number; minimized: boolean }>(
  windows: readonly T[],
  excludeId?: string,
): T | undefined {
  return windows
    .filter((windowModel) => !windowModel.minimized && windowModel.id !== excludeId)
    .sort((a, b) => b.zIndex - a.zIndex)[0];
}

/**
 * Resize from the bottom-right without ever letting the resize affordance move
 * outside the live desktop. This is intentionally separate from window
 * dragging, where keeping only the titlebar reachable is valid desktop
 * behavior.
 */
export function resizeDesktopBounds(
  bounds: DesktopBounds,
  area: DesktopArea,
  minimum: Pick<DesktopBounds, "width" | "height">,
): DesktopBounds {
  const x = Math.max(0, bounds.x);
  const y = Math.max(0, bounds.y);
  const maxWidth = Math.max(minimum.width, area.width - x);
  const maxHeight = Math.max(minimum.height, area.height - y);

  return {
    x,
    y,
    width: Math.min(Math.max(bounds.width, minimum.width), maxWidth),
    height: Math.min(Math.max(bounds.height, minimum.height), maxHeight),
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
  const minX = 0;
  const maxX = Math.max(minX, area.width - Math.min(MIN_VISIBLE_TITLEBAR, width));
  const minY = 0;
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

export type DesktopCloseAction =
  | { kind: "close" }
  | { kind: "hide"; message: string };

/**
 * What Close does (D-P0-5). A window whose audiobook is playing keeps playing
 * when closed, so it hides instead, and the caller must say so (the message
 * goes in a toast with Stop and Show). A paused book has nothing to keep
 * running, so its window really closes, like every other window.
 */
export function desktopCloseAction(
  windowId: string,
  playback: { windowId: string; bookTitle?: string | null; isPlaying: boolean } | undefined,
): DesktopCloseAction {
  if (playback && playback.windowId === windowId && playback.bookTitle && playback.isPlaying) {
    return { kind: "hide", message: `Still playing ${playback.bookTitle} · window hidden` };
  }
  return { kind: "close" };
}
