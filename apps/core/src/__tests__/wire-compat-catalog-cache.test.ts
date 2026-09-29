/**
 * Store sync signals catalog rewrites; the container list drops its
 * memoized catalog lookup so new icons/names show up immediately.
 */
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
import { notifyCatalogChanged, onCatalogChanged } from "../stores/catalog-events.js";

const stats = { cpuPercent: 5, memoryUsageMb: 100, memoryLimitMb: 1000, networkRxBytes: 1, networkTxBytes: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  dbState.selects = [];
  invalidateCatalogLookupCache();
  dockerMock.listContainers.mockResolvedValue([
    { id: "aaa", name: "sonarr", image: "linuxserver/sonarr:4", status: "running", ports: [], created: "2026-01-01T00:00:00.000Z", labels: {} },
  ]);
  dockerMock.getContainerStatsBatch.mockResolvedValue(new Map([["aaa", stats]]));
});

const catalogSelects = () => dbState.selects.filter((s) => s.table === "app_catalog").length;

describe("catalog change signal → container list catalog memo", () => {
  it("a catalog rewrite drops the memoized lookup (stores never import the route)", async () => {
    await containers.request("/?grouped=true");
    await containers.request("/?grouped=true");
    expect(catalogSelects()).toBe(1);

    notifyCatalogChanged();
    await containers.request("/?grouped=true");
    expect(catalogSelects()).toBe(2);
  });

  it("a failing subscriber never breaks the notifier or other subscribers", () => {
    const off = onCatalogChanged(() => {
      throw new Error("boom");
    });
    const spy = vi.fn();
    const offSpy = onCatalogChanged(spy);
    expect(() => notifyCatalogChanged()).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    off();
    offSpy();
    notifyCatalogChanged();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
