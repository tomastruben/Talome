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
  Add01Icon,
  ArrowLeft01Icon,
  CloudUploadIcon,
  FolderAddIcon,
  Projector01Icon,
  ArrowDown01Icon,
  Tick01Icon,
  RemoteControlIcon,
  SourceCodeCircleIcon,
} from "@/components/icons";
import type { IconSvgElement } from "@/components/icons";
import type {
  DesktopAppActionDescriptor,
  DesktopAppActionIcon,
} from "@/atoms/desktop-app-actions";
import { Switch } from "@/components/ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
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

interface DesktopWindowProps {
  id: string;
  title: string;
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

const desktopActionIcons: Record<DesktopAppActionIcon, IconSvgElement> = {
  add: Add01Icon,
  back: ArrowLeft01Icon,
  // A remote-control session, not Wi-Fi (CLAUDE.md Icons rule).
  remote: RemoteControlIcon,
  "source-code": SourceCodeCircleIcon,
  projector: Projector01Icon,
  upload: CloudUploadIcon,
  "new-folder": FolderAddIcon,
};

export const DesktopWindow = memo(function DesktopWindow({
  id,
  title,
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
  const [isManipulating, setIsManipulating] = useState(false);
  const [snapZone, setSnapZone] = useState<DesktopSnapZone | null>(null);
  const reduceMotion = useReducedMotion();

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

  /** Ends a drag or resize and releases pointer capture. Pointer-up commits a snap first. */
  const finishPointerGesture = () => {
    const origin = dragOrigin.current ?? resizeOrigin.current;
    const target = captureTarget.current;
    dragOrigin.current = null;
    resizeOrigin.current = null;
    captureTarget.current = null;
    snapZoneRef.current = null;
    setSnapZone(null);
    setIsManipulating(false);

    if (!origin || !target?.hasPointerCapture?.(origin.pointerId)) return;
    try {
      target.releasePointerCapture(origin.pointerId);
    } catch {
      // Safari can implicitly release capture before pointerup is delivered.
    }
  };

  useEffect(() => {
    if (!isManipulating) return;

    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const drag = dragOrigin.current;
      if (drag) {
        const dx = event.clientX - drag.pointerX;
        const dy = event.clientY - drag.pointerY;
        const pointer = { x: event.clientX - drag.areaLeft, y: event.clientY - drag.areaTop };

        if (drag.pendingUnsnap) {
          if (Math.hypot(dx, dy) < DRAG_START_DISTANCE) return;
          const restored = unsnapDesktopBounds(drag.startBounds, drag.pendingUnsnap, pointer, area, minimum);
          onTile?.(restored, undefined);
          dragOrigin.current = { ...drag, pointerX: event.clientX, pointerY: event.clientY, bounds: restored, pendingUnsnap: undefined };
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
          { x: event.clientX - resize.pointerX, y: event.clientY - resize.pointerY },
          area,
          minimum,
        ));
      }
    };

    const handlePointerUp = () => {
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
    // Losing the window (switching apps mid-drag) cancels any pending snap.
    const handleCancel = () => finishPointerGesture();

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
  }, [area, isManipulating, minimum, onBoundsChange, onMaximizeChange, onTile]);

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
    setIsManipulating(true);
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    onFocus();
    // Maximized or snapped windows return to their previous size when dragged away
    const canUnsnap = Boolean(onTile && restoreBounds);
    if (maximized && !canUnsnap) return;
    event.preventDefault();
    const areaRect = (sectionRef.current?.offsetParent as HTMLElement | null)?.getBoundingClientRect();
    dragOrigin.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds,
      startBounds: bounds,
      areaLeft: areaRect?.left ?? 0,
      areaTop: areaRect?.top ?? 0,
      pendingUnsnap: canUnsnap ? restoreBounds : undefined,
    };
    captureGesture(event.currentTarget, event);
  };

  const startResize = (edge: DesktopResizeEdge) => (event: ReactPointerEvent<HTMLElement>) => {
    if (maximized || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();
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

  const leadingActions = actions.filter((action) => action.placement === "leading");
  const trailingActions = actions.filter((action) => action.placement !== "leading");
  const terminalActionIds = new Set(["terminal-auto", "terminal-remote", "terminal-agent"]);
  const terminalActions = trailingActions.filter((action) => terminalActionIds.has(action.id));
  const otherTrailingActions = trailingActions.filter((action) => !terminalActionIds.has(action.id));

  const renderAction = (action: DesktopAppActionDescriptor) => {
    const icon = action.icon ? desktopActionIcons[action.icon] : undefined;
    const isLeading = action.placement === "leading";
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
                action.id === "terminal-session" && "border border-border bg-background shadow-none",
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

    if (action.kind === "toggle") {
      return (
        <div
          key={action.id}
          className={cn(
            "flex h-6 shrink-0 select-none items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground",
            action.disabled && "opacity-40",
          )}
          onPointerDown={stopTitlebarGesture}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <span className="tm-cap-trim">{action.label}</span>
          <Switch
            size="sm"
            checked={action.active === true}
            disabled={action.disabled}
            aria-label={action.label}
            onCheckedChange={() => onAction?.(action.id)}
          />
        </div>
      );
    }

    return (
      <button
        key={action.id}
        type="button"
        className={cn(
          "flex h-6 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
          isLeading ? "size-6 p-0" : "px-2",
          action.active && "bg-muted/60 text-foreground",
        )}
        disabled={action.disabled}
        aria-label={isLeading ? action.label : undefined}
        onPointerDown={stopTitlebarGesture}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={() => onAction?.(action.id)}
      >
        {icon && <HugeiconsIcon icon={icon} size={14} />}
        {!isLeading && <span className="tm-cap-trim">{action.label}</span>}
      </button>
    );
  };

  const renderTerminalControls = () => {
    if (terminalActions.length === 0) return null;

    const autoAction = terminalActions.find((action) => action.id === "terminal-auto");
    const remoteAction = terminalActions.find((action) => action.id === "terminal-remote");
    const agentAction = terminalActions.find((action) => action.id === "terminal-agent");
    const stopTitlebarGesture = (event: ReactPointerEvent<HTMLElement>) => {
      onFocus();
      event.stopPropagation();
    };

    return (
      // Neutral in both states: the title bar sits on the window glass, and
      // window chrome never carries status colours. Auto mode shows as the
      // amber switch fill (non-text, 3:1 on glass) beside a foreground label.
      <div
        className="flex h-6 shrink-0 items-center overflow-hidden rounded-md bg-muted/30 ring-1 ring-border/50"
        role="group"
        aria-label="Terminal controls"
      >
        {autoAction && (
          <label
            className={cn(
              "flex h-6 cursor-pointer items-center gap-1.5 rounded-l-md px-2 text-xs transition-colors duration-150 hover:bg-muted/40",
              autoAction.disabled && "pointer-events-none opacity-40",
            )}
            onPointerDown={stopTitlebarGesture}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <Switch
              size="sm"
              checked={autoAction.active === true}
              disabled={autoAction.disabled}
              aria-label={autoAction.label}
              className="data-[state=checked]:bg-status-warning"
              onCheckedChange={() => onAction?.(autoAction.id)}
            />
            <span className={cn("tm-cap-trim font-medium", autoAction.active ? "text-foreground" : "text-muted-foreground")}>Auto</span>
          </label>
        )}
        {remoteAction && (
          <button
            type="button"
            aria-label={remoteAction.label}
            aria-pressed={remoteAction.active === true}
            disabled={remoteAction.disabled}
            className={cn(
              "relative flex size-6 items-center justify-center transition-colors duration-150 hover:bg-muted/40 disabled:pointer-events-none disabled:opacity-40",
              remoteAction.active ? "text-foreground" : "text-muted-foreground",
            )}
            onPointerDown={stopTitlebarGesture}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={() => onAction?.(remoteAction.id)}
          >
            <HugeiconsIcon icon={RemoteControlIcon} size={13} />
            {remoteAction.label === "Remote session active" && (
              <span className="absolute right-1 top-1 size-1.5 rounded-full bg-status-healthy" />
            )}
          </button>
        )}
        {agentAction && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex h-6 min-w-0 max-w-40 items-center gap-1.5 rounded-r-md px-2.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                disabled={agentAction.disabled}
                aria-label={agentAction.label}
                onPointerDown={stopTitlebarGesture}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <HugeiconsIcon icon={SourceCodeCircleIcon} size={14} />
                <span className="tm-cap-trim truncate">{agentAction.label}</span>
                <HugeiconsIcon icon={ArrowDown01Icon} size={11} className="shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="z-[1400] min-w-40"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <DropdownMenuGroup>
              {agentAction.items?.map((item) => (
                <Fragment key={item.id}>
                  {item.separatorBefore && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    disabled={item.disabled}
                    onSelect={() => onAction?.(item.id)}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.active && <HugeiconsIcon icon={Tick01Icon} size={13} className="ml-auto" />}
                  </DropdownMenuItem>
                </Fragment>
              ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
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
      data-window-manipulating={isManipulating || undefined}
      data-window-minimized={minimized || undefined}
      data-active={active || undefined}
      aria-label={`${title} window`}
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
      <div
        className="group/titlebar tm-window-titlebar grid h-10 shrink-0 touch-none select-none grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b px-2"
        onPointerDown={startDrag}
        onLostPointerCapture={finishPointerGesture}
        onDoubleClick={toggleMaximize}
      >
        <div className="flex min-w-0 items-center gap-2">
          <WindowControls
            className="mr-1"
            title={title}
            active={active}
            layout={layout}
            canRestore={canRestore}
            onLayoutChange={arrange}
            onRestore={restore}
            onMinimize={onMinimize}
            onClose={onClose}
          />
          {leadingActions.length > 0 && (
            <div className="flex min-w-0 items-center gap-0.5" role="group" aria-label={`${title} navigation`}>
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

        <div
          className="flex min-w-0 items-center justify-self-end gap-0.5"
          role="group"
          aria-label={`${title} actions`}
        >
          {renderTerminalControls()}
          {otherTrailingActions.map(renderAction)}
        </div>
      </div>

      <div className="tm-window-body relative flex-1 min-h-0 overflow-hidden">
        <div className={cn("size-full", isManipulating && "pointer-events-none")}>
          {children}
        </div>
      </div>
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
          aria-label={`Resize ${title}`}
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
