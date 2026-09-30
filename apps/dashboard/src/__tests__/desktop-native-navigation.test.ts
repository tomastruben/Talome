import { afterEach, describe, expect, it } from "vitest";
import {
  desktopRouteBelongsToWindow,
  findDesktopNativeService,
  isSameDashboardApp,
  nativeDashboardAppKey,
} from "@/lib/desktop-navigation";

afterEach(() => window.history.replaceState({}, "", "/"));

const services = [
  { id: "weather-ui", name: "Weather", url: "http://localhost:3000/dashboard/native-apps/user-apps/weather" },
  { id: "other-weather-ui", name: "Other weather", url: "http://localhost:3000/dashboard/native-apps/community/weather" },
  { id: "reader", name: "Reader", url: "http://localhost:5000" },
];

describe("native desktop app identities", () => {
  it("maps a native route to its existing container identity, including query/screen state", () => {
    expect(findDesktopNativeService(
      "/dashboard/native-apps/user-apps/weather?screen=settings#forecast",
      services,
    )).toBe(services[0]);
  });

  it("distinguishes the same app id in different stores", () => {
    expect(findDesktopNativeService("/dashboard/native-apps/community/weather", services)).toBe(services[1]);
    expect(isSameDashboardApp(
      "/dashboard/native-apps/community/weather",
      services[0].url,
    )).toBe(false);
  });

  it("accepts state reports for a native service window despite its service:container id", () => {
    const state = "/dashboard/native-apps/user-apps/weather?screen=settings";
    expect(desktopRouteBelongsToWindow(state, services[0].url)).toBe(true);
    // Persisted state uses a relative route when the desktop is reopened.
    expect(desktopRouteBelongsToWindow(state, "/dashboard/native-apps/user-apps/weather")).toBe(true);
    expect(desktopRouteBelongsToWindow(state, services[1].url)).toBe(false);
    expect(desktopRouteBelongsToWindow("/dashboard/settings", services[0].url)).toBe(false);
  });

  it("never treats an external service as a dashboard app", () => {
    expect(findDesktopNativeService("http://localhost:5000", services)).toBeUndefined();
    expect(findDesktopNativeService("https://example.com/dashboard/native-apps/user-apps/weather", services)).toBeUndefined();
    expect(desktopRouteBelongsToWindow("/dashboard/native-apps/user-apps/weather", services[2].url)).toBe(false);
  });

  it("normalizes encoded store and app identities without allowing malformed roots", () => {
    expect(nativeDashboardAppKey("/dashboard/native-apps/my%20store/weather%2dapp"))
      .toBe("my%20store/weather-app");
    expect(nativeDashboardAppKey("/dashboard/native-apps/user-apps")).toBeNull();
    expect(nativeDashboardAppKey("/dashboard/native-apps/user-apps/%ZZ")).toBeNull();
    expect(isSameDashboardApp(
      "/dashboard/native-apps/user-apps",
      "http://localhost:3000/dashboard/native-apps/user-apps",
    )).toBe(false);
  });

  it("keeps ordinary dashboard route ownership unchanged", () => {
    expect(desktopRouteBelongsToWindow("/dashboard/settings/security", "/dashboard/settings")).toBe(true);
    expect(desktopRouteBelongsToWindow("/dashboard/apps/user-apps/weather", "/dashboard/settings")).toBe(false);
  });
});
