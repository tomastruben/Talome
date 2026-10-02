"use client";

import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  HugeiconsIcon,
  ArrowDown01Icon,
  Tick01Icon,
} from "@/components/icons";
import type { DesktopAppActionDescriptor } from "@/atoms/desktop-app-actions";
import {
  DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE,
  DESKTOP_WINDOW_STATE_MESSAGE,
  isDesktopWindowZoomMessage,
  parseDesktopWindowChromeMessage,
  parseDesktopWindowDragMessage,
  type DesktopWindowDragMessage,
} from "@/atoms/desktop-window-chrome";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { dashboardRouteFromHref } from "@/lib/desktop-navigation";
import { CSS_EASE_ENTER, DURATION, DURATION_MS, EASE_ENTER } from "@/lib/motion";
import {
  clampDesktopBounds,
  desktopSnapZoneAt,
  maximizedDesktopBounds,
  resizeDesktopBounds,
  snappedDesktopBounds,
  unsnapDesktopBounds,
  type DesktopArea,
  type DesktopBounds,
  type DesktopResizeEdge,
  type DesktopSnapZone,
} from "@/lib/desktop-window-state";
import { WindowControls, type DesktopWindowLayout } from "@/components/desktop/window-controls";
import { desktopActionIcons } from "@/components/desktop/desktop-action-icons";

/**
 * Who draws the top of the window:
 *
 * - "unified": the window's frame runs the Talome shell, which draws one
 *   unified toolbar (Back, the title, the app's controls) and the sidebar
 *   (window-toolbar.tsx, source-list.tsx). The window keeps only its glass, its
 *   edges and the window controls, laid over the frame's top-left corner; the
 *   frame forwards presses on its empty toolbar and sidebar space, which drag
 *   the window (atoms/desktop-window-chrome.ts).
 * - "titlebar": the window draws a title bar of its own, the same 52px band
 *   with the controls in the same place, for pages that can't draw one (a
 *   service's own web page, Talome's "service unavailable" state).
 */
export type DesktopWindowChrome = "unified" | "titlebar";

/**
 * A Talome page (any dashboard route, native apps included) draws the unified
 * toolbar; a service's own page, or Talome's "unavailable" state in its
 * place, gets the window's title bar.
 */
export function desktopWindowChrome(url: string, unavailable = false): DesktopWindowChrome {
  return !unavailable && dashboardRouteFromHref(url) !== null ? "unified" : "titlebar";
}

interface DesktopWindowProps {
  id: string;
  /** The window's current place (a folder, a chat, a settings section), shown in its own title bar */
  title: string;
  /**
   * The app's name, for the window's accessible names ("Files window",
   * "Close Files"), which follow the app, not the page. Defaults to `title`.
   * A unified window's frame gets it too, as the title of a page without one.
   */
  appTitle?: string;
  /** Defaults to "titlebar", which works for any page */
  chrome?: DesktopWindowChrome;
  bounds: DesktopBounds;
  restoreBounds?: DesktopBounds;
  area: DesktopArea;
  minimum: Pick<DesktopBounds, "width" | "height">;
  active: boolean;
  maximized: boolean;
  /** Kept mounted (its app keeps running) but hidden from sight, pointer and assistive tech */
  minimized?: boolean;
  disabled?: boolean;
  zIndex: number;
  /** Actions a page publishes, for the window's own title bar (a unified frame draws its own) */
  actions?: DesktopAppActionDescriptor[];
  children: ReactNode;
  onFocus: () => void;
  onClose: () => void;
  onMinimize: () => void;
  onBoundsChange: (bounds: DesktopBounds) => void;
  onMaximizeChange: (maximized: boolean, restoreBounds?: DesktopBounds) => void;
  /** Snap to half of the desktop (or leave a snapped state): new bounds plus the size to restore later */
  onTile?: (bounds: DesktopBounds, restoreBounds?: DesktopBounds) => void;
  onAction?: (actionId: string) => void;
  windowRef?: (element: HTMLElement | null) => void;
  /** Play the opening animation when first shown */
  animateIn?: boolean;
}

interface PointerOrigin {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  bounds: DesktopBounds;
}

interface DragState extends PointerOrigin {
  /** Desktop area's viewport offset, to turn pointer positions into desktop coordinates */
  areaLeft: number;
  areaTop: number;
  /** Bounds before the drag started (restored when snapping) */
  startBounds: DesktopBounds;
  /** A maximized or snapped window gets its previous size back once the drag really starts */
  pendingUnsnap?: DesktopBounds;
}

/**
 * Where a drag or resize comes from: this document's own pointer (an edge,
 * the window's title bar) or the frame, which forwards a press on its unified
 * toolbar or sidebar (the pointer is captured in the frame then, so its moves
 * arrive as messages, not as pointer events here).
 */
type GestureSource = "window" | "frame";

/** Zoom, snap and restore geometry: a 180ms tween on the enter curve (spec §7.4), no spring. */
export const WINDOW_GEOMETRY_TRANSITION = { duration: DURATION.base, ease: EASE_ENTER } as const;

/**
 * Edge and corner hit areas. The bottom-right corner is a real button (it
 * takes keyboard focus and resizes with the arrow keys); the rest are
 * pointer-only strips.
 */
const RESIZE_HANDLES: { edge: Exclude<DesktopResizeEdge, "se">; className: string }[] = [
  { edge: "n", className: "top-0 inset-x-3 h-1.5 cursor-ns-resize" },
  { edge: "s", className: "bottom-0 inset-x-3 h-1.5 cursor-ns-resize" },
  { edge: "e", className: "right-0 inset-y-3 w-1.5 cursor-ew-resize" },
  { edge: "w", className: "left-0 inset-y-3 w-1.5 cursor-ew-resize" },
  { edge: "nw", className: "top-0 left-0 size-3 cursor-nwse-resize" },
  { edge: "ne", className: "top-0 right-0 size-3 cursor-nesw-resize" },
  { edge: "sw", className: "bottom-0 left-0 size-3 cursor-nesw-resize" },
];

/** Pointer travel before a press on the title bar counts as a drag. */
const DRAG_START_DISTANCE = 4;

export const DesktopWindow = memo(function DesktopWindow({
  id,
  title,
  appTitle = title,
  chrome = "titlebar",
  bounds,
  restoreBounds,
  area,
  minimum,
  active,
  maximized,
  minimized = false,
  disabled = false,
  zIndex,
  actions = [],
  children,
  onFocus,
  onClose,
  onMinimize,
  onBoundsChange,
  onMaximizeChange,
  onTile,
  onAction,
  windowRef,
  animateIn = false,
}: DesktopWindowProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const dragOrigin = useRef<DragState | null>(null);
  const resizeOrigin = useRef<(PointerOrigin & { edge: DesktopResizeEdge }) | null>(null);
  const captureTarget = useRef<HTMLElement | null>(null);
  const snapZoneRef = useRef<DesktopSnapZone | null>(null);
  /** The live gesture's source, for message handlers that run between renders */
  const gestureSourceRef = useRef<GestureSource | null>(null);
  const [manipulating, setManipulating] = useState<GestureSource | null>(null);
  const [snapZone, setSnapZone] = useState<DesktopSnapZone | null>(null);
  /** A unified window's frame said it draws the unified toolbar (and forwards drags) */
  const [frameChromeReady, setFrameChromeReady] = useState(false);
  const reduceMotion = useReducedMotion();
  const unified = chrome === "unified";
  const isManipulating = manipulating !== null;

  // Opening: a quick scale-and-fade in, skipped for reduced motion
  useLayoutEffect(() => {
    const element = sectionRef.current;
    if (!animateIn || !element || typeof element.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(
      [
        { opacity: 0, transform: "scale(0.96)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: DURATION_MS.base, easing: CSS_EASE_ENTER },
    );
    // Only on first mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Ends a drag or resize and releases pointer capture. */
  const finishPointerGesture = () => {
    const origin = dragOrigin.current ?? resizeOrigin.current;
    const target = captureTarget.current;
    dragOrigin.current = null;
    resizeOrigin.current = null;
    captureTarget.current = null;
    snapZoneRef.current = null;
    gestureSourceRef.current = null;
    setSnapZone(null);
    setManipulating(null);

    if (!origin || !target?.hasPointerCapture?.(origin.pointerId)) return;
    try {
      target.releasePointerCapture(origin.pointerId);
    } catch {
      // Safari can implicitly release capture before pointerup is delivered.
    }
  };

  /** The pointer moved to (clientX, clientY) in this document: move or resize the window. */
  const moveGesture = (clientX: number, clientY: number) => {
    const drag = dragOrigin.current;
    if (drag) {
      const dx = clientX - drag.pointerX;
      const dy = clientY - drag.pointerY;
      const pointer = { x: clientX - drag.areaLeft, y: clientY - drag.areaTop };

      if (drag.pendingUnsnap) {
        if (Math.hypot(dx, dy) < DRAG_START_DISTANCE) return;
        const restored = unsnapDesktopBounds(drag.startBounds, drag.pendingUnsnap, pointer, area, minimum);
        onTile?.(restored, undefined);
        dragOrigin.current = { ...drag, pointerX: clientX, pointerY: clientY, bounds: restored, pendingUnsnap: undefined };
        return;
      }

      onBoundsChange(clampDesktopBounds(
        { ...drag.bounds, x: drag.bounds.x + dx, y: drag.bounds.y + dy },
        area,
        minimum,
      ));
      const zone = onTile ? desktopSnapZoneAt(pointer, area) : null;
      if (zone !== snapZoneRef.current) {
        snapZoneRef.current = zone;
        setSnapZone(zone);
      }
    }

    const resize = resizeOrigin.current;
    if (resize) {
      onBoundsChange(resizeDesktopBounds(
        resize.bounds,
        resize.edge,
        { x: clientX - resize.pointerX, y: clientY - resize.pointerY },
        area,
        minimum,
      ));
    }
  };

  /** The pointer was released: a drag over a snap zone snaps there, then the gesture ends. */
  const commitGesture = () => {
    const drag = dragOrigin.current;
    const zone = snapZoneRef.current;
    if (drag && zone) {
      if (zone === "maximize") {
        onMaximizeChange(true, drag.startBounds);
        onBoundsChange(maximizedDesktopBounds(area));
      } else {
        onTile?.(snappedDesktopBounds(zone, area), drag.startBounds);
      }
    }
    finishPointerGesture();
  };

  const captureGesture = (
    target: HTMLElement,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    captureTarget.current = target;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // The global listeners remain as a fallback for older WebKit.
    }
    gestureSourceRef.current = "window";
    setManipulating("window");
  };

  /**
   * Starts moving the window from a press at (clientX, clientY). Returns false
   * when the window can't move (it fills the desktop with no size to go back to).
   */
  const beginDrag = (pointerId: number, clientX: number, clientY: number) => {
    onFocus();
    // Maximized or snapped windows return to their previous size when dragged away
    const canUnsnap = Boolean(onTile && restoreBounds);
    if (maximized && !canUnsnap) return false;
    const areaRect = (sectionRef.current?.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    resizeOrigin.current = null;
    dragOrigin.current = {
      pointerId,
      pointerX: clientX,
      pointerY: clientY,
      bounds,
      startBounds: bounds,
      areaLeft: areaRect?.left ?? 0,
      areaTop: areaRect?.top ?? 0,
      pendingUnsnap: canUnsnap ? restoreBounds : undefined,
    };
    return true;
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (!beginDrag(event.pointerId, event.clientX, event.clientY)) return;
    event.preventDefault();
    captureGesture(event.currentTarget, event);
  };

  const startResize = (edge: DesktopResizeEdge) => (event: ReactPointerEvent<HTMLElement>) => {
    if (maximized || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    dragOrigin.current = null;
    resizeOrigin.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds,
      edge,
    };
    captureGesture(event.currentTarget, event);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = ({
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    } as Record<string, { x: number; y: number }>)[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    onBoundsChange(resizeDesktopBounds(bounds, "se", delta, area, minimum));
  };

  const snapPreview = snapZone
    ? snapZone === "maximize"
      ? maximizedDesktopBounds(area)
      : snappedDesktopBounds(snapZone, area)
    : null;

  const toggleMaximize = () => {
    if (maximized) {
      onMaximizeChange(false, restoreBounds);
      return;
    }
    onMaximizeChange(true, bounds);
    onBoundsChange(maximizedDesktopBounds(area));
  };

  // ── The frame's side of the chrome (unified windows) ──────────────────────
  const windowFrame = () => sectionRef.current?.querySelector<HTMLIFrameElement>("iframe") ?? null;
  const postToFrame = (frame: HTMLIFrameElement | null, message: Record<string, unknown>) => {
    frame?.contentWindow?.postMessage(message, window.location.origin);
  };
  const postWindowState = (frame: HTMLIFrameElement | null) => {
    postToFrame(frame, { type: DESKTOP_WINDOW_STATE_MESSAGE, active, title: appTitle });
  };

  /** A drag the frame forwarded: the same move, snap and fill as a press on the window itself. */
  const handleFrameDrag = (message: DesktopWindowDragMessage, frame: HTMLIFrameElement) => {
    let x = message.x;
    let y = message.y;
    if (message.space === "frame") {
      const rect = frame.getBoundingClientRect();
      x += rect.left + frame.clientLeft;
      y += rect.top + frame.clientTop;
    }
    const ours = gestureSourceRef.current === "frame" && dragOrigin.current?.pointerId === message.pointerId;
    switch (message.phase) {
      case "start":
        if (gestureSourceRef.current) finishPointerGesture();
        if (!beginDrag(message.pointerId, x, y)) return;
        gestureSourceRef.current = "frame";
        setManipulating("frame");
        return;
      case "move":
        if (ours) moveGesture(x, y);
        return;
      case "end":
        if (ours) commitGesture();
        return;
      case "cancel":
        if (ours) finishPointerGesture();
        return;
    }
  };

  const handleFrameMessage = (event: MessageEvent) => {
    if (!unified || event.origin !== window.location.origin) return;
    const frame = windowFrame();
    if (!frame || event.source !== frame.contentWindow) return;

    const chromeMessage = parseDesktopWindowChromeMessage(event.data);
    if (chromeMessage) {
      setFrameChromeReady(chromeMessage.unified);
      if (chromeMessage.unified) postWindowState(frame);
      return;
    }
    if (disabled || minimized) return;
    const drag = parseDesktopWindowDragMessage(event.data);
    if (drag) {
      handleFrameDrag(drag, frame);
      return;
    }
    if (isDesktopWindowZoomMessage(event.data)) {
      onFocus();
      toggleMaximize();
    }
  };

  /** A new page in the frame: it says again whether it draws the unified toolbar. */
  const handleFrameLoad = (event: Event) => {
    if (!unified || !(event.target instanceof HTMLIFrameElement)) return;
    if (event.target !== windowFrame()) return;
    setFrameChromeReady(false);
    if (gestureSourceRef.current === "frame") finishPointerGesture();
    postToFrame(event.target, { type: DESKTOP_WINDOW_CHROME_REQUEST_MESSAGE });
  };

  // Window and frame listeners live for the window's lifetime and call the
  // latest handlers (props change with every move). Not useEffectEvent: React
  // 19.2 never refreshes an effect event inside a memo component like this one.
  const handlersRef = useRef({ moveGesture, commitGesture, finishPointerGesture, handleFrameMessage, handleFrameLoad });
  useLayoutEffect(() => {
    handlersRef.current = { moveGesture, commitGesture, finishPointerGesture, handleFrameMessage, handleFrameLoad };
  });

  useEffect(() => {
    const section = sectionRef.current;
    const handleMessage = (event: MessageEvent) => handlersRef.current.handleFrameMessage(event);
    const handleLoad = (event: Event) => handlersRef.current.handleFrameLoad(event);
    window.addEventListener("message", handleMessage);
    // load doesn't bubble; a capturing listener still sees the frame's
    section?.addEventListener("load", handleLoad, true);
    return () => {
      window.removeEventListener("message", handleMessage);
      section?.removeEventListener("load", handleLoad, true);
    };
  }, []);

  useEffect(() => {
    // Through the ref: listeners see the latest props without resubscribing
    const handle = () => handlersRef.current;
    if (manipulating === "window") {
      const handlePointerMove = (event: globalThis.PointerEvent) => handle().moveGesture(event.clientX, event.clientY);
      const handlePointerUp = () => handle().commitGesture();
      // Losing the window (switching apps mid-drag) cancels any pending snap.
      const handleCancel = () => handle().finishPointerGesture();
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handleCancel);
      window.addEventListener("blur", handleCancel);
      return () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handleCancel);
        window.removeEventListener("blur", handleCancel);
      };
    }
    if (manipulating === "frame") {
      // The frame holds the pointer and reports the drag's end. Should that
      // report never come (the frame lost the pointer), a release or a new
      // press in this document ends the drag rather than leave it stuck.
      const handlePointerUp = () => handle().commitGesture();
      const handlePointerDown = () => handle().finishPointerGesture();
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointerdown", handlePointerDown, true);
      return () => {
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointerdown", handlePointerDown, true);
      };
    }
  }, [manipulating]);

  // The frame's title reads quieter when the window isn't the one you're in
  useEffect(() => {
    if (!unified || !frameChromeReady) return;
    postToFrame(windowFrame(), { type: DESKTOP_WINDOW_STATE_MESSAGE, active, title: appTitle });
  }, [active, appTitle, frameChromeReady, unified]);

  const sameBounds = (a: DesktopBounds, b: DesktopBounds) =>
    Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1
    && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
  const layout: DesktopWindowLayout = maximized
    ? "fill"
    : onTile && sameBounds(bounds, snappedDesktopBounds("left", area))
      ? "left"
      : onTile && sameBounds(bounds, snappedDesktopBounds("right", area))
        ? "right"
        : "free";
  const canRestore = layout !== "free" && Boolean(restoreBounds);
  // The size to come back to: the current one, unless the window is already arranged
  const sizeToRemember = layout === "free" ? bounds : restoreBounds ?? bounds;

  const arrange = (next: Exclude<DesktopWindowLayout, "free">) => {
    onFocus();
    if (next === layout) return;
    if (next === "fill") {
      onMaximizeChange(true, sizeToRemember);
      onBoundsChange(maximizedDesktopBounds(area));
      return;
    }
    onTile?.(snappedDesktopBounds(next, area), sizeToRemember);
  };

  const restore = () => {
    onFocus();
    if (maximized) {
      onMaximizeChange(false, restoreBounds);
      return;
    }
    if (restoreBounds) onTile?.(clampDesktopBounds(restoreBounds, area, minimum), undefined);
  };

  const controls = (
    <WindowControls
      title={appTitle}
      active={active}
      layout={layout}
      canRestore={canRestore}
      onLayoutChange={arrange}
      onRestore={restore}
      onMinimize={onMinimize}
      onClose={onClose}
      className={unified
        // Laid over the frame's top-left corner, 12px in, centred in the
        // 52px toolbar band; the gaps between the buttons let presses through
        // to the toolbar beneath, which drags the window.
        ? "pointer-events-none absolute top-0 left-3 z-30 h-13 *:pointer-events-auto"
        : "mr-1"}
    />
  );

  // A window's own title bar holds the window controls, a leading Back and the
  // title. Talome's own apps keep every verb in their unified toolbar; the
  // trailing group stays for pages that still publish one, so no published
  // action is ever dropped.
  const leadingActions = actions.filter((action) => action.placement === "leading");
  const trailingActions = actions.filter((action) => action.placement !== "leading");

  const renderAction = (action: DesktopAppActionDescriptor) => {
    const icon = action.icon ? desktopActionIcons[action.icon] : undefined;
    const isLeading = action.placement === "leading";
    // A leading action (Back) is an icon; anything without an icon keeps its label.
    const iconOnly = isLeading && Boolean(icon);
    const stopTitlebarGesture = (event: ReactPointerEvent<HTMLElement>) => {
      onFocus();
      event.stopPropagation();
    };

    if (action.kind === "menu") {
      return (
        <DropdownMenu key={action.id}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex h-6 min-w-0 max-w-44 shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
                action.active && "bg-muted/60 text-foreground",
              )}
              disabled={action.disabled}
              aria-label={action.label}
              onPointerDown={stopTitlebarGesture}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {icon && <HugeiconsIcon icon={icon} size={14} />}
              <span className="tm-cap-trim truncate">{action.label}</span>
              <HugeiconsIcon icon={ArrowDown01Icon} size={11} className="shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align={isLeading ? "start" : "end"}
            className="z-[1400] min-w-52"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DropdownMenuGroup>
            {action.items?.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  disabled={item.disabled}
                  onSelect={() => onAction?.(item.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.active && (
                    <HugeiconsIcon icon={Tick01Icon} size={13} className="ml-auto" />
                  )}
                </DropdownMenuItem>
              </Fragment>
            ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }

    // Buttons, and toggles as pressed buttons (no Talome app publishes a
    // title-bar switch any more; the Terminal's Auto lives in its toolbar).
    return (
      <button
        key={action.id}
        type="button"
        className={cn(
          "flex h-6 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
          iconOnly ? "size-6 shrink-0 p-0" : "min-w-0 max-w-44 shrink px-2",
          action.active && "bg-muted/60 text-foreground",
        )}
        disabled={action.disabled}
        aria-label={iconOnly ? action.label : undefined}
        aria-pressed={action.kind === "toggle" ? action.active === true : undefined}
        title={iconOnly ? undefined : action.label}
        onPointerDown={stopTitlebarGesture}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={() => onAction?.(action.id)}
      >
        {icon && <HugeiconsIcon icon={icon} size={14} className="shrink-0" />}
        {!iconOnly && <span className="tm-cap-trim truncate">{action.label}</span>}
      </button>
    );
  };

  return (
    <>
    {snapPreview && (
      // Shares the window's z-index (inside the window band, below the Dock)
      <div
        aria-hidden
        data-window-snap-preview=""
        className="pointer-events-none absolute rounded-xl border border-foreground/20 bg-foreground/[0.08] backdrop-blur-sm transition-[left,top,width,height] duration-150 ease-out motion-reduce:transition-none solid-materials:bg-muted solid-materials:backdrop-blur-none"
        style={{
          left: snapPreview.x + 6,
          top: snapPreview.y + 6,
          width: snapPreview.width - 12,
          height: snapPreview.height - 12,
          zIndex,
        }}
      />
    )}
    <motion.section
      ref={(element: HTMLElement | null) => {
        sectionRef.current = element;
        windowRef?.(element);
      }}
      data-desktop-window={id}
      data-window-chrome={chrome}
      data-window-manipulating={isManipulating || undefined}
      data-window-minimized={minimized || undefined}
      data-active={active || undefined}
      // Named after the app, not the page: "Files window", not "Photos window"
      aria-label={`${appTitle} window`}
      aria-hidden={disabled || minimized || undefined}
      inert={disabled || minimized}
      tabIndex={-1}
      className={cn(
        // Focus is shown by edge, shadow and title colour (tm-window[data-active]), never by dimming content.
        "tm-window absolute flex min-h-0 flex-col overflow-hidden outline-none",
        "transition-[border-color,box-shadow] duration-150 ease-out",
        maximized ? "rounded-t-none rounded-b-xl border-x-0 border-t-0 border-b" : "rounded-xl border",
        disabled && "pointer-events-none",
        minimized && "invisible pointer-events-none opacity-0",
      )}
      initial={false}
      animate={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      }}
      transition={isManipulating || reduceMotion
        ? { duration: 0 }
        : WINDOW_GEOMETRY_TRANSITION}
      style={{ zIndex }}
      onPointerDown={onFocus}
      onFocusCapture={onFocus}
    >
      {unified ? controls : (
        <div
          className="group/titlebar tm-window-titlebar grid h-13 shrink-0 touch-none select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b pr-3 pl-3"
          onPointerDown={startDrag}
          onLostPointerCapture={finishPointerGesture}
          onDoubleClick={toggleMaximize}
        >
          <div className="flex min-w-0 items-center gap-2">
            {controls}
            {leadingActions.length > 0 && (
              <div
                data-window-actions="leading"
                className="flex min-w-0 items-center gap-0.5"
                role="group"
                aria-label={`${appTitle} navigation`}
              >
                {leadingActions.map(renderAction)}
              </div>
            )}
            <span
              data-title-placement="leading"
              className={cn(
                "tm-cap-trim pointer-events-none min-w-0 truncate text-sm font-medium leading-5 transition-colors duration-150",
                !active && "text-muted-foreground",
              )}
            >
              {title}
            </span>
          </div>

          {trailingActions.length > 0 && (
            <div
              data-window-actions="trailing"
              className="flex min-w-0 items-center justify-self-end gap-0.5"
              role="group"
              aria-label={`${appTitle} actions`}
            >
              {trailingActions.map(renderAction)}
            </div>
          )}
        </div>
      )}

      <div className="tm-window-body relative flex-1 min-h-0 overflow-hidden">
        {/* A press on the window's own edges takes the pointer from the
            frames; a drag the frame forwards keeps it there */}
        <div className={cn("size-full", manipulating === "window" && "pointer-events-none")}>
          {children}
        </div>
      </div>
      {unified && !frameChromeReady && (
        // Until the page in the frame draws its toolbar (it is loading, or it
        // is a page without the shell), the top band still drags the window.
        <div
          aria-hidden
          data-window-drag-fallback=""
          className="absolute inset-x-0 top-0 z-10 h-13 touch-none select-none"
          onPointerDown={startDrag}
          onLostPointerCapture={finishPointerGesture}
          onDoubleClick={toggleMaximize}
        />
      )}
      {!maximized && RESIZE_HANDLES.map(({ edge, className }) => (
        <div
          key={edge}
          aria-hidden
          data-resize-edge={edge}
          className={cn("absolute z-20 touch-none", className)}
          onPointerDown={startResize(edge)}
          onLostPointerCapture={finishPointerGesture}
        />
      ))}
      {!maximized && (
        <button
          type="button"
          data-resize-edge="se"
          aria-label={`Resize ${appTitle}`}
          title="Resize with arrow keys; hold Shift for larger steps"
          aria-describedby={`desktop-resize-help-${id}`}
          className="absolute right-0 bottom-0 z-20 size-3 cursor-nwse-resize touch-none rounded-tl-md outline-none focus-visible:size-5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onKeyDown={resizeWithKeyboard}
          onPointerDown={startResize("se")}
          onLostPointerCapture={finishPointerGesture}
        >
          <span id={`desktop-resize-help-${id}`} className="sr-only">Use arrow keys to resize. Hold Shift for larger steps.</span>
        </button>
      )}
    </motion.section>
    </>
  );
});
