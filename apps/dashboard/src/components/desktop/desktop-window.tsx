"use client";

import {
  Fragment,
  memo,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  HugeiconsIcon,
  Add01Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
  CloudUploadIcon,
  FolderAddIcon,
  MaximizeScreenIcon,
  MinimizeScreenIcon,
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
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  clampDesktopBounds,
  maximizedDesktopBounds,
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
  pointerX: number;
  pointerY: number;
  bounds: DesktopBounds;
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
  const [isManipulating, setIsManipulating] = useState(false);

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
        onBoundsChange(clampDesktopBounds(
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

    const handlePointerUp = () => {
      dragOrigin.current = null;
      resizeOrigin.current = null;
      setIsManipulating(false);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [area, isManipulating, minimum, onBoundsChange]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (maximized || event.button !== 0) return;
    onFocus();
    dragOrigin.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds,
    };
    setIsManipulating(true);
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (maximized || event.button !== 0) return;
    event.stopPropagation();
    onFocus();
    resizeOrigin.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      bounds,
    };
    setIsManipulating(true);
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
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="z-[1400] min-w-40"
              onPointerDown={(event) => event.stopPropagation()}
            >
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
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };

  return (
    <section
      ref={windowRef}
      data-desktop-window={id}
      aria-label={`${title} window`}
      aria-hidden={disabled || undefined}
      inert={disabled}
      className={cn(
        "absolute flex min-h-0 flex-col overflow-hidden bg-card",
        "transition-[border-color,opacity] duration-150 ease-out",
        maximized
          ? "rounded-none border-0"
          : "rounded-xl border",
        !maximized && (active ? "border-foreground/30" : "border-border opacity-95"),
        disabled && "pointer-events-none",
      )}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        zIndex,
      }}
      onPointerDown={onFocus}
    >
      <div
        className={cn(
          "group/titlebar grid h-11 shrink-0 touch-none select-none grid-cols-[minmax(0,1fr)_auto] items-center border-b border-border/70 px-3",
          active ? "bg-card" : "bg-card/80",
        )}
        onPointerDown={startDrag}
        onDoubleClick={toggleMaximize}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2" aria-label="Window controls">
            <button
              type="button"
              aria-label={`Close ${title}`}
              className={cn(
                "group/control flex size-3.5 items-center justify-center rounded-full transition-colors duration-150",
                active
                  ? "bg-status-critical/70 hover:bg-status-critical"
                  : "bg-muted-foreground/25 hover:bg-status-critical/70",
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onClose}
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                size={8}
                strokeWidth={2}
                className="text-background opacity-0 transition-opacity duration-150 group-hover/control:opacity-100"
              />
            </button>
            <button
              type="button"
              aria-label={`Minimize ${title}`}
              className={cn(
                "group/control flex size-3.5 items-center justify-center rounded-full transition-colors duration-150",
                active
                  ? "bg-status-warning/70 hover:bg-status-warning"
                  : "bg-muted-foreground/25 hover:bg-status-warning/70",
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={onMinimize}
            >
              <HugeiconsIcon
                icon={MinimizeScreenIcon}
                size={8}
                strokeWidth={2}
                className="text-background opacity-0 transition-opacity duration-150 group-hover/control:opacity-100"
              />
            </button>
            <button
              type="button"
              aria-label={maximized ? `Restore ${title}` : `Maximize ${title}`}
              className={cn(
                "group/control flex size-3.5 items-center justify-center rounded-full transition-colors duration-150",
                active
                  ? "bg-status-healthy/70 hover:bg-status-healthy"
                  : "bg-muted-foreground/25 hover:bg-status-healthy/70",
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggleMaximize}
            >
              <HugeiconsIcon
                icon={MaximizeScreenIcon}
                size={8}
                strokeWidth={2}
                className="text-background opacity-0 transition-opacity duration-150 group-hover/control:opacity-100"
              />
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
          {otherTrailingActions.map(renderAction)}
          {renderTerminalControls()}
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
            className="absolute right-0 bottom-0 size-4 cursor-nwse-resize touch-none"
            onPointerDown={startResize}
          >
            <span className="absolute right-1 bottom-1 size-2 border-r border-b border-muted-foreground/50" />
          </button>
        )}
      </div>
    </section>
  );
});
