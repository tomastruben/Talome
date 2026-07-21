import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  persistDashboardModePreference,
  readDashboardModePreference,
  writeDashboardModePreference,
} from "@/hooks/use-desktop-mode";

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

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("dashboard mode preference", () => {
  it("stores preferences separately for each account", () => {
    expect(writeDashboardModePreference("user-a", "desktop")).toBe(true);
    expect(writeDashboardModePreference("user-b", "classic")).toBe(true);

    expect(readDashboardModePreference("user-a")).toBe("desktop");
    expect(readDashboardModePreference("user-b")).toBe("classic");
    expect(readDashboardModePreference()).toBeUndefined();
  });

  it("persists the selected mode through the desktop preferences endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await expect(persistDashboardModePreference("user-a", "desktop")).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/preferences/desktop", {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "desktop" }),
    });
    expect(readDashboardModePreference("user-a")).toBe("desktop");
  });
});
