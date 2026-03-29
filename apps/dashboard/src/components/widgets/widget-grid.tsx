"use client";

import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  DragStartEvent,
  DragEndEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { HugeiconsIcon, Cancel01Icon, Add01Icon } from "@/components/icons";
import { DraggableWrapper } from "@/components/draggable-dashboard";
import { useWidgetLayout } from "@/hooks/use-widget-layout";
import {
  defaultSize,
  isResizable,
  WIDGET_SIZE_PRESETS,
  DECLARATIVE_WIDGETS_ENABLED,
} from "@/hooks/use-widget-layout";
import { useWidgetEdit } from "./widget-edit-context";
import { SystemHealthWidget } from "./system-health-widget";
import { ServicesWidget } from "./services-widget";
import { ActiveDownloadsWidget } from "./active-downloads-widget";
import { ActivityWidget } from "./activity-widget";
import { DigestWidget } from "./digest-widget";
import { MediaCalendarWidget } from "./media-calendar-widget";
import { QuickActionsWidget } from "./quick-actions-widget";
import { ArrStatusWidget } from "./arr-status-widget";
import { OverseerrRequestsWidget } from "./overseerr-requests-widget";
import { StorageMountsWidget } from "./storage-mounts-widget";
import { SystemInfoWidget } from "./system-info-widget";
import { SystemStatusWidget } from "./system-status-widget";
import { NetworkWidget } from "./network-widget";
import { DividerWidget } from "./divider-widget";
import { BackupStatusWidget } from "./backup-status-widget";
import { OllamaStatusWidget } from "./ollama-status-widget";
import { LauncherWidget } from "./launcher-widget";
import { AudiobooksWidget } from "./audiobooks-widget";
import { OptimizationWidget } from "./optimization-widget";
import { CpuWidget } from "./cpu-widget";
import { MemoryWidget } from "./memory-widget";
import { DiskWidget } from "./disk-widget";
import { DeclarativeWidget } from "./declarative-widget";
import { cn } from "@/lib/utils";
import type { BuiltinWidgetType, WidgetType, WidgetSize } from "@/hooks/use-widget-layout";
import { useWidgetManifests } from "@/hooks/use-widget-manifests";
import { Widget } from "./widget";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// ── Stable constants (hoisted out of render) ────────────────────────────────

const POINTER_CONSTRAINT = { distance: 8 } as const;
const TWO_COL_BREAKPOINT = 370;

const WIDGET_LABELS: Record<BuiltinWidgetType, string> = {
  cpu:                  "CPU",
  memory:               "Memory",
  disk:                 "Disk",
  "system-health":      "System Health",
  "services":           "Services",
  "active-downloads":   "Active Downloads",
  "activity":           "Recent Activity",
  "digest":             "Weekly Digest",
  "media-calendar":     "Coming Up",
  "quick-actions":      "Quick Actions",
  "arr-status":         "Media Services",
  "overseerr-requests": "Requests",
  "storage-mounts":     "Storage",
  "system-info":        "System Info",
  "system-status":      "System Status",
  "network":            "Network",
  "divider":            "Divider",
  "backup-status":      "Backups",
  "ollama-status":      "Local AI",
  launcher:             "Launcher",
  audiobooks:           "Continue Listening",
  optimization:         "Media Health",
};

function widgetComponent(
  widgetType: WidgetType,
  manifestById: Map<string, ReturnType<typeof useWidgetManifests>["widgets"][number]>,
  manifestsLoading: boolean,
  size?: WidgetSize,
  compact?: boolean,
): React.ReactNode {
  if (widgetType.startsWith("widget:")) {
    const manifestId = widgetType.slice("widget:".length);
    const manifest = manifestById.get(manifestId);
    if (manifest) return <DeclarativeWidget manifest={manifest} />;
    if (manifestsLoading) return <WidgetLoadingSkeleton compact={compact} />;
    return (
      <Widget>
        <div className="px-4 py-4">
          <p className="text-xs text-muted-foreground">Widget unavailable.</p>
        </div>
      </Widget>
    );
  }

  switch (widgetType as BuiltinWidgetType) {
    case "cpu":                 return <CpuWidget />;
    case "memory":              return <MemoryWidget />;
    case "disk":                return <DiskWidget />;
    case "system-health":       return <SystemHealthWidget />;
    case "services":            return <ServicesWidget />;
    case "active-downloads":    return <ActiveDownloadsWidget />;
    case "activity":            return <ActivityWidget />;
    case "digest":              return <DigestWidget />;
    case "media-calendar":      return <MediaCalendarWidget />;
    case "quick-actions":       return <QuickActionsWidget />;
    case "arr-status":
      return <ArrStatusWidget mode={compact ? "compact" : "full"} />;
    case "overseerr-requests":  return <OverseerrRequestsWidget />;
    case "storage-mounts":      return <StorageMountsWidget />;
    case "system-info":         return <SystemInfoWidget />;
    case "system-status":
      return <SystemStatusWidget mode={compact ? "compact" : "full"} />;
    case "network": {
      const mode =
        size && size.cols === 1 ? "split"
        : "full";
      return <NetworkWidget mode={mode} />;
    }
    case "divider":             return <DividerWidget />;
    case "backup-status":       return <BackupStatusWidget />;
    case "ollama-status":       return <OllamaStatusWidget />;
    case "launcher":            return <LauncherWidget />;
    case "audiobooks":          return <AudiobooksWidget />;
    case "optimization": {
      const mode = compact ? "compact" : size && size.rows >= 2 ? "detail" : "summary";
      return <OptimizationWidget mode={mode} />;
    }
  }
}

function WidgetLoadingSkeleton({ compact }: { compact?: boolean }) {
  return (
    <Widget>
      <div className="px-4 py-3 border-b border-border/60">
        <Skeleton className="h-3 w-24" />
      </div>
      <div className={cn("px-4 py-3 grid gap-2", compact ? "min-h-20" : "min-h-28")}>
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </Widget>
  );
}

function resizeOptions(widgetType: WidgetType): {
  widthOptions: WidgetSize["cols"][];
  heightOptions: WidgetSize["rows"][];
} {
  const presets = widgetType.startsWith("widget:")
    ? [{ cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 3 }, { cols: 4, rows: 2 }]
    : WIDGET_SIZE_PRESETS[widgetType as BuiltinWidgetType];

  const widthOptions = Array.from(new Set(presets.map((p) => p.cols))).sort((a, b) => a - b) as WidgetSize["cols"][];
  const heightOptions = Array.from(new Set(presets.map((p) => p.rows))).sort((a, b) => a - b) as WidgetSize["rows"][];
  return { widthOptions, heightOptions };
}

function supportedSizes(widgetType: WidgetType): WidgetSize[] {
  return widgetType.startsWith("widget:")
    ? [{ cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 3 }, { cols: 4, rows: 2 }]
    : WIDGET_SIZE_PRESETS[widgetType as BuiltinWidgetType];
}

function nextFromOptions<T extends number>(options: T[], current: T): T {
  const idx = options.indexOf(current);
  if (idx === -1) return options[0];
  return options[(idx + 1) % options.length];
}

function bestFitSize(widgetType: WidgetType, current: WidgetSize, bounds: WidgetSize): WidgetSize {
  const options = supportedSizes(widgetType);
  const fitting = options.filter((s) => s.cols <= bounds.cols && s.rows <= bounds.rows);
  if (fitting.length === 0) return current;
  return fitting.sort((a, b) => (b.cols * b.rows) - (a.cols * a.rows) || b.cols - a.cols || b.rows - a.rows)[0];
}

// ── Widget Item ──────────────────────────────────────────────────────────────

const WidgetItem = React.memo(function WidgetItem({
  id,
  widgetType,
  size,
  availableCols,
  manifestById,
  manifestsLoading,
  editMode,
  isNew,
  onRemove,
  onResize,
}: {
  id: string;
  widgetType: WidgetType;
  size: WidgetSize;
  availableCols: number;
  manifestById: Map<string, ReturnType<typeof useWidgetManifests>["widgets"][number]>;
  manifestsLoading: boolean;
  editMode: boolean;
  isNew?: boolean;
  onRemove: () => void;
  onResize: (size: WidgetSize) => void;
}) {
  const resizable = isResizable(widgetType);
  const { widthOptions, heightOptions } = resizeOptions(widgetType);
  const hasWidthOptions = widthOptions.length > 1;
  const hasHeightOptions = heightOptions.length > 1;
  const hasResizeControls = resizable && (hasWidthOptions || hasHeightOptions);
  const compact = size.cols === 1 && size.rows === 1;

  return (
    <DraggableWrapper
      id={id}
      isLocked={!editMode}
      showHandle={editMode}
      gridSize={{ cols: size.cols, rows: size.rows }}
      availableCols={availableCols}
      className={cn("group relative", isNew && "animate-widget-enter")}
    >
      {widgetComponent(widgetType, manifestById, manifestsLoading, size, compact)}

      {editMode && (
        <>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            className="absolute -top-2 -right-2 z-20 flex items-center justify-center size-7 rounded-full bg-background border border-border/80 text-muted-foreground shadow-sm hover:text-destructive hover:border-destructive/40 transition-colors"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={10} />
          </button>

          {hasResizeControls && (
            <div className="absolute -bottom-2.5 right-3 z-20 flex items-center gap-1">
              {hasWidthOptions && (
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onResize({
                      cols: nextFromOptions(widthOptions, size.cols),
                      rows: size.rows,
                    });
                  }}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded-full",
                    "bg-background border border-border/80 shadow-sm",
                    "text-xs font-medium text-muted-foreground",
                    "hover:text-foreground hover:border-border transition-colors",
                    "select-none"
                  )}
                  title="Change widget width"
                >
                  W {size.cols}
                </button>
              )}
              {hasHeightOptions && (
                <button
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onResize({
                      cols: size.cols,
                      rows: nextFromOptions(heightOptions, size.rows),
                    });
                  }}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded-full",
                    "bg-background border border-border/80 shadow-sm",
                    "text-xs font-medium text-muted-foreground",
                    "hover:text-foreground hover:border-border transition-colors",
                    "select-none"
                  )}
                  title="Change widget height"
                >
                  H {size.rows}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </DraggableWrapper>
  );
});

// ── Drag Overlay ─────────────────────────────────────────────────────────────

function DragGhost({
  widgetType,
  manifestById,
  manifestsLoading,
}: {
  widgetType: WidgetType | null;
  manifestById: Map<string, ReturnType<typeof useWidgetManifests>["widgets"][number]>;
  manifestsLoading: boolean;
}) {
  if (!widgetType) return null;
  return (
    <div className="rounded-xl border border-border bg-card shadow-xl ring-1 ring-border/20 opacity-95 pointer-events-none w-full scale-[1.02] origin-top-left">
      {widgetComponent(widgetType, manifestById, manifestsLoading)}
    </div>
  );
}

// ── Widget Picker ─────────────────────────────────────────────────────────────

function WidgetAddDock({
  hiddenWidgetTypes,
  hiddenCustomIds,
  availableManifestIds,
  onAdd,
}: {
  hiddenWidgetTypes: BuiltinWidgetType[];
  hiddenCustomIds: string[];
  availableManifestIds: string[];
  onAdd: (widgetType: WidgetType) => void;
}) {
  const addableIds: BuiltinWidgetType[] = [...hiddenWidgetTypes];
  if (!addableIds.includes("divider")) addableIds.push("divider");
  const addableCustomIds = Array.from(new Set([...hiddenCustomIds, ...availableManifestIds]));
  if (addableIds.length === 0 && addableCustomIds.length === 0) return null;
  const totalAddable = addableIds.length + (DECLARATIVE_WIDGETS_ENABLED ? addableCustomIds.length : 0);

  return (
    <div className="fixed bottom-6 right-6 z-40">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border border-border/70 bg-background/95 px-4 py-2 text-sm text-foreground shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80 transition-colors hover:bg-muted/50"
          >
            <HugeiconsIcon icon={Add01Icon} size={14} />
            Add Widget
            <span className="rounded-full border border-border/70 px-1.5 py-0.5 text-xs text-muted-foreground">
              {totalAddable}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          side="top"
          sideOffset={10}
          className="w-[min(28rem,calc(100vw-2rem))] rounded-xl border border-border/70 bg-background/95 p-3 shadow-xl backdrop-blur supports-[backdrop-filter]:bg-background/80"
        >
          <p className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Add widget
          </p>
          <div className="max-h-60 overflow-y-auto pr-1">
            <div className="flex flex-wrap gap-2">
              {addableIds.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => onAdd(id)}
                  className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/30 hover:text-foreground"
                >
                  <HugeiconsIcon icon={Add01Icon} size={12} />
                  {WIDGET_LABELS[id]}
                </button>
              ))}
              {DECLARATIVE_WIDGETS_ENABLED && addableCustomIds.map((id) => (
                <button
                  key={`widget:${id}`}
                  type="button"
                  onClick={() => onAdd(`widget:${id}`)}
                  className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/30 hover:text-foreground"
                >
                  <HugeiconsIcon icon={Add01Icon} size={12} />
                  {id}
                </button>
              ))}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ── Main Grid ─────────────────────────────────────────────────────────────────

export function WidgetGrid() {
  const { layout, toggleWidget, addWidget, reorderLayout, resizeWidget } = useWidgetLayout();
  const { editMode } = useWidgetEdit();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  const [windowWidth, setWindowWidth] = useState<number>(0);
  const [newWidgetId, setNewWidgetId] = useState<string | null>(null);
  const { widgets: manifests, isLoading: manifestsLoading } = useWidgetManifests();

  const manifestById = useMemo(
    () => new Map(manifests.map((w) => [w.id, w])),
    [manifests],
  );

  // Detect newly added widgets by comparing visible items across renders.
  const prevVisibleRef = useRef<Set<string>>(new Set());
  const initializedRef = useRef(false);
  useEffect(() => {
    const ids = new Set(layout.filter((w) => w.visible).map((w) => w.instanceId));
    if (!initializedRef.current) {
      initializedRef.current = true;
      prevVisibleRef.current = ids;
      return;
    }
    const added = [...ids].filter((id) => !prevVisibleRef.current.has(id));
    prevVisibleRef.current = ids;
    if (added.length === 1) {
      setNewWidgetId(added[0]);
      // Scroll to the new widget after it renders
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-widget-id="${added[0]}"]`);
        el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
      // Clear animation flag after it completes
      const timer = setTimeout(() => setNewWidgetId(null), 400);
      return () => clearTimeout(timer);
    }
  }, [layout]);

  React.useEffect(() => {
    setMounted(true);
    setWindowWidth(window.innerWidth);
    const handler = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  const availableCols = windowWidth >= 1280 ? 4 : windowWidth >= 1024 ? 3 : windowWidth >= TWO_COL_BREAKPOINT ? 2 : 1;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: POINTER_CONSTRAINT }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const visibleItems = layout.filter((w) => w.visible);
  const hiddenWidgetTypes = layout
    .filter((w) => !w.visible && !w.widgetType.startsWith("widget:") && w.widgetType !== "divider" && w.widgetType !== "quick-actions")
    .map((w) => w.widgetType as BuiltinWidgetType);
  const hiddenCustomIds = layout
    .filter((w) => !w.visible && w.widgetType.startsWith("widget:"))
    .map((w) => w.widgetType.slice("widget:".length));
  const availableManifestIds = manifests
    .filter((w) => w.status === "approved" && !layout.some((item) => item.widgetType === `widget:${w.id}`))
    .map((w) => w.id);
  const visibleIds = visibleItems.map((w) => w.instanceId);
  const activeWidgetType = layout.find((w) => w.instanceId === activeId)?.widgetType ?? null;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const fromIdx = layout.findIndex((w) => w.instanceId === active.id);
    const toIdx = layout.findIndex((w) => w.instanceId === over.id);
    if (fromIdx !== -1 && toIdx !== -1) {
      const dragged = layout[fromIdx];
      const target = layout[toIdx];
      reorderLayout(fromIdx, toIdx);
      const draggedSize = dragged.size ?? defaultSize(dragged.widgetType);
      const targetSize = target.size ?? defaultSize(target.widgetType);
      const targetBounds: WidgetSize = {
        cols: Math.min(targetSize.cols, availableCols) as WidgetSize["cols"],
        rows: targetSize.rows,
      };
      const fitted = bestFitSize(dragged.widgetType, draggedSize, targetBounds);
      if (fitted.cols !== draggedSize.cols || fitted.rows !== draggedSize.rows) {
        resizeWidget(dragged.instanceId, fitted);
      }
    }
  }, [layout, reorderLayout, resizeWidget, availableCols]);

  const gridContent = (
    <div className="grid grid-cols-1 min-[370px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 grid-flow-row-dense gap-4 auto-rows-[11rem]">
      {visibleItems.map((w) => {
        const size = w.size ?? defaultSize(w.widgetType);
        return (
          <WidgetItem
            key={w.instanceId}
            id={w.instanceId}
            widgetType={w.widgetType}
            size={size}
            availableCols={availableCols}
            manifestById={manifestById}
            manifestsLoading={manifestsLoading}
            editMode={editMode}
            isNew={w.instanceId === newWidgetId}
            onRemove={() => toggleWidget(w.instanceId)}
            onResize={(s) => resizeWidget(w.instanceId, s)}
          />
        );
      })}
    </div>
  );

  if (!mounted) {
    return (
      <div className="grid grid-cols-1 min-[370px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 grid-flow-row-dense gap-4 auto-rows-[11rem]">
        {Array.from({ length: 6 }).map((_, i) => (
          <Widget key={`widget-skeleton-${i}`}>
            <div className="px-4 py-3 border-b border-border/60">
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="px-4 py-3 grid gap-2">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="h-10 w-full" />
            </div>
          </Widget>
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={visibleIds}>
          {gridContent}
        </SortableContext>

        {mounted && editMode && (
          <DragOverlay dropAnimation={{ duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
            <DragGhost
              widgetType={activeWidgetType}
              manifestById={manifestById}
              manifestsLoading={manifestsLoading}
            />
          </DragOverlay>
        )}
      </DndContext>

      {editMode && (
        <WidgetAddDock
          hiddenWidgetTypes={hiddenWidgetTypes}
          hiddenCustomIds={hiddenCustomIds}
          availableManifestIds={availableManifestIds}
          onAdd={(widgetType) => addWidget(widgetType)}
        />
      )}
    </div>
  );
}
