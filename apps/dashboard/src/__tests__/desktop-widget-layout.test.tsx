import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDesktopWidgetLayout } from "@/hooks/use-desktop-widget-layout";
import { WIDGET_LABELS, widgetDisplayLabel } from "@/components/widgets/widget-grid";

describe("desktop widget layout", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return values.size;
      },
      clear: () => values.clear(),
      getItem: (key) => values.get(key) ?? null,
      key: (index) => Array.from(values.keys())[index] ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, value),
    };
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
  });

  it("starts with the clock and the three system widgets without copying the Home layout", () => {
    localStorage.setItem("talome-widget-layout-v9", JSON.stringify([
      { instanceId: "home-services", widgetType: "services", visible: true },
    ]));

    const { result } = renderHook(() => useDesktopWidgetLayout());
    const visibleTypes = result.current.layout
      .filter((widget) => widget.visible)
      .map((widget) => widget.widgetType);

    expect(visibleTypes).toEqual(["clock", "cpu", "memory", "disk"]);
  });

  it("puts the clock first on a desktop saved before the clock existed", () => {
    localStorage.setItem("talome-desktop-widget-layout-v1", JSON.stringify([
      { instanceId: "desktop-memory", widgetType: "memory", visible: true, size: { cols: 1, rows: 1 } },
      { instanceId: "desktop-cpu", widgetType: "cpu", visible: true, size: { cols: 1, rows: 1 } },
    ]));

    const { result } = renderHook(() => useDesktopWidgetLayout());
    const visibleTypes = result.current.layout
      .filter((widget) => widget.visible)
      .map((widget) => widget.widgetType);

    expect(visibleTypes.slice(0, 3)).toEqual(["clock", "memory", "cpu"]);
  });

  it("persists widget visibility independently across mounts", () => {
    const first = renderHook(() => useDesktopWidgetLayout());

    act(() => {
      first.result.current.toggleWidget("desktop-cpu");
      first.result.current.addWidget("network");
    });
    first.unmount();

    const second = renderHook(() => useDesktopWidgetLayout());
    const visibleTypes = second.result.current.layout
      .filter((widget) => widget.visible)
      .map((widget) => widget.widgetType);

    expect(visibleTypes).not.toContain("cpu");
    expect(visibleTypes).toContain("network");
  });

  it("normalizes saved desktop widgets to a maximum W2 by H2", () => {
    localStorage.setItem("talome-desktop-widget-layout-v1", JSON.stringify([
      {
        instanceId: "desktop-downloads",
        widgetType: "active-downloads",
        visible: true,
        size: { cols: 4, rows: 3 },
      },
    ]));

    const { result } = renderHook(() => useDesktopWidgetLayout());
    const downloads = result.current.layout.find(
      (widget) => widget.instanceId === "desktop-downloads",
    );

    expect(downloads?.size).toEqual({ cols: 2, rows: 2 });
  });

  it("clamps desktop resize requests to W2 by H2", () => {
    const { result } = renderHook(() => useDesktopWidgetLayout());

    act(() => {
      result.current.resizeWidget("desktop-cpu", { cols: 4, rows: 3 });
    });

    expect(
      result.current.layout.find((widget) => widget.instanceId === "desktop-cpu")?.size,
    ).toEqual({ cols: 2, rows: 2 });
  });

  it("keeps a widget visible when Undo follows re-adding it (regression: Undo toggled it hidden again)", () => {
    const { result } = renderHook(() => useDesktopWidgetLayout());
    const cpu = () => result.current.layout.find((widget) => widget.instanceId === "desktop-cpu");
    act(() => result.current.setWidgetVisible("desktop-cpu", false));
    expect(cpu()?.visible).toBe(false);
    // Re-added from "Add widgets" within the undo window: the hidden instance comes back.
    act(() => result.current.addWidget("cpu"));
    expect(cpu()?.visible).toBe(true);
    // Then Undo from the removal toast.
    act(() => result.current.setWidgetVisible("desktop-cpu", true));
    expect(cpu()?.visible).toBe(true);
  });
});

describe("widget names in copy", () => {
  it("are sentence case, and a custom widget is named by its manifest, never its id", () => {
    expect(WIDGET_LABELS["active-downloads"]).toBe("Active downloads");
    expect(WIDGET_LABELS["system-health"]).toBe("System health");
    const manifests = new Map([["my-widget-id", { title: "Plex now playing" }]]);
    expect(widgetDisplayLabel("widget:my-widget-id", manifests)).toBe("Plex now playing");
    expect(widgetDisplayLabel("widget:unknown", manifests)).toBe("custom widget");
    expect(widgetDisplayLabel("cpu", manifests)).toBe("CPU");
  });
});
