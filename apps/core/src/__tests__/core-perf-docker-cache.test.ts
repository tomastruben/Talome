import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

// ── Dockerode mock ──────────────────────────────────────────────────────────
const dockerMock = vi.hoisted(() => ({
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  getEvents: vi.fn(),
  ping: vi.fn(),
  pruneContainers: vi.fn(),
}));

vi.mock("dockerode", () => ({
  default: class {
    constructor() {
      return dockerMock;
    }
  },
}));

// Platform probes are exercised in core-perf-platform.test.ts; here they are
// stubbed so getSystemStats never spawns a process.
const platformMock = vi.hoisted(() => ({
  getAppMemoryUsedAsync: vi.fn(async () => 4 * 1024 ** 3),
  sampleNetworkBytesAsync: vi.fn(async () => ({ rx: 1000, tx: 2000 })),
  readDiskMountsAsync: vi.fn(async () => [
    { fs: "/dev/disk1", mount: "/", usedBytes: 50, totalBytes: 100, percent: 50, type: "internal" as const },
  ]),
}));

vi.mock("../platform/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../platform/index.js")>();
  return { ...actual, ...platformMock };
});

import {
  listContainers,
  listContainersRaw,
  runWithContainerListCache,
  invalidateContainerListCache,
  startContainer,
  stopContainer,
  getContainerStats,
  getContainerStatsBatch,
  getCachedContainerStats,
  getSystemStats,
  subscribeDockerEvents,
  CONTAINER_LIST_CACHE_TTL_MS,
  CONTAINER_STATS_TTL_MS,
  __resetDockerClientCachesForTests,
} from "../docker/client.js";

function rawContainer(id: string, state = "running") {
  return {
    Id: `${id}${"0".repeat(64 - id.length)}`,
    Names: [`/${id}`],
    Image: `img/${id}:1`,
    State: state,
    Ports: [],
    Created: 1_700_000_000,
    Labels: { app: id },
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function statsPayload() {
  return {
    cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 1000, online_cpus: 2 },
    precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 500 },
    memory_stats: { usage: 100 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
    networks: { eth0: { rx_bytes: 10, tx_bytes: 20 } },
  };
}

let nowMs = 1_000_000;

beforeEach(() => {
  vi.clearAllMocks();
  __resetDockerClientCachesForTests();
  nowMs = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  dockerMock.listContainers.mockImplementation(async () => [rawContainer("aaa"), rawContainer("bbb", "exited")]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Container list cache ────────────────────────────────────────────────────

describe("listContainers cache", () => {
  it("plain calls stay fresh (one Docker call each)", async () => {
    await listContainers();
    await listContainers();
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);
  });

  it("cached calls reuse the list within the TTL and refetch after it", async () => {
    await listContainers({ cached: true });
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(1);

    nowMs += CONTAINER_LIST_CACHE_TTL_MS + 1;
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);
  });

  it("de-duplicates concurrent cached callers into one in-flight request", async () => {
    const d = deferred<ReturnType<typeof rawContainer>[]>();
    dockerMock.listContainers.mockImplementationOnce(() => d.promise);

    const p1 = listContainers({ cached: true });
    const p2 = listContainers({ cached: true });
    const p3 = listContainersRaw({ cached: true });
    d.resolve([rawContainer("aaa")]);
    const [a, b, c] = await Promise.all([p1, p2, p3]);

    expect(dockerMock.listContainers).toHaveBeenCalledTimes(1);
    expect(a).toHaveLength(1);
    expect(b[0].name).toBe("aaa");
    expect(c).toHaveLength(1);
  });

  it("fresh option bypasses a warm cache", async () => {
    await listContainers({ cached: true });
    await listContainers({ fresh: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);
  });

  it("runWithContainerListCache makes plain calls inside the scope cached", async () => {
    await runWithContainerListCache(async () => {
      await listContainers();
      await listContainers();
    });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(1);
    // Outside the scope calls are fresh again.
    await listContainers();
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);
  });

  it("Talome's own mutations invalidate the cache", async () => {
    const container = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    dockerMock.getContainer.mockReturnValue(container);

    await listContainers({ cached: true });
    await startContainer("aaa");
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);

    await stopContainer("aaa");
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(3);
  });

  it("a request in flight during invalidation is not cached", async () => {
    const d = deferred<ReturnType<typeof rawContainer>[]>();
    dockerMock.listContainers.mockImplementationOnce(() => d.promise);

    const stale = listContainers({ cached: true });
    invalidateContainerListCache();
    // A caller after the invalidation must not join the pre-mutation request.
    const after = listContainers({ cached: true });
    d.resolve([rawContainer("old")]);

    expect((await stale)[0].name).toBe("old");
    expect((await after)[0].name).toBe("aaa");
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);

    // And the stale result did not become the cached list.
    const again = await listContainers({ cached: true });
    expect(again[0].name).toBe("aaa");
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);
  });

  it("returns copies so callers cannot corrupt the shared cache", async () => {
    const first = await listContainers({ cached: true });
    first[0].labels.app = "mutated";
    const second = await listContainers({ cached: true });
    expect(second[0].labels.app).toBe("aaa");
  });
});

// ── Docker events → invalidation ────────────────────────────────────────────

describe("subscribeDockerEvents cache invalidation", () => {
  it("invalidates on list-changing events and forwards only the historical actions", async () => {
    const stream = new EventEmitter();
    dockerMock.getEvents.mockResolvedValue(stream);
    const handler = vi.fn();
    const cleanup = subscribeDockerEvents(handler);
    await vi.waitFor(() => expect(stream.listenerCount("data")).toBeGreaterThan(0));

    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(1);

    // "create" invalidates but is not forwarded (it wasn't before).
    stream.emit("data", Buffer.from(JSON.stringify({ Type: "container", Action: "create", Actor: { ID: "ccc", Attributes: { name: "ccc" } } }) + "\n"));
    expect(handler).not.toHaveBeenCalled();
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);

    // Two events in one chunk, the second split across chunks.
    const die = JSON.stringify({ Type: "container", Action: "die", Actor: { ID: "aaa", Attributes: { name: "aaa" } } });
    const health = JSON.stringify({ Type: "container", Action: "health_status: healthy", Actor: { ID: "aaa", Attributes: { name: "aaa" } } });
    stream.emit("data", Buffer.from(`${die}\n${health.slice(0, 20)}`));
    stream.emit("data", Buffer.from(`${health.slice(20)}\n`));
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].action).toBe("die");
    expect(handler.mock.calls[1][0].action).toBe("health_status: healthy");

    cleanup();
  });
});

// ── Container stats sampler ─────────────────────────────────────────────────

describe("container stats sampler", () => {
  it("bounds concurrent Docker stats calls to 4 and de-duplicates per container", async () => {
    let active = 0;
    let maxActive = 0;
    const calls: string[] = [];
    dockerMock.getContainer.mockImplementation((id: string) => ({
      stats: async () => {
        calls.push(id);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return statsPayload();
      },
    }));

    const ids = Array.from({ length: 10 }, (_, i) => `c${i}`);
    const [batch] = await Promise.all([
      getContainerStatsBatch(ids, { waitMs: 5_000 }),
      getContainerStats("c0"), // joins the in-flight sample for c0
    ]);

    expect(batch.size).toBe(10);
    expect(maxActive).toBeLessThanOrEqual(4);
    expect(calls.filter((c) => c === "c0")).toHaveLength(1);
    expect(batch.get("c3")).toEqual({
      cpuPercent: 40,
      memoryUsageMb: 100,
      memoryLimitMb: 1024,
      networkRxBytes: 10,
      networkTxBytes: 20,
    });
  });

  it("serves cached samples within the TTL without calling Docker", async () => {
    const stats = vi.fn(async () => statsPayload());
    dockerMock.getContainer.mockReturnValue({ stats });

    await getContainerStatsBatch(["a"]);
    nowMs += CONTAINER_STATS_TTL_MS - 1;
    await getContainerStatsBatch(["a"]);
    expect(stats).toHaveBeenCalledTimes(1);
    expect(getCachedContainerStats("a")).toBeDefined();
  });

  it("returns stale samples immediately and refreshes them in the background", async () => {
    const d = deferred<ReturnType<typeof statsPayload>>();
    const stats = vi.fn()
      .mockResolvedValueOnce(statsPayload())
      .mockImplementationOnce(() => d.promise);
    dockerMock.getContainer.mockReturnValue({ stats });

    const first = await getContainerStatsBatch(["a"]);
    nowMs += CONTAINER_STATS_TTL_MS + 1;
    const second = await getContainerStatsBatch(["a"]); // must not wait on d
    expect(second.get("a")).toEqual(first.get("a"));
    await vi.waitFor(() => expect(stats).toHaveBeenCalledTimes(2));
    d.resolve({ ...statsPayload(), memory_stats: { usage: 200 * 1024 * 1024, limit: 1024 * 1024 * 1024 } });
    await vi.waitFor(() => expect(getCachedContainerStats("a", Infinity)?.memoryUsageMb).toBe(200));
  });

  it("waits at most waitMs for containers without a sample", async () => {
    const d = deferred<ReturnType<typeof statsPayload>>();
    dockerMock.getContainer.mockReturnValue({ stats: () => d.promise });
    const started = performance.now();
    const result = await getContainerStatsBatch(["slow"], { waitMs: 30 });
    expect(result.size).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
    // The sample still lands in the cache for the next poll.
    d.resolve(statsPayload());
    await vi.waitFor(() => expect(getCachedContainerStats("slow")).toBeDefined());
  });
});

// ── System stats ────────────────────────────────────────────────────────────

describe("getSystemStats", () => {
  it("shares one sample between concurrent callers and caches it briefly", async () => {
    const [a, b] = await Promise.all([getSystemStats(), getSystemStats()]);
    expect(a).toBe(b);
    expect(platformMock.readDiskMountsAsync).toHaveBeenCalledTimes(1);
    expect(platformMock.sampleNetworkBytesAsync).toHaveBeenCalledTimes(1);
    expect(a.disk.percent).toBe(50);
    expect(a.cpu.usage).toBeGreaterThanOrEqual(0);
    expect(a.cpu.usage).toBeLessThanOrEqual(100);

    await getSystemStats();
    expect(platformMock.sampleNetworkBytesAsync).toHaveBeenCalledTimes(1);

    nowMs += 3_000; // next SSE tick → new sample; disk served from its own longer cache
    await getSystemStats();
    expect(platformMock.sampleNetworkBytesAsync).toHaveBeenCalledTimes(2);
    expect(platformMock.readDiskMountsAsync).toHaveBeenCalledTimes(1);
  });

  it("serves the last disk reading while a slow df refreshes", async () => {
    await getSystemStats();
    const d = deferred<Awaited<ReturnType<typeof platformMock.readDiskMountsAsync>>>();
    platformMock.readDiskMountsAsync.mockImplementationOnce(() => d.promise);

    nowMs += 60_000;
    const stats = await getSystemStats(); // must not block on the pending df
    expect(stats.disk.percent).toBe(50);
    expect(platformMock.readDiskMountsAsync).toHaveBeenCalledTimes(2);
    d.resolve([{ fs: "/dev/disk1", mount: "/", usedBytes: 90, totalBytes: 100, percent: 90, type: "internal" }]);
    await d.promise;

    await vi.waitFor(async () => {
      nowMs += 3_000;
      expect((await getSystemStats()).disk.percent).toBe(90);
    });
  });
});
