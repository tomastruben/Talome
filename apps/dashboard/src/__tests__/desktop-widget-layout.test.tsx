import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDesktopWidgetLayout } from "@/hooks/use-desktop-widget-layout";

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

  it("starts with the three system widgets without copying the Home layout", () => {
    localStorage.setItem("talome-widget-layout-v9", JSON.stringify([
      { instanceId: "home-services", widgetType: "services", visible: true },
    ]));

    const { result } = renderHook(() => useDesktopWidgetLayout());
    const visibleTypes = result.current.layout
      .filter((widget) => widget.visible)
      .map((widget) => widget.widgetType);

    expect(visibleTypes).toEqual(["cpu", "memory", "disk"]);
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
});
