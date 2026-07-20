"use client";

import { useCallback, useState } from "react";
import {
  defaultSize,
  type WidgetInstance,
  type WidgetSize,
  type WidgetType,
} from "@/hooks/use-widget-layout";

const DESKTOP_WIDGET_LAYOUT_STORAGE_KEY = "talome-desktop-widget-layout-v1";

const DEFAULT_DESKTOP_WIDGET_LAYOUT: WidgetInstance[] = [
  { instanceId: "desktop-cpu", widgetType: "cpu", visible: true, size: { cols: 1, rows: 1 } },
  { instanceId: "desktop-memory", widgetType: "memory", visible: true, size: { cols: 1, rows: 1 } },
  { instanceId: "desktop-disk", widgetType: "disk", visible: true, size: { cols: 1, rows: 1 } },
  { instanceId: "desktop-network", widgetType: "network", visible: false, size: { cols: 1, rows: 1 } },
  { instanceId: "desktop-downloads", widgetType: "active-downloads", visible: false, size: { cols: 2, rows: 2 } },
  { instanceId: "desktop-audiobooks", widgetType: "audiobooks", visible: false, size: { cols: 2, rows: 1 } },
  { instanceId: "desktop-divider", widgetType: "divider", visible: false, size: { cols: 2, rows: 1 } },
];

const DESKTOP_BUILTIN_WIDGET_TYPES = new Set(
  DEFAULT_DESKTOP_WIDGET_LAYOUT.map((widget) => widget.widgetType),
);

function makeDesktopWidgetInstanceId(widgetType: WidgetType): string {
  return `desktop-${widgetType}:${Math.random().toString(36).slice(2, 10)}`;
}

function clampDesktopWidgetSize(widgetType: WidgetType, size?: WidgetSize): WidgetSize {
  const fallback = defaultSize(widgetType);
  const cols = typeof size?.cols === "number" ? size.cols : fallback.cols;
  const rows = typeof size?.rows === "number" ? size.rows : fallback.rows;
  return {
    cols: (cols <= 1 ? 1 : 2),
    rows: (rows <= 1 ? 1 : 2),
  };
}

function normalizeDesktopWidget(widget: WidgetInstance): WidgetInstance {
  return {
    ...widget,
    size: clampDesktopWidgetSize(widget.widgetType, widget.size),
  };
}

function normalizeDesktopLayout(saved: WidgetInstance[]): WidgetInstance[] {
  const supported = saved
    .filter((widget) => (
      widget.widgetType.startsWith("widget:") || DESKTOP_BUILTIN_WIDGET_TYPES.has(widget.widgetType)
    ))
    .map(normalizeDesktopWidget);
  const presentTypes = new Set(supported.map((widget) => widget.widgetType));
  const missingDefaults = DEFAULT_DESKTOP_WIDGET_LAYOUT.filter(
    (widget) => !presentTypes.has(widget.widgetType),
  ).map(normalizeDesktopWidget);
  return [...supported, ...missingDefaults];
}

function loadDesktopLayout(): WidgetInstance[] {
  if (typeof window === "undefined") return normalizeDesktopLayout(DEFAULT_DESKTOP_WIDGET_LAYOUT);
  try {
    const raw = localStorage.getItem(DESKTOP_WIDGET_LAYOUT_STORAGE_KEY);
    if (!raw) return normalizeDesktopLayout(DEFAULT_DESKTOP_WIDGET_LAYOUT);
    const saved = JSON.parse(raw) as WidgetInstance[];
    return Array.isArray(saved)
      ? normalizeDesktopLayout(saved)
      : normalizeDesktopLayout(DEFAULT_DESKTOP_WIDGET_LAYOUT);
  } catch {
    return normalizeDesktopLayout(DEFAULT_DESKTOP_WIDGET_LAYOUT);
  }
}

function saveDesktopLayout(layout: WidgetInstance[]) {
  try {
    localStorage.setItem(DESKTOP_WIDGET_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Desktop customization should keep working when browser storage is unavailable.
  }
}

export function useDesktopWidgetLayout() {
  const [layout, setLayout] = useState<WidgetInstance[]>(loadDesktopLayout);

  const updateLayout = useCallback((update: (current: WidgetInstance[]) => WidgetInstance[]) => {
    setLayout((current) => {
      const next = update(current);
      saveDesktopLayout(next);
      return next;
    });
  }, []);

  const toggleWidget = useCallback((instanceId: string) => {
    updateLayout((current) => current.map((widget) => (
      widget.instanceId === instanceId
        ? { ...widget, visible: !widget.visible }
        : widget
    )));
  }, [updateLayout]);

  const addWidget = useCallback((widgetType: WidgetType) => {
    updateLayout((current) => {
      const hidden = current.find((widget) => (
        widget.widgetType === widgetType && !widget.visible
      ));
      if (hidden) {
        return current.map((widget) => (
          widget.instanceId === hidden.instanceId
            ? { ...widget, visible: true }
            : widget
        ));
      }
      return [
        ...current,
        {
          instanceId: makeDesktopWidgetInstanceId(widgetType),
          widgetType,
          visible: true,
          size: clampDesktopWidgetSize(widgetType),
        },
      ];
    });
  }, [updateLayout]);

  const reorderLayout = useCallback((fromIndex: number, toIndex: number) => {
    updateLayout((current) => {
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, [updateLayout]);

  const resizeWidget = useCallback((instanceId: string, size: WidgetSize) => {
    updateLayout((current) => current.map((widget) => (
      widget.instanceId === instanceId
        ? { ...widget, size: clampDesktopWidgetSize(widget.widgetType, size) }
        : widget
    )));
  }, [updateLayout]);

  const resetLayout = useCallback((): WidgetInstance[] => {
    const previous = layout;
    const next = DEFAULT_DESKTOP_WIDGET_LAYOUT.map(normalizeDesktopWidget);
    setLayout(next);
    saveDesktopLayout(next);
    return previous;
  }, [layout]);

  const restoreLayout = useCallback((snapshot: WidgetInstance[]) => {
    const next = normalizeDesktopLayout(snapshot);
    setLayout(next);
    saveDesktopLayout(next);
  }, []);

  return {
    layout,
    toggleWidget,
    addWidget,
    reorderLayout,
    resizeWidget,
    resetLayout,
    restoreLayout,
  };
}
