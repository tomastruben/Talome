"use client";

import {
  Fragment,
  memo,
  useEffect,
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
  MinusSignIcon,
  MultiplicationSignIcon,
  CloudUploadIcon,
  FolderAddIcon,
  Projector01Icon,
  ArrowDown01Icon,
  Tick01Icon,
  Wifi01Icon,
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
import {
  clampDesktopBounds,
  maximizedDesktopBounds,
  resizeDesktopBounds,
  type DesktopArea,
  type DesktopBounds,
} from "@/lib/desktop-window-state";

interface DesktopWindowProps {
  id: string;
  title: string;
  bounds: DesktopBounds;
  restoreBounds?: DesktopBounds;
  area: DesktopArea;
  minimum: Pick<DesktopBounds, "width" | "height">;
  active: boolean;
  maximized: boolean;
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
  onAction?: (actionId: string) => void;
  windowRef?: (element: HTMLElement | null) => void;
}

interface PointerOrigin {
  pointerId: number;
  pointerX: number;
  pointerY: number;
  bounds: DesktopBounds;
}

const WINDOW_GEOMETRY_SPRING = {
  type: "spring",
  stiffness: 430,
  damping: 42,
  mass: 0.82,
} as const;

type WindowControlGlyphKind = "close" | "minimize" | "maximize";

function WindowControlGlyph({ kind }: { kind: WindowControlGlyphKind }) {
  const icon = kind === "close"
    ? MultiplicationSignIcon
    : kind === "minimize"
      ? MinusSignIcon
      : Add01Icon;

  return (
    <HugeiconsIcon
      icon={icon}
      size={10}
      strokeWidth={3}
      aria-hidden="true"
      data-window-control-glyph={kind}
      className="pointer-events-none absolute left-1/2 top-1/2 shrink-0 -translate-x-1/2 -translate-y-1/2 text-black/70 opacity-0 transition-opacity duration-100"
    />
  );
}

const desktopActionIcons: Record<DesktopAppActionIcon, IconSvgElement> = {
  add: Add01Icon,
  back: ArrowLeft01Icon,
  remote: Wifi01Icon,
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
  onAction,
  windowRef,
}: DesktopWindowProps) {
  const dragOrigin = useRef<PointerOrigin | null>(null);
  const resizeOrigin = useRef<PointerOrigin | null>(null);
  const captureTarget = useRef<HTMLElement | null>(null);
  const [isManipulating, setIsManipulating] = useState(false);
  const reduceMotion = useReducedMotion();

  const finishPointerGesture = () => {
    const origin = dragOrigin.current ?? resizeOrigin.current;
    const target = captureTarget.current;
    dragOrigin.current = null;
    resizeOrigin.current = null;
    captureTarget.current = null;
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
      if (dragOrigin.current) {
        onBoundsChange(clampDesktopBounds(
          {
            ...dragOrigin.current.bounds,
            x: dragOrigin.current.bounds.x + event.clientX - dragOrigin.current.pointerX,
            y: dragOrigin.current.bounds.y + event.clientY - dragOrigin.current.pointerY,
          },
          area,
          minimum,
        ));
      }

      if (resizeOrigin.current) {
        onBoundsChange(resizeDesktopBounds(
          {
            ...resizeOrigin.current.bounds,
            width: resizeOrigin.current.bounds.width + event.clientX - resizeOrigin.current.pointerX,
            height: resizeOrigin.current.bounds.height + event.clientY - resizeOrigin.current.pointerY,
          },
          area,
          minimum,
        ));
      }
    };

    const handlePointerUp = () => finishPointerGesture();
    const handleWindowBlur = () => finishPointerGesture();

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      window.removeEventListener("blur", handleWindowBlur);
    };
  }, [area, isManipulating, minimum, onBoundsChange]);

  const captureGesture = (
    target: HTMLElement,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    captureTarget.current = target;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // The global listeners below remain as a fallback for older WebKit.
    }
    setIsManipulating(true);
  };

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || event.button !== 0) return;
    event.preventDefault();
    onFocus();
    dragOrigin.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds,
    };
    captureGesture(event.currentTarget, event);
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (maximized || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    resizeOrigin.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds,
    };
    captureGesture(event.currentTarget, event);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    onFocus();
    onBoundsChange(resizeDesktopBounds({
      ...bounds,
      width: bounds.width + delta[0],
      height: bounds.height + delta[1],
    }, area, minimum));
  };

  const toggleMaximize = () => {
    if (maximized) {
      onMaximizeChange(false, restoreBounds);
      return;
    }
    onMaximizeChange(true, bounds);
    onBoundsChange(maximizedDesktopBounds(area));
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
                "flex h-7 min-w-0 max-w-44 shrink items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
                action.active && "bg-muted/60 text-foreground",
                action.id === "terminal-session" && "border border-border bg-background shadow-none",
              )}
              disabled={action.disabled}
              aria-label={action.label}
              onPointerDown={stopTitlebarGesture}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {icon && <HugeiconsIcon icon={icon} size={14} />}
              <span className="truncate">{action.label}</span>
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
            "flex h-7 shrink-0 select-none items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground",
            action.disabled && "opacity-40",
          )}
          onPointerDown={stopTitlebarGesture}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          {action.label}
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
          "flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
          isLeading ? "size-7 p-0" : "px-2",
          action.active && "bg-muted/60 text-foreground",
        )}
        disabled={action.disabled}
        aria-label={isLeading ? action.label : undefined}
        onPointerDown={stopTitlebarGesture}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={() => onAction?.(action.id)}
      >
        {icon && <HugeiconsIcon icon={icon} size={14} />}
        {!isLeading && action.label}
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
      <div
        className={cn(
          "flex h-7 shrink-0 items-center overflow-hidden rounded-md transition-colors",
          autoAction?.active
            ? "bg-status-warning/10 ring-1 ring-status-warning/20"
            : "bg-muted/30 ring-1 ring-border/50",
        )}
        aria-label="Terminal controls"
      >
        {autoAction && (
          <button
            type="button"
            role="switch"
            aria-checked={autoAction.active === true}
            aria-label={autoAction.label}
            disabled={autoAction.disabled}
            className="flex h-7 items-center gap-1.5 rounded-l-md px-2 text-xs transition-colors hover:bg-white/5 disabled:pointer-events-none disabled:opacity-40"
            onPointerDown={stopTitlebarGesture}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={() => onAction?.(autoAction.id)}
          >
            <span
              className={cn(
                "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors",
                autoAction.active ? "bg-status-warning" : "bg-input",
              )}
            >
              <span
                className={cn(
                  "inline-block size-2.5 rounded-full bg-white transition-transform",
                  autoAction.active ? "translate-x-3" : "translate-x-0.5",
                )}
              />
            </span>
            <span className={cn("font-medium", autoAction.active ? "text-status-warning" : "text-muted-foreground")}>Auto</span>
          </button>
        )}
        {remoteAction && (
          <button
            type="button"
            aria-label={remoteAction.label}
            aria-pressed={remoteAction.active === true}
            disabled={remoteAction.disabled}
            className={cn(
              "relative flex size-7 items-center justify-center transition-colors hover:bg-white/5 disabled:pointer-events-none disabled:opacity-40",
              remoteAction.active ? "text-foreground" : "text-muted-foreground/50",
            )}
            onPointerDown={stopTitlebarGesture}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={() => onAction?.(remoteAction.id)}
          >
            <HugeiconsIcon icon={Wifi01Icon} size={13} />
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
                className={cn(
                  "flex h-7 min-w-0 max-w-40 items-center gap-1.5 rounded-r-md px-2.5 text-xs transition-colors hover:bg-white/5 disabled:pointer-events-none disabled:opacity-40",
                  autoAction?.active ? "text-status-warning/80 hover:text-status-warning" : "text-muted-foreground hover:text-foreground",
                )}
                disabled={agentAction.disabled}
                aria-label={agentAction.label}
                onPointerDown={stopTitlebarGesture}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <HugeiconsIcon icon={SourceCodeCircleIcon} size={14} />
                <span className="truncate">{agentAction.label}</span>
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
    <motion.section
      ref={windowRef}
      data-desktop-window={id}
      data-window-manipulating={isManipulating || undefined}
      data-window-minimized={minimized || undefined}
      aria-label={`${title} window`}
      aria-hidden={disabled || minimized || undefined}
      inert={disabled || minimized}
      className={cn(
        "absolute flex min-h-0 flex-col overflow-hidden bg-card",
        "transition-[border-color,opacity] duration-150 ease-out",
        maximized
          ? "rounded-none border-0"
          : "rounded-xl border",
        !maximized && (active ? "border-foreground/30" : "border-border opacity-95"),
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
        : WINDOW_GEOMETRY_SPRING}
      style={{
        zIndex,
      }}
      onPointerDown={onFocus}
      onFocusCapture={onFocus}
    >
      <div
        className={cn(
          "group/titlebar grid h-11 shrink-0 touch-none select-none grid-cols-[minmax(0,1fr)_auto] items-center border-b border-border/70 px-3",
          active ? "bg-card" : "bg-card/80",
        )}
        onPointerDown={startDrag}
        onLostPointerCapture={finishPointerGesture}
        onDoubleClick={toggleMaximize}
      >
        <div className="flex min-w-0 items-center gap-2">
          {/* Traffic lights use the --window-* chrome tokens at full colour, never
              the status tokens (spec §2.4, §7): the light status values are
              darkened for text and turn the controls muddy. */}
          <div
            className="-ml-1.5 flex shrink-0 items-center gap-0 [&:focus-within_[data-window-control-glyph]]:opacity-100 [&:hover_[data-window-control-glyph]]:opacity-100"
            aria-label="Window controls"
          >
            <button
              type="button"
              aria-label={`Close ${title}`}
              title={`Close ${title}`}
              className={cn(
                "relative flex size-7 items-center justify-center rounded-full outline-none before:size-3.5 before:rounded-full before:transition-colors before:duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "before:bg-window-close before:ring-1 before:ring-inset before:ring-window-control-edge"
                  : "before:bg-muted-foreground/25 hover:before:bg-window-close hover:before:ring-1 hover:before:ring-inset hover:before:ring-window-control-edge",
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onClose}
            >
              <WindowControlGlyph kind="close" />
            </button>
            <button
              type="button"
              aria-label={`Minimize ${title}`}
              title={`Minimize ${title}`}
              className={cn(
                "relative flex size-7 items-center justify-center rounded-full outline-none before:size-3.5 before:rounded-full before:transition-colors before:duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "before:bg-window-minimize before:ring-1 before:ring-inset before:ring-window-control-edge"
                  : "before:bg-muted-foreground/25 hover:before:bg-window-minimize hover:before:ring-1 hover:before:ring-inset hover:before:ring-window-control-edge",
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onMinimize}
            >
              <WindowControlGlyph kind="minimize" />
            </button>
            <button
              type="button"
              aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}
              title={maximized ? `Restore ${title}` : `Maximize ${title}`}
              className={cn(
                "relative flex size-7 items-center justify-center rounded-full outline-none before:size-3.5 before:rounded-full before:transition-colors before:duration-150 focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "before:bg-window-zoom before:ring-1 before:ring-inset before:ring-window-control-edge"
                  : "before:bg-muted-foreground/25 hover:before:bg-window-zoom hover:before:ring-1 hover:before:ring-inset hover:before:ring-window-control-edge",
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggleMaximize}
            >
              <WindowControlGlyph kind="maximize" />
            </button>
          </div>
          {leadingActions.length > 0 && (
            <div className="flex min-w-0 items-center gap-0.5" aria-label={`${title} navigation`}>
              {leadingActions.map(renderAction)}
            </div>
          )}
          <span
            data-title-placement="leading"
            className="pointer-events-none min-w-0 truncate text-sm font-medium"
          >
            {title}
          </span>
        </div>

        <div
          className="flex min-w-0 items-center justify-self-end gap-0.5"
          aria-label={`${title} actions`}
        >
          {renderTerminalControls()}
          {otherTrailingActions.map(renderAction)}
        </div>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden bg-background">
        <div className={cn("size-full", isManipulating && "pointer-events-none")}>
          {children}
        </div>
        {!maximized && (
          <button
            type="button"
            aria-label={`Resize ${title}`}
            title="Resize with arrow keys; hold Shift for larger steps"
            aria-describedby={`desktop-resize-help-${id}`}
            className="absolute right-0 bottom-0 size-7 cursor-nwse-resize touch-none rounded-tl-md outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            onKeyDown={resizeWithKeyboard}
            onPointerDown={startResize}
            onLostPointerCapture={finishPointerGesture}
          >
            <span id={`desktop-resize-help-${id}`} className="sr-only">Use arrow keys to resize. Hold Shift for larger steps.</span>
            <span className="absolute right-1.5 bottom-1.5 size-2 border-r border-b border-muted-foreground/50" />
          </button>
        )}
      </div>
    </motion.section>
  );
});
