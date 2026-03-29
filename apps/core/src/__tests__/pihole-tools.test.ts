import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSettingsGet = vi.hoisted(() => vi.fn());

vi.mock("../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          get: mockSettingsGet,
        }),
      }),
    }),
  },
  schema: { settings: { key: "key" } },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  piholeGetStatsTool,
  piholeEnableTool,
  piholeDisableTool,
  piholeWhitelistTool,
  piholeBlacklistTool,
} from "../ai/tools/pihole-tools.js";

describe("pihole-tools: unconfigured", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSettingsGet.mockReturnValue(null); });

  it("pihole_get_stats returns error when not configured", async () => {
    const result = await (piholeGetStatsTool.execute as Function)({}, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not configured/i);
  });
});

describe("pihole-tools: configured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let callCount = 0;
    mockSettingsGet.mockImplementation(() => {
      callCount++;
      return callCount % 2 === 1 ? { value: "http://pihole" } : { value: "pihole-api-token" };
    });
  });

  it("pihole_enable calls admin API with enable param", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ status: "enabled" }),
    });

    const result = await (piholeEnableTool.execute as Function)({}, {});
    expect(result.success).toBe(true);
    expect(result.message).toContain("enabled");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("enable");
    expect(url).toContain("auth=pihole-api-token");
  });

  it("pihole_disable calls admin API with disable param and duration", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ status: "disabled" }),
    });

    const result = await (piholeDisableTool.execute as Function)({ seconds: 300 }, {});
    expect(result.success).toBe(true);
    expect(result.message).toContain("300");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("disable=300");
  });

  it("pihole_whitelist calls admin API with whitelist params", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({}),
    });

    const result = await (piholeWhitelistTool.execute as Function)({ domain: "example.com" }, {});
    expect(result.success).toBe(true);
    expect(result.message).toContain("example.com");
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("list=white");
    expect(url).toContain("add=example.com");
  });

  it("pihole_blacklist calls admin API with blacklist params", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({}),
    });

    const result = await (piholeBlacklistTool.execute as Function)({ domain: "ads.evil.com" }, {});
    expect(result.success).toBe(true);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("list=black");
    expect(url).toContain("add=ads.evil.com");
  });
});
