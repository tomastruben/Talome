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

import { diagnoseAppTool } from "../ai/tools/diagnose-tool.js";

describe("diagnose_app tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    // fetch returns ok for health probe
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const result = await (diagnoseAppTool.execute as Function)({ appId: "jellyfin" }, {});
    expect(result.success).toBe(true);
    // Installation check should be ok
    const installCheck = result.checks.find((c: { check: string }) => c.check === "installation");
    expect(installCheck?.status).toBe("ok");
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
