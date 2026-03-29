"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { CORE_URL } from "@/lib/constants";

export type BuiltinWidgetType =
  | "cpu"
  | "memory"
  | "disk"
  | "services"
  | "active-downloads"
  | "activity"
  | "digest"
  | "media-calendar"
  | "quick-actions"
  | "arr-status"
  | "overseerr-requests"
  | "storage-mounts"
  | "system-info"
  | "system-status"
  | "network"
  | "system-health" // legacy widget type kept for migration safety
  | "divider"
  | "backup-status"
  | "ollama-status"
  | "launcher"
  | "audiobooks"
  | "optimization";

export type WidgetType = BuiltinWidgetType | `widget:${string}`;

export interface WidgetSize {
  cols: 1 | 2 | 3 | 4;
  rows: 1 | 2 | 3;
}

export interface WidgetInstance {
  instanceId: string;
  widgetType: WidgetType;
  visible: boolean;
  size?: WidgetSize;
}

interface LegacyWidgetConfig {
  id: string;
  visible: boolean;
  size?: { cols: number; rows: number };
}

export const DASHBOARD_BENTO_ENABLED =
  process.env.NEXT_PUBLIC_DASHBOARD_BENTO !== "0";

export const DECLARATIVE_WIDGETS_ENABLED =
  process.env.NEXT_PUBLIC_DECLARATIVE_WIDGETS !== "0";

export const WIDGET_SIZE_PRESETS: Record<BuiltinWidgetType, WidgetSize[]> = {
  cpu:                 [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }],
  memory:              [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }],
  disk:                [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }],
  network:             [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }],
  digest:              [{ cols: 2, rows: 1 }, { cols: 4, rows: 1 }],
  services:            [{ cols: 2, rows: 3 }, { cols: 4, rows: 2 }],
  activity:            [{ cols: 2, rows: 2 }, { cols: 4, rows: 2 }],
  "active-downloads":  [{ cols: 2, rows: 2 }, { cols: 2, rows: 3 }, { cols: 4, rows: 1 }],
  "overseerr-requests":[{ cols: 2, rows: 1 }, { cols: 2, rows: 2 }],
  "storage-mounts":    [{ cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 3 }, { cols: 4, rows: 2 }],
  "quick-actions":     [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }],
  "arr-status":        [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 2 }],
  "media-calendar":    [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 2 }],
  "system-status":     [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 1, rows: 2 }, { cols: 2, rows: 2 }],
  "system-info":       [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 2 }],
  "system-health":     [{ cols: 4, rows: 1 }],
  divider:             [{ cols: 4, rows: 1 }],
  "backup-status":     [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }],
  "ollama-status":     [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }],
  launcher:            [{ cols: 2, rows: 2 }, { cols: 2, rows: 1 }, { cols: 4, rows: 2 }],
  audiobooks:          [{ cols: 2, rows: 1 }, { cols: 2, rows: 2 }],
  optimization:        [{ cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 2 }],
};

function makeInstanceId(widgetType: WidgetType): string {
  return `${widgetType}:${Math.random().toString(36).slice(2, 10)}`;
}

function isBuiltInWidgetType(widgetType: WidgetType): widgetType is BuiltinWidgetType {
  return Object.prototype.hasOwnProperty.call(WIDGET_SIZE_PRESETS, widgetType);
}

export function defaultSize(widgetType: WidgetType): WidgetSize {
  if (isBuiltInWidgetType(widgetType)) return WIDGET_SIZE_PRESETS[widgetType][0];
  return { cols: 2, rows: 1 };
}

export function isResizable(widgetType: WidgetType): boolean {
  if (!isBuiltInWidgetType(widgetType)) return true;
  return WIDGET_SIZE_PRESETS[widgetType].length > 1;
}

export function nextSize(widgetType: WidgetType, current: WidgetSize): WidgetSize {
  if (!isBuiltInWidgetType(widgetType)) {
    const presets: WidgetSize[] = [{ cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 3 }, { cols: 4, rows: 2 }];
    const idx = presets.findIndex((p) => p.cols === current.cols && p.rows === current.rows);
    return presets[(idx + 1) % presets.length];
  }
  const presets = WIDGET_SIZE_PRESETS[widgetType];
  const idx = presets.findIndex((p) => p.cols === current.cols && p.rows === current.rows);
  return presets[(idx + 1) % presets.length];
}

const STORAGE_KEY = "talome-widget-layout-v9";
const PREVIOUS_STORAGE_KEYS = ["talome-widget-layout-v8", "talome-widget-layout-v7", "talome-widget-layout-v6", "talome-widget-layout-v5"];

// v8 default before the new Apple-style board composition.
const LEGACY_V8_DEFAULT_LAYOUT: WidgetInstance[] = [
  { instanceId: "cpu-default",              widgetType: "cpu",                visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "memory-default",           widgetType: "memory",             visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "disk-default",             widgetType: "disk",               visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "network-default",          widgetType: "network",            visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "services-default",         widgetType: "services",           visible: true,  size: { cols: 2, rows: 3 } },
  { instanceId: "activity-default",         widgetType: "activity",           visible: true,  size: { cols: 2, rows: 2 } },
  { instanceId: "digest-default",           widgetType: "digest",             visible: true,  size: { cols: 2, rows: 1 } },
  { instanceId: "quick-actions-default",    widgetType: "quick-actions",      visible: false, size: { cols: 1, rows: 1 } },
  { instanceId: "system-status-default",    widgetType: "system-status",      visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "active-downloads-default", widgetType: "active-downloads",   visible: true,  size: { cols: 4, rows: 1 } },
  { instanceId: "storage-mounts-default",   widgetType: "storage-mounts",     visible: true,  size: { cols: 2, rows: 1 } },
  { instanceId: "media-calendar-default",   widgetType: "media-calendar",     visible: true,  size: { cols: 2, rows: 1 } },
  { instanceId: "arr-status-default",       widgetType: "arr-status",         visible: false },
  { instanceId: "overseerr-default",        widgetType: "overseerr-requests", visible: false },
  { instanceId: "system-info-default",      widgetType: "system-info",        visible: false },
];

export const DEFAULT_LAYOUT: WidgetInstance[] = [
  { instanceId: "cpu-default",              widgetType: "cpu",                visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "memory-default",           widgetType: "memory",             visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "disk-default",             widgetType: "disk",               visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "network-default",          widgetType: "network",            visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "services-default",         widgetType: "services",           visible: true,  size: { cols: 2, rows: 3 } },
  { instanceId: "system-status-default",    widgetType: "system-status",      visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "media-calendar-default",   widgetType: "media-calendar",     visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "activity-default",         widgetType: "activity",           visible: true,  size: { cols: 2, rows: 2 } },
  { instanceId: "active-downloads-default", widgetType: "active-downloads",   visible: true,  size: { cols: 2, rows: 2 } },
  { instanceId: "storage-mounts-default",   widgetType: "storage-mounts",     visible: true,  size: { cols: 2, rows: 1 } },
  { instanceId: "arr-status-default",       widgetType: "arr-status",         visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "system-info-default",      widgetType: "system-info",        visible: true,  size: { cols: 1, rows: 1 } },
  { instanceId: "digest-default",           widgetType: "digest",             visible: false, size: { cols: 2, rows: 1 } },
  { instanceId: "quick-actions-default",    widgetType: "quick-actions",      visible: false, size: { cols: 1, rows: 1 } },
  { instanceId: "overseerr-default",        widgetType: "overseerr-requests", visible: false, size: { cols: 2, rows: 1 } },
  { instanceId: "launcher-default",        widgetType: "launcher",           visible: false, size: { cols: 2, rows: 2 } },
  { instanceId: "optimization-default",   widgetType: "optimization",       visible: false, size: { cols: 2, rows: 1 } },
];

function normalizeSize(input: unknown, fallback: WidgetSize): WidgetSize {
  if (!input || typeof input !== "object") return fallback;
  const size = input as { cols?: number; rows?: number };
  const cols = size.cols;
  const rows = size.rows;
  if ((cols !== 1 && cols !== 2 && cols !== 3 && cols !== 4) || (rows !== 1 && rows !== 2 && rows !== 3)) {
    return fallback;
  }
  return { cols, rows };
}

export function migrateLegacyLayout(saved: LegacyWidgetConfig[]): WidgetInstance[] {
  const expanded: LegacyWidgetConfig[] = [];
  for (const item of saved) {
    if (item.id === "system-health" && DASHBOARD_BENTO_ENABLED) {
      expanded.push(
        { id: "cpu", visible: item.visible },
        { id: "memory", visible: item.visible },
        { id: "disk", visible: item.visible },
        { id: "network", visible: item.visible, size: { cols: 1, rows: 1 } },
      );
      continue;
    }
    // Migrate old network-rate to network
    if (item.id === "network-rate") {
      expanded.push({ id: "network", visible: item.visible, size: item.size ?? { cols: 1, rows: 1 } });
      continue;
    }
    expanded.push(item);
  }

  return expanded.map((item, index) => {
    const widgetType = item.id as WidgetType;
    const fallback = defaultSize(widgetType);
    return {
      instanceId: `${item.id}-${index}`,
      widgetType,
      visible: !!item.visible,
      size: normalizeSize(item.size, fallback),
    };
  });
}

export function mergeWithDefaults(saved: WidgetInstance[]): WidgetInstance[] {
  const next = [...saved];
  const builtIns = new Set(saved.map((w) => w.widgetType).filter((t) => !t.startsWith("widget:")));
  for (const def of DEFAULT_LAYOUT) {
    if (!builtIns.has(def.widgetType)) next.push(def);
  }
  return next;
}

function migrateV4Instances(saved: WidgetInstance[]): WidgetInstance[] {
  return saved.map((w) => {
    if ((w.widgetType as string) === "network-rate") {
      return { ...w, widgetType: "network" as WidgetType, size: w.size ?? { cols: 1, rows: 1 } };
    }
    return w;
  });
}

function migrateHeightTiers(saved: WidgetInstance[]): WidgetInstance[] {
  return saved.map((item) => {
    if (item.widgetType === "cpu" || item.widgetType === "memory" || item.widgetType === "disk" || item.widgetType === "network") {
      const cols = item.size?.cols ?? defaultSize(item.widgetType).cols;
      return { ...item, size: { cols, rows: 1 } };
    }
    if (item.widgetType === "activity") {
      const cols = item.size?.cols ?? defaultSize(item.widgetType).cols;
      return { ...item, size: { cols, rows: 2 } };
    }
    if (item.widgetType === "services") {
      const cols = item.size?.cols ?? defaultSize(item.widgetType).cols;
      return { ...item, size: { cols, rows: cols === 4 ? 2 : 3 } };
    }
    return item;
  });
}

function removeQuickActions(saved: WidgetInstance[]): WidgetInstance[] {
  return saved.map((item) =>
    item.widgetType === "quick-actions"
      ? { ...item, visible: false }
      : item
  );
}

function normalizeNetworkHeight(saved: WidgetInstance[]): WidgetInstance[] {
  return saved.map((item) => {
    if (item.widgetType !== "network") return item;
    const cols = item.size?.cols === 2 ? 2 : 1;
    return { ...item, size: { cols, rows: 1 } };
  });
}

function canonicalLayout(layout: WidgetInstance[]): string {
  return JSON.stringify(layout.map((item) => ({
    instanceId: item.instanceId,
    widgetType: item.widgetType,
    visible: item.visible,
    size: item.size ? { cols: item.size.cols, rows: item.size.rows } : null,
  })));
}

function applyDefaultPresetMigration(saved: WidgetInstance[]): WidgetInstance[] {
  // Only override when the user is still on the old stock default.
  if (canonicalLayout(saved) === canonicalLayout(LEGACY_V8_DEFAULT_LAYOUT)) {
    return DEFAULT_LAYOUT;
  }
  return saved;
}

function loadLayout(): WidgetInstance[] {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as WidgetInstance[];
      const normalized = applyDefaultPresetMigration(normalizeNetworkHeight(saved)).map((item) => ({
        ...item,
        size: normalizeSize(item.size, defaultSize(item.widgetType)),
      }));
      return mergeWithDefaults(normalized);
    }

    // v8/v7/v6/v5 -> v9: preserve user layout, keep tier migrations, normalize
    // network to H1-only, and apply the new default preset if user was still on
    // the old stock default.
    for (const prevKey of PREVIOUS_STORAGE_KEYS) {
      const prevRaw = localStorage.getItem(prevKey);
      if (!prevRaw) continue;
      const prev = JSON.parse(prevRaw) as WidgetInstance[];
      const migrated = mergeWithDefaults(
        applyDefaultPresetMigration(
          normalizeNetworkHeight(removeQuickActions(migrateHeightTiers(prev)))
        ).map((item) => ({
        ...item,
        size: normalizeSize(item.size, defaultSize(item.widgetType)),
        }))
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }

    // Try v4 format (instance-based but may have network-rate)
    const v4Raw = localStorage.getItem("talome-widget-layout-v4");
    if (v4Raw) {
      const v4 = JSON.parse(v4Raw) as WidgetInstance[];
      const migrated = mergeWithDefaults(migrateV4Instances(v4).map((item) => ({
        ...item,
        size: normalizeSize(item.size, defaultSize(item.widgetType)),
      })));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }

    // Legacy v3 fallback
    const legacyRaw = localStorage.getItem("talome-widget-layout-v3");
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as LegacyWidgetConfig[];
      const migrated = mergeWithDefaults(migrateLegacyLayout(legacy));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }

    return DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function saveLayout(layout: WidgetInstance[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  void fetch(`${CORE_URL}/api/widgets/layout`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout }),
  }).catch(() => {
    // Keep local persistence as source-of-truth fallback when sync fails.
  });
}

export function useWidgetLayout() {
  const [layout, setLayout] = useState<WidgetInstance[]>(() => loadLayout());
  const lastLocalWriteAtRef = useRef(0);

  const persistLayout = useCallback((next: WidgetInstance[]) => {
    lastLocalWriteAtRef.current = Date.now();
    saveLayout(next);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const syncFromServer = async () => {
      try {
        const res = await fetch(`${CORE_URL}/api/widgets/layout`, { cache: "no-store", credentials: "include" });
        if (!res.ok) return;
        const data = await res.json().catch(() => null) as { layout?: WidgetInstance[] } | null;
        const remote = Array.isArray(data?.layout) ? data.layout : [];
        if (remote.length === 0 || cancelled) return;

        const normalized = mergeWithDefaults(applyDefaultPresetMigration(normalizeNetworkHeight(remote)).map((item) => ({
          ...item,
          size: normalizeSize(item.size, defaultSize(item.widgetType)),
        })));

        // Avoid unnecessary re-renders when layouts are already the same.
        setLayout((prev) => {
          if (JSON.stringify(prev) === JSON.stringify(normalized)) return prev;
          // Prevent stale remote snapshots from immediately clobbering a fresh
          // local edit/save action.
          if (Date.now() - lastLocalWriteAtRef.current < 4000) return prev;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
          return normalized;
        });
      } catch {
        // Network/session issues should not break local layout behavior.
      }
    };

    void syncFromServer();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void syncFromServer();
    }, 15000);
    const onFocus = () => {
      void syncFromServer();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void syncFromServer();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const toggleWidget = useCallback((instanceId: string) => {
    setLayout((prev) => {
      const next = prev.map((w) =>
        w.instanceId === instanceId ? { ...w, visible: !w.visible } : w
      );
      persistLayout(next);
      return next;
    });
  }, [persistLayout]);

  const addWidget = useCallback((widgetType: WidgetType) => {
    setLayout((prev) => {
      const existingHidden = prev.find((w) => w.widgetType === widgetType && !w.visible);
      if (existingHidden) {
        const next = prev.map((w) =>
          w.instanceId === existingHidden.instanceId ? { ...w, visible: true } : w
        );
        persistLayout(next);
        return next;
      }

      const next = [
        ...prev,
        {
          instanceId: makeInstanceId(widgetType),
          widgetType,
          visible: true,
          size: defaultSize(widgetType),
        },
      ];
      persistLayout(next);
      return next;
    });
  }, [persistLayout]);

  const reorderLayout = useCallback((fromIndex: number, toIndex: number) => {
    setLayout((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      persistLayout(next);
      return next;
    });
  }, [persistLayout]);

  const resizeWidget = useCallback((instanceId: string, size: WidgetSize) => {
    setLayout((prev) => {
      const next = prev.map((w) => w.instanceId === instanceId ? { ...w, size } : w);
      persistLayout(next);
      return next;
    });
  }, [persistLayout]);

  const resetLayout = useCallback((): WidgetInstance[] => {
    const prev = layout;
    setLayout(DEFAULT_LAYOUT);
    persistLayout(DEFAULT_LAYOUT);
    return prev;
  }, [layout, persistLayout]);

  const restoreLayout = useCallback((snapshot: WidgetInstance[]) => {
    setLayout(snapshot);
    persistLayout(snapshot);
  }, [persistLayout]);

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
