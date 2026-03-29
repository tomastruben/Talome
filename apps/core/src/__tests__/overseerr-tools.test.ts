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
  overseerrGetStatusTool,
  overseerrConfigureSonarrTool,
  overseerrConfigureRadarrTool,
  overseerrListRequestsTool,
  overseerrApproveRequestTool,
} from "../ai/tools/overseerr-tools.js";

function configureOverseerr() {
  let callCount = 0;
  mockSettingsGet.mockImplementation(() => {
    callCount++;
    return callCount % 2 === 1 ? { value: "http://overseerr:5055" } : { value: "overseerr-api-key" };
  });
}

describe("overseerr-tools: unconfigured", () => {
  beforeEach(() => { vi.clearAllMocks(); mockSettingsGet.mockReturnValue(null); });

  it("overseerr_get_status returns error when not configured", async () => {
    const result = await (overseerrGetStatusTool.execute as Function)({}, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not configured|missing/i);
  });
});

describe("overseerr-tools: configured", () => {
  beforeEach(() => { vi.clearAllMocks(); configureOverseerr(); });

  it("overseerr_configure_sonarr posts correct server config", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ id: 1, name: "Sonarr" }),
    });

    const result = await (overseerrConfigureSonarrTool.execute as Function)(
      { name: "Sonarr", hostname: "sonarr", port: 8989, apiKey: "sonarr-key" },
      {},
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain("Sonarr");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.hostname).toBe("sonarr");
    expect(body.port).toBe(8989);
    expect(body.apiKey).toBe("sonarr-key");
  });

  it("overseerr_configure_radarr posts correct server config", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ id: 1, name: "Radarr" }),
    });

    const result = await (overseerrConfigureRadarrTool.execute as Function)(
      { name: "Radarr", hostname: "radarr", port: 7878, apiKey: "radarr-key" },
      {},
    );
    expect(result.success).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.hostname).toBe("radarr");
    expect(body.port).toBe(7878);
  });

  it("overseerr_approve_request sends POST to /request/:id/approve", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({ id: 42, status: 2 }),
    });

    const result = await (overseerrApproveRequestTool.execute as Function)({ requestId: 42 }, {});
    expect(result.success).toBe(true);
    expect(result.message).toContain("42");
    expect(mockFetch.mock.calls[0][0]).toContain("/request/42/approve");
    expect(mockFetch.mock.calls[0][1].method).toBe("POST");
  });

  it("overseerr_list_requests maps to simplified objects", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: () => Promise.resolve({
        pageInfo: { results: 2 },
        results: [
          { id: 1, status: 1, type: "movie", createdAt: "2026-01-01", media: { title: "Inception" } },
          { id: 2, status: 1, type: "tv", createdAt: "2026-01-02", media: { name: "Breaking Bad" } },
        ],
      }),
    });

    const result = await (overseerrListRequestsTool.execute as Function)({ status: "pending", take: 20 }, {});
    expect(result.success).toBe(true);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[0].media).toBe("Inception");
  });
});
