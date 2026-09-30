import { describe, it, expect, vi } from "vitest";

// Regression: Immich/Jellyseerr connection details must not change how
// app_api_call authenticates (convention fallback → X-Api-Key), and must not
// opt those apps into health scoring / the setup loop.

const settings: Record<string, string> = {
  immich_url: "http://immich:2283/",
  immich_api_key: "IMMICH-KEY-REGRESSION",
  jellyseerr_url: "http://jellyseerr:5055",
  jellyseerr_api_key: "JELLYSEERR-KEY-REGRESSION",
};

vi.mock("../utils/settings.js", () => ({
  getSetting: (key: string) => settings[key],
}));
vi.mock("../docker/client.js", () => ({
  listContainers: vi.fn(async () => []),
}));

import { appApiCallTool, resolveAppConnection, buildHeaders } from "../ai/tools/universal-tools.js";
import { APP_AUTH_SCHEMES, APP_REGISTRY, SETTINGS_ONLY_APPS, getConnectableApp } from "../app-registry/index.js";

describe("app_api_call auth for settings-only apps", () => {
  it.each([
    ["immich", "IMMICH-KEY-REGRESSION"],
    ["jellyseerr", "JELLYSEERR-KEY-REGRESSION"],
  ])("%s still sends its API key as X-Api-Key", (appId, key) => {
    const conn = resolveAppConnection(appId);
    if ("error" in conn) throw new Error(conn.error);
    expect(conn.auth).toEqual({ type: "x-api-key", header: "X-Api-Key", value: key });
    expect(buildHeaders(conn.auth)["X-Api-Key"]).toBe(key);
  });

  it("sends X-Api-Key on a real app_api_call to Immich", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ email: "me@example.com" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const execute = appApiCallTool.execute as unknown as (input: unknown, opts: unknown) => Promise<{ success?: boolean }>;
      await execute({ appId: "immich", method: "GET", path: "/api/users/me", timeoutMs: 1000 }, { toolCallId: "t", messages: [] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("http://immich:2283/api/users/me");
      expect((init.headers as Record<string, string>)["X-Api-Key"]).toBe("IMMICH-KEY-REGRESSION");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("registry membership", () => {
  it("keeps user-keyed apps out of APP_REGISTRY (health score, setup loop, detectors)", () => {
    expect(Object.keys(APP_REGISTRY)).not.toContain("immich");
    expect(Object.keys(APP_REGISTRY)).not.toContain("jellyseerr");
    expect(Object.keys(SETTINGS_ONLY_APPS).sort()).toEqual(["immich", "jellyseerr"]);
  });

  it("resolves connection details for both registries, never prototype keys", () => {
    expect(getConnectableApp("Immich")?.apiBaseSettingKey).toBe("immich_url");
    expect(getConnectableApp("sonarr")?.apiKeySettingKey).toBe("sonarr_api_key");
    expect(getConnectableApp("constructor")).toBeUndefined();
    expect(getConnectableApp("__proto__")).toBeUndefined();
  });

  it("has an auth scheme for every app Talome can connect to", () => {
    for (const id of [...Object.keys(APP_REGISTRY), ...Object.keys(SETTINGS_ONLY_APPS)]) {
      expect(APP_AUTH_SCHEMES[id], id).toBeDefined();
    }
  });
});
