"use client";

import { useEffect } from "react";
import {
  DESKTOP_WINDOW_DRAG_MESSAGE,
  DESKTOP_WINDOW_ZOOM_MESSAGE,
  type DesktopWindowDragMessage,
  type DesktopWindowDragPhase,
} from "@/atoms/desktop-window-chrome";

/**
 * Dragging a desktop window by its unified toolbar or its sidebar's top.
 *
 * Those surfaces live in the window's frame, but the window's geometry lives
 * in the desktop document, so the frame forwards the gesture: a press on empty
 * space captures the pointer here and posts its positions to the window
 * (DESKTOP_WINDOW_DRAG_MESSAGE), which moves, snaps and fills exactly as it
 * does for a press on its own edges. A double-click (or a double tap on touch)
 * posts DESKTOP_WINDOW_ZOOM_MESSAGE: Fill, or back from Fill.
 *
 * Surfaces opt in with `data-window-drag-region`:
 *   "toolbar"  any press that isn't on a control drags (the unified toolbar)
 *   "surface"  only a press on the element itself, not on what it holds (the
 *              sidebar panel's reserved top, the margin around it)
 */

export const WINDOW_DRAG_REGION = "data-window-drag-region";
export type WindowDragRegionKind = "toolbar" | "surface";

/**
 * What never starts a drag, even inside a toolbar region: controls, fields,
 * links, menus, anything focusable, and whatever an app marks
 * `data-window-no-drag`. A press there belongs to the control.
 */
const INTERACTIVE = [
  "a[href]",
  "area[href]",
  "button",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "iframe",
  "video",
  "audio",
  "[contenteditable]:not([contenteditable='false'])",
  "[draggable='true']",
  "[tabindex]:not([tabindex='-1'])",
  ...[
    "button", "link", "checkbox", "radio", "radiogroup", "switch", "tab", "tablist",
    "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "listbox",
    "combobox", "slider", "spinbutton", "textbox", "searchbox", "scrollbar", "tree", "treeitem",
    "grid", "gridcell",
  ].map((role) => `[role='${role}']`),
  "[data-slot='toolbar-group']",
  "[data-slot='input-group']",
  ".search-field",
  "[data-window-no-drag]",
].join(", ");

/**
 * The drag region a press on `target` would move the window by, or null when
 * it belongs to something else (a control, the page, another surface's
 * content). Pure, so the rules are tested without a frame.
 */
export function findWindowDragRegion(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element
    ? target
    : target instanceof Node
      ? target.parentElement
      : null;
  if (!element) return null;
  const region = element.closest<HTMLElement>(`[${WINDOW_DRAG_REGION}]`);
  if (!region) return null;
  const kind = region.getAttribute(WINDOW_DRAG_REGION) as WindowDragRegionKind;
  if (kind === "surface") return element === region ? region : null;
  if (kind !== "toolbar") return null;
  const control = element.closest(INTERACTIVE);
  if (control && region.contains(control)) return null;
  return region;
}

/** Pointer travel (screen pixels) within which two presses still count as a double tap. */
const DOUBLE_TAP_SLOP = 16;
const DOUBLE_TAP_MS = 350;
/** Travel past which a press is a drag, not a tap (matches the window's drag threshold). */
const TAP_SLOP = 4;

type Point = Pick<DesktopWindowDragMessage, "x" | "y" | "space">;

/** Fingers and pens double-tap; a mouse double-clicks (and gets a native dblclick). */
const countsTaps = (pointerType: string) => pointerType === "touch" || pointerType === "pen";

/**
 * A point in the frame, in the desktop document's viewport. Measured here,
 * in the same task as the event, so the frame's position and the pointer's
 * agree even while the window moves under the pointer. Without access to the
 * frame element the window adds the frame's offset itself.
 */
function toDesktopPoint(clientX: number, clientY: number): Point {
  try {
    const frame = window.frameElement;
    if (frame) {
      const rect = frame.getBoundingClientRect();
      return {
        x: rect.left + frame.clientLeft + clientX,
        y: rect.top + frame.clientTop + clientY,
        space: "parent",
      };
    }
  } catch {
    // A cross-origin parent hides its frame element.
  }
  return { x: clientX, y: clientY, space: "frame" };
}

function post(message: Record<string, unknown>) {
  window.parent.postMessage(message, window.location.origin);
}

function postDrag(phase: DesktopWindowDragPhase, pointerId: number, point: Point) {
  post({ type: DESKTOP_WINDOW_DRAG_MESSAGE, phase, pointerId, ...point });
}

/**
 * Forwards window drags and double-clicks from this frame's drag regions to
 * the desktop window around it. Mount once, in the window shell.
 */
export function useWindowDragBridge(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    let active: { pointerId: number; region: HTMLElement; screenX: number; screenY: number; moved: boolean; last: Point } | null = null;
    let lastPointerType = "mouse";
    let lastTap: { time: number; screenX: number; screenY: number } | null = null;

    const stop = () => {
      if (!active) return;
      const { region, pointerId } = active;
      active = null;
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("pointerup", handleUp, true);
      window.removeEventListener("pointercancel", handleCancel, true);
      window.removeEventListener("blur", handleCancel);
      window.removeEventListener("pagehide", handleCancel);
      try {
        if (region.hasPointerCapture?.(pointerId)) region.releasePointerCapture(pointerId);
      } catch {
        // Already released.
      }
    };

    const end = (phase: "end" | "cancel", point?: Point) => {
      if (!active) return;
      const { pointerId, last } = active;
      stop();
      postDrag(phase, pointerId, point ?? last);
    };

    const handleMove = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const point = toDesktopPoint(event.clientX, event.clientY);
      // A release we never saw (the pointer left every frame): end the drag
      // where it is rather than keep moving the window with no button down.
      if (event.pointerType === "mouse" && event.buttons === 0) {
        end("end", point);
        return;
      }
      if (Math.hypot(event.screenX - active.screenX, event.screenY - active.screenY) > TAP_SLOP) active.moved = true;
      active.last = point;
      postDrag("move", active.pointerId, point);
    };

    const handleUp = (event: PointerEvent) => {
      if (!active || event.pointerId !== active.pointerId) return;
      const { moved } = active;
      end("end", toDesktopPoint(event.clientX, event.clientY));
      if (!countsTaps(event.pointerType) || moved) {
        lastTap = null;
        return;
      }
      // A double tap (finger or pen) fills, like a double-click: Safari may
      // not send dblclick for either, so taps are counted here instead.
      const now = event.timeStamp;
      if (
        lastTap
        && now - lastTap.time <= DOUBLE_TAP_MS
        && Math.hypot(event.screenX - lastTap.screenX, event.screenY - lastTap.screenY) <= DOUBLE_TAP_SLOP
      ) {
        lastTap = null;
        post({ type: DESKTOP_WINDOW_ZOOM_MESSAGE });
        return;
      }
      lastTap = { time: now, screenX: event.screenX, screenY: event.screenY };
    };

    const handleCancel = () => end("cancel");

    const handleDown = (event: PointerEvent) => {
      lastPointerType = event.pointerType;
      // Control-click is a secondary click on a Mac: it opens a menu, never drags
      if (!event.isPrimary || event.button !== 0 || event.ctrlKey) return;
      const region = findWindowDragRegion(event.target);
      if (!region) return;
      // Not a text selection or a focus change: the press moves the window.
      event.preventDefault();
      end("cancel");
      const point = toDesktopPoint(event.clientX, event.clientY);
      active = {
        pointerId: event.pointerId,
        region,
        screenX: event.screenX,
        screenY: event.screenY,
        moved: false,
        last: point,
      };
      try {
        // Moves keep arriving here while the pointer crosses the desktop or
        // other windows' frames (touch is captured implicitly as well).
        region.setPointerCapture(event.pointerId);
      } catch {
        // The window listeners below still see the moves inside this frame.
      }
      window.addEventListener("pointermove", handleMove, true);
      window.addEventListener("pointerup", handleUp, true);
      window.addEventListener("pointercancel", handleCancel, true);
      // Leaving the frame (switching apps mid-drag) or the page going away cancels.
      window.addEventListener("blur", handleCancel);
      window.addEventListener("pagehide", handleCancel);
      postDrag("start", event.pointerId, point);
    };

    const handleDoubleClick = (event: MouseEvent) => {
      // Touch and pen count their own double tap above; a mouse double-clicks.
      if (countsTaps(lastPointerType)) return;
      if (event.button !== 0 || !findWindowDragRegion(event.target)) return;
      post({ type: DESKTOP_WINDOW_ZOOM_MESSAGE });
    };

    document.addEventListener("pointerdown", handleDown);
    document.addEventListener("dblclick", handleDoubleClick);
    return () => {
      document.removeEventListener("pointerdown", handleDown);
      document.removeEventListener("dblclick", handleDoubleClick);
      end("cancel");
    };
  }, [enabled]);
}

/** The drag bridge as a component, for the window shell (dashboard-shell.tsx). */
export function WindowDragBridge() {
  useWindowDragBridge(true);
  return null;
}
