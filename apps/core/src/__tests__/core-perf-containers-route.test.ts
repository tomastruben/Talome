import { describe, it, expect, vi, beforeEach } from "vitest";

const dockerMock = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getContainerStats: vi.fn(),
  getContainerStatsBatch: vi.fn(),
  startContainer: vi.fn(),
  stopContainer: vi.fn(),
  restartContainer: vi.fn(),
  getContainerLogs: vi.fn(),
  removeContainer: vi.fn(),
  listNetworks: vi.fn(),
  createNetwork: vi.fn(),
  connectContainerToNetwork: vi.fn(),
  disconnectContainerFromNetwork: vi.fn(),
  removeNetwork: vi.fn(),
}));
vi.mock("../docker/client.js", () => dockerMock);

const dbState = vi.hoisted(() => ({
  selects: [] as Array<{ table: string; columns: string[] | "*" }>,
}));

vi.mock("../db/index.js", () => {
  const appCatalog = {
    __name: "app_catalog",
    appId: "appId", source: "source", name: "name", icon: "icon",
    iconUrl: "iconUrl", category: "category", image: "image",
  };
  const installedApps = { __name: "installed_apps" };
  const rows: Record<string, unknown[]> = {
    app_catalog: [
      { appId: "sonarr", source: "talome", name: "Sonarr", icon: "📺", iconUrl: null, category: "media", image: "linuxserver/sonarr:4" },
    ],
    installed_apps: [],
  };
  return {
    schema: { appCatalog, installedApps },
    db: {
      select: (columns?: Record<string, unknown>) => ({
        from: (table: { __name: string }) => {
          dbState.selects.push({ table: table.__name, columns: columns ? Object.keys(columns) : "*" });
          return { all: () => rows[table.__name] ?? [] };
        },
      }),
    },
  };
});

vi.mock("../db/audit.js", () => ({ writeAuditEntry: vi.fn() }));
vi.mock("../services/docker.js", () => ({ getLastErrorWithVariables: vi.fn(), getStartupFailures: vi.fn() }));
vi.mock("../middleware/request-logger.js", () => ({
  serverError: (c: { json: (b: unknown, s: number) => Response }) => c.json({ error: "fail" }, 500),
}));

import { containers, invalidateCatalogLookupCache } from "../routes/containers.js";

const stats = { cpuPercent: 5, memoryUsageMb: 100, memoryLimitMb: 1000, networkRxBytes: 1, networkTxBytes: 2 };

function container(id: string, name: string, status: string) {
  return { id, name, image: `linuxserver/${name}:4`, status, ports: [], created: "2026-01-01T00:00:00.000Z", labels: {} };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selects = [];
  invalidateCatalogLookupCache();
  dockerMock.listContainers.mockResolvedValue([
    container("aaa", "sonarr", "running"),
    container("bbb", "old", "exited"),
  ]);
  dockerMock.getContainerStatsBatch.mockResolvedValue(new Map([["aaa", stats]]));
});

describe("GET /api/containers", () => {
  it("keeps the response shape and attaches sampler stats to running containers only", async () => {
    const res = await containers.request("/");
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({ id: "aaa", name: "sonarr", status: "running", stats });
    expect(body[1]).not.toHaveProperty("stats");

    expect(dockerMock.listContainers).toHaveBeenCalledWith({ cached: true });
    expect(dockerMock.getContainerStatsBatch).toHaveBeenCalledWith(["aaa"]);
    // No per-request Docker stats calls anymore.
    expect(dockerMock.getContainerStats).not.toHaveBeenCalled();
  });

  it("grouped view selects only the needed catalog columns and memoizes the lookup", async () => {
    const first = await containers.request("/?grouped=true");
    const stacks = await first.json() as Array<Record<string, unknown>>;
    expect(stacks[0]).toMatchObject({ name: "Sonarr", icon: "📺", category: "media", cpuPercent: 5 });

    await containers.request("/?grouped=true");
    const catalogSelects = dbState.selects.filter((s) => s.table === "app_catalog");
    expect(catalogSelects).toHaveLength(1);
    expect(catalogSelects[0].columns).toEqual(["appId", "source", "name", "icon", "iconUrl", "category", "image"]);
  });
});
