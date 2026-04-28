import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ───────────────────────────────────────────────────────────────────
const mockInstalledAppGet = vi.fn();
const mockSettingsGet = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: vi.fn().mockImplementation(() => {
            // Route by call context (settings vs installedApps)
            // The diagnose tool calls this with two different tables
            return mockInstalledAppGet();
          }),
        }),
      }),
    }),
  },
  schema: {
    installedApps: { appId: "app_id" },
    settings: { key: "key" },
  },
}));

// ── Mock fetch ────────────────────────────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ── Mock container resolver ───────────────────────────────────────────────────
const mockResolveAppContainers = vi.fn();
vi.mock("../docker/container-resolver.js", () => ({
  resolveAppContainers: (...args: unknown[]) => mockResolveAppContainers(...args),
}));

import { diagnoseAppTool } from "../ai/tools/diagnose-tool.js";

describe("diagnose_app tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no containers tracked / nothing to resolve.
    mockResolveAppContainers.mockResolvedValue([]);
  });

  it("returns error when app is not installed", async () => {
    mockInstalledAppGet.mockReturnValue(null);

    const result = await (diagnoseAppTool.execute as Function)({ appId: "sonarr" }, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not installed/i);
  });

  it("returns degraded status when app is not running", async () => {
    mockInstalledAppGet.mockReturnValue({
      appId: "sonarr",
      status: "stopped",
      containerIds: "[]",
      overrideComposePath: null,
    });
    // No settings for URL/key
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    const result = await (diagnoseAppTool.execute as Function)({ appId: "sonarr" }, {});
    expect(result.success).toBe(true);
    expect(result.overallStatus).not.toBe("healthy");
    const installCheck = result.checks.find((c: { check: string }) => c.check === "installation");
    expect(installCheck?.status).toBe("warning");
  });

  it("returns healthy when app is running and health endpoint responds", async () => {
    mockInstalledAppGet.mockReturnValue({
      appId: "jellyfin",
      status: "running",
      containerIds: '["abc123"]',
      overrideComposePath: null,
    });
    mockResolveAppContainers.mockResolvedValue([
      { storedId: "abc123", currentId: "abc123", name: "jellyfin", state: "running", adopted: false },
    ]);

    // fetch returns ok for health probe
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await (diagnoseAppTool.execute as Function)({ appId: "jellyfin" }, {});
    expect(result.success).toBe(true);
    // Installation check should be ok
    const installCheck = result.checks.find((c: { check: string }) => c.check === "installation");
    expect(installCheck?.status).toBe("ok");
  });

  it("flags installation as error when all stored containers are gone", async () => {
    mockInstalledAppGet.mockReturnValue({
      appId: "radarr",
      status: "stopped",
      containerIds: '["688c0dd2dad6"]',
      overrideComposePath: null,
    });
    mockResolveAppContainers.mockResolvedValue([
      { storedId: "688c0dd2dad6", currentId: null, name: "radarr", state: "missing", adopted: false },
    ]);
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    const result = await (diagnoseAppTool.execute as Function)({ appId: "radarr" }, {});
    const installCheck = result.checks.find((c: { check: string }) => c.check === "installation");
    expect(installCheck?.status).toBe("error");
    expect(installCheck?.details).toMatch(/destroyed|none found/i);
    expect(result.overallStatus).toBe("unhealthy");

    const logCheck = result.checks.find((c: { check: string }) => c.check === "logs");
    expect(logCheck?.status).toBe("error");
  });

  it("re-binds to an adopted container and reports it as ok", async () => {
    mockInstalledAppGet.mockReturnValue({
      appId: "sonarr",
      status: "stopped",
      containerIds: '["staleid12345"]',
      overrideComposePath: null,
    });
    mockResolveAppContainers.mockResolvedValue([
      { storedId: "staleid12345", currentId: "newid67890", name: "sonarr", state: "running", adopted: true },
    ]);
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await (diagnoseAppTool.execute as Function)({ appId: "sonarr" }, {});
    const installCheck = result.checks.find((c: { check: string }) => c.check === "installation");
    expect(installCheck?.status).toBe("ok");
    expect(installCheck?.details).toMatch(/re-bound/i);

    const logCheck = result.checks.find((c: { check: string }) => c.check === "logs");
    expect(logCheck?.details).toContain("newid67890");
    expect(logCheck?.details).not.toContain("staleid12345");
  });

  it("includes all expected check types in results", async () => {
    mockInstalledAppGet.mockReturnValue({
      appId: "sonarr",
      status: "running",
      containerIds: "[]",
      overrideComposePath: null,
    });
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    const result = await (diagnoseAppTool.execute as Function)({ appId: "sonarr" }, {});
    expect(result.success).toBe(true);
    const checkNames = result.checks.map((c: { check: string }) => c.check);
    expect(checkNames).toContain("installation");
    expect(checkNames).toContain("logs");
    expect(checkNames).toContain("http_health");
    expect(checkNames).toContain("config");
  });

  it("runs parallel checks (all checks present even if some fail)", async () => {
    mockInstalledAppGet.mockReturnValue({
      appId: "radarr",
      status: "running",
      containerIds: "[]",
      overrideComposePath: null,
    });
    // Simulate network failure
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await (diagnoseAppTool.execute as Function)({ appId: "radarr" }, {});
    expect(result.success).toBe(true);
    // Should have results for all checks despite fetch failure
    expect(result.checks.length).toBeGreaterThanOrEqual(3);
  });

  it("provides recommendations when issues found", async () => {
    mockInstalledAppGet.mockReturnValue({
      appId: "sonarr",
      status: "stopped",
      containerIds: "[]",
      overrideComposePath: null,
    });
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    const result = await (diagnoseAppTool.execute as Function)({ appId: "sonarr" }, {});
    expect(result.success).toBe(true);
    expect(Array.isArray(result.recommendations)).toBe(true);
  });
});
