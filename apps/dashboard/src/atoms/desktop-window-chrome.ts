/**
 * The window-chrome channel between a desktop window (components/desktop/
 * desktop-window.tsx, in the desktop document) and the Talome shell running
 * in its frame (components/desktop/window-toolbar.tsx and window-drag.ts).
 *
 * A window has no title bar of its own: the shell in the frame draws the
 * unified toolbar (Back, the title, the app's controls) and the sidebar, and
 * the window draws only its glass, its edges and the window controls. So:
 *
 *   window → frame  state            whether the window is active, and the app's name
 *   window → frame  chrome-request   "do you draw the unified toolbar?" (after each load)
 *   frame → window  chrome           yes (on mount and on request) or no (on unmount)
 *   frame → window  drag             a press-and-move on empty toolbar or sidebar space
 *   frame → window  zoom             a double-click there: Fill, or back from Fill
 *
 * Every message is posted to the same origin, and each side checks the
 * sender (the parent, or the window's own frame) before acting on it.
 */

export const DESKTOP_WINDOW_STATE_MESSAGE = "talome:desktop-window-state";
export const DESKTOP_WINDOW_CHROME_MESSAGE = "talome:desktop-window-chrome";
export const DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE = "talome:desktop-window-chrome-request";
export const DESKTOP_WINDOW_DRAG_MESSAGE = "talome:desktop-window-drag";
export const DESKTOP_WINDOW_ZOOM_MESSAGE = "talome:desktop-window-zoom";

export interface DesktopWindowState {
  /** The window is the one you're working in (its title reads in foreground) */
  active: boolean;
  /** The app's name, the title when the page publishes none */
  title: string;
}

export type DesktopWindowDragPhase = "start" | "move" | "end" | "cancel";

export interface DesktopWindowDragMessage {
  type: typeof DESKTOP_WINDOW_DRAG_MESSAGE;
  phase: DesktopWindowDragPhase;
  pointerId: number;
  /** The pointer, in the desktop document's viewport ("parent") or the frame's ("frame") */
  x: number;
  y: number;
  space: "parent" | "frame";
}

const DRAG_PHASES: readonly DesktopWindowDragPhase[] = ["start", "move", "end", "cancel"];
/** Far beyond any screen, so a bogus coordinate can't fling a window off the desktop */
const COORDINATE_LIMIT = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= COORDINATE_LIMIT;
}

export function parseDesktopWindowStateMessage(value: unknown): DesktopWindowState | null {
  if (
    !isRecord(value)
    || value.type !== DESKTOP_WINDOW_STATE_MESSAGE
    || typeof value.active !== "boolean"
    || typeof value.title !== "string"
    || value.title.length > 128
  ) {
    return null;
  }
  return { active: value.active, title: value.title };
}

export function parseDesktopWindowChromeMessage(value: unknown): { unified: boolean } | null {
  if (!isRecord(value) || value.type !== DESKTOP_WINDOW_CHROME_MESSAGE || typeof value.unified !== "boolean") {
    return null;
  }
  return { unified: value.unified };
}

export function isDesktopWindowChromeRequestMessage(value: unknown): boolean {
  return isRecord(value) && value.type === DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE;
}

export function parseDesktopWindowDragMessage(value: unknown): DesktopWindowDragMessage | null {
  if (
    !isRecord(value)
    || value.type !== DESKTOP_WINDOW_DRAG_MESSAGE
    || !DRAG_PHASES.includes(value.phase as DesktopWindowDragPhase)
    || typeof value.pointerId !== "number"
    || !Number.isInteger(value.pointerId)
    || !isCoordinate(value.x)
    || !isCoordinate(value.y)
    || (value.space !== "parent" && value.space !== "frame")
  ) {
    return null;
  }
  return {
    type: DESKTOP_WINDOW_DRAG_MESSAGE,
    phase: value.phase as DesktopWindowDragPhase,
    pointerId: value.pointerId,
    x: value.x,
    y: value.y,
    space: value.space,
  };
}

export function isDesktopWindowZoomMessage(value: unknown): boolean {
  return isRecord(value) && value.type === DESKTOP_WINDOW_ZOOM_MESSAGE;
}
