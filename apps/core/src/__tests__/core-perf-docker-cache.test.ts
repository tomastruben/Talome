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
type Mounts = Array<{ fs: string; mount: string; usedBytes: number; totalBytes: number; percent: number; type: "internal" }>;
const platformMock = vi.hoisted(() => ({
  getAppMemoryUsedAsync: vi.fn(async () => 4 * 1024 ** 3),
  sampleNetworkBytesAsync: vi.fn(async () => ({ rx: 1000, tx: 2000 })),
  // `mounts` is what df printed; `exited` is when the df child really exits.
  readDiskMountsTracked: vi.fn((): { mounts: Promise<Mounts | null>; exited: Promise<void> } => ({
    mounts: Promise.resolve([
      { fs: "/dev/disk1", mount: "/", usedBytes: 50, totalBytes: 100, percent: 50, type: "internal" as const },
    ]),
    exited: Promise.resolve(),
  })),
  // statfs("/") — the root disk figures.
  readDiskUsage: vi.fn(async (): Promise<{ usedBytes: number; totalBytes: number; percent: number } | null> => (
    { usedBytes: 50, totalBytes: 100, percent: 50 }
  )),
  // Cumulative CPU ticks (os.cpus()).
  sampleCpuTimes: vi.fn(() => ({ idle: 0, total: 0 })),
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
  startContainerCacheWatcher,
  stopContainerCacheWatcher,
  isContainerCacheWatcherConnected,
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
/** Event stream handed to every getEvents() call (cache watcher + subscribers). */
let eventStreamMock = new EventEmitter();

beforeEach(async () => {
  vi.clearAllMocks();
  __resetDockerClientCachesForTests();
  nowMs = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  dockerMock.listContainers.mockImplementation(async () => [rawContainer("aaa"), rawContainer("bbb", "exited")]);
  platformMock.readDiskMountsTracked.mockImplementation(() => ({
    mounts: Promise.resolve([
      { fs: "/dev/disk1", mount: "/", usedBytes: 50, totalBytes: 100, percent: 50, type: "internal" as const },
    ]),
    exited: Promise.resolve(),
  }));
  platformMock.readDiskUsage.mockImplementation(async () => ({ usedBytes: 50, totalBytes: 100, percent: 50 }));
  // A steady 20% load: every sample adds 100 ticks, 80 of them idle.
  let ticks = 0;
  platformMock.sampleCpuTimes.mockImplementation(() => {
    ticks += 100;
    return { idle: ticks * 0.8, total: ticks };
  });
  eventStreamMock = new EventEmitter();
  dockerMock.getEvents.mockImplementation(async () => eventStreamMock);
  // Cached reads are only trusted while the invalidation stream is up.
  await startContainerCacheWatcher();
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

// ── Cache watcher (independent of the agent loop) ──────────────────────────

describe("container cache watcher", () => {
  it("invalidates the cached list on compose-driven events without any subscriber", async () => {
    expect(isContainerCacheWatcherConnected()).toBe(true);
    await listContainers({ cached: true });
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(1);

    // `docker compose stop` outside Talome's helpers: only the event tells us.
    eventStreamMock.emit("data", Buffer.from(JSON.stringify({ Type: "container", Action: "stop", Actor: { ID: "aaa", Attributes: { name: "aaa" } } }) + "\n"));
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);
  });

  it("serves fresh reads while the event stream is down, cached again once reconnected", async () => {
    stopContainerCacheWatcher();
    dockerMock.getEvents.mockImplementation(async () => { throw new Error("daemon unavailable"); });
    await startContainerCacheWatcher();
    expect(isContainerCacheWatcherConnected()).toBe(false);

    await listContainers({ cached: true });
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);

    stopContainerCacheWatcher();
    dockerMock.getEvents.mockImplementation(async () => eventStreamMock);
    await startContainerCacheWatcher();
    await listContainers({ cached: true });
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(3);
  });

  it("stops trusting the cache when the stream ends", async () => {
    await listContainers({ cached: true });
    eventStreamMock.emit("end");
    expect(isContainerCacheWatcherConnected()).toBe(false);
    await listContainers({ cached: true });
    expect(dockerMock.listContainers).toHaveBeenCalledTimes(2);
  });

  it("the first cached read starts the watcher on its own", async () => {
    stopContainerCacheWatcher();
    dockerMock.getEvents.mockClear();
    await listContainers({ cached: true });
    await vi.waitFor(() => expect(isContainerCacheWatcherConnected()).toBe(true));
    expect(dockerMock.getEvents).toHaveBeenCalledTimes(1);
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

  it("getContainerStats serves a fresh cached sample without calling Docker", async () => {
    const stats = vi.fn(async () => statsPayload());
    dockerMock.getContainer.mockReturnValue({ stats });
    await getContainerStatsBatch(["a"]);
    nowMs += CONTAINER_STATS_TTL_MS - 1;
    expect((await getContainerStats("a")).cpuPercent).toBe(40);
    expect(stats).toHaveBeenCalledTimes(1);
  });

  it("interactive getContainerStats jumps ahead of queued background refreshes", async () => {
    const gates = new Map<string, ReturnType<typeof deferred<ReturnType<typeof statsPayload>>>>();
    const started: string[] = [];
    dockerMock.getContainer.mockImplementation((id: string) => ({
      stats: () => {
        started.push(id);
        const d = deferred<ReturnType<typeof statsPayload>>();
        gates.set(id, d);
        return d.promise;
      },
    }));

    // 4 samples running, 6 background samples queued (including "q5").
    const ids = Array.from({ length: 10 }, (_, i) => `q${i}`);
    void getContainerStatsBatch(ids, { waitMs: 1 });
    await vi.waitFor(() => expect(started).toHaveLength(4));

    // Interactive request for a container whose background sample is queued.
    const interactive = getContainerStats("q9");
    gates.get("q0")!.resolve(statsPayload());
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect(started[4]).toBe("q9");

    gates.get("q9")!.resolve(statsPayload());
    expect((await interactive).memoryUsageMb).toBe(100);

    // Drain: the queued background sample for q9 reuses the new sample.
    for (let i = 1; i < 9; i++) {
      await vi.waitFor(() => expect(gates.has(`q${i}`)).toBe(true));
      gates.get(`q${i}`)!.resolve(statsPayload());
    }
    await vi.waitFor(() => expect(started.filter((id) => id !== "q9")).toHaveLength(9));
    await new Promise((r) => setTimeout(r, 10));
    expect(started.filter((id) => id === "q9")).toHaveLength(1);
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
    expect(platformMock.readDiskMountsTracked).toHaveBeenCalledTimes(1);
    expect(platformMock.sampleNetworkBytesAsync).toHaveBeenCalledTimes(1);
    expect(a.disk.percent).toBe(50);
    expect(a.cpu.usage).toBeGreaterThanOrEqual(0);
    expect(a.cpu.usage).toBeLessThanOrEqual(100);

    await getSystemStats();
    expect(platformMock.sampleNetworkBytesAsync).toHaveBeenCalledTimes(1);

    nowMs += 3_000; // next SSE tick → new sample; disk served from its own longer cache
    await getSystemStats();
    expect(platformMock.sampleNetworkBytesAsync).toHaveBeenCalledTimes(2);
    expect(platformMock.readDiskMountsTracked).toHaveBeenCalledTimes(1);
  });

  it("serves the last disk reading while a slow df refreshes", async () => {
    await getSystemStats();
    const d = deferred<Mounts | null>();
    platformMock.readDiskMountsTracked.mockImplementationOnce(() => ({ mounts: d.promise, exited: d.promise.then(() => {}) }));

    nowMs += 60_000;
    const stats = await getSystemStats(); // must not block on the pending df
    expect(stats.disk.mounts[0].percent).toBe(50);
    expect(platformMock.readDiskMountsTracked).toHaveBeenCalledTimes(2);
    d.resolve([{ fs: "/dev/disk1", mount: "/", usedBytes: 90, totalBytes: 100, percent: 90, type: "internal" }]);
    await d.promise;

    await vi.waitFor(async () => {
      nowMs += 3_000;
      expect((await getSystemStats()).disk.mounts[0].percent).toBe(90);
    });
  });

  it("keeps measuring the root disk when df hangs on a dead network mount", async () => {
    // GNU df blocks on a hard-mounted NFS share whose NAS is off: every run times out with no output.
    platformMock.readDiskMountsTracked.mockImplementation(() => ({ mounts: Promise.resolve(null), exited: Promise.resolve() }));
    platformMock.readDiskUsage.mockImplementation(async () => ({ usedBytes: 99, totalBytes: 100, percent: 99 }));
    for (let i = 0; i < 5; i++) {
      const stats = await getSystemStats();
      expect(stats.disk).toMatchObject({ usedBytes: 99, totalBytes: 100, percent: 99 });
      nowMs += 60_000;
    }
    expect(platformMock.readDiskUsage).toHaveBeenCalledWith("/");
  });

  it("reports the real root usage on the first reading after a restart even when df is slow", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const df = deferred<Mounts | null>();
      platformMock.readDiskMountsTracked.mockImplementation(() => ({ mounts: df.promise, exited: df.promise.then(() => {}) }));
      platformMock.readDiskUsage.mockImplementation(async () => ({ usedBytes: 93, totalBytes: 100, percent: 93 }));
      const pending = getSystemStats();
      await vi.advanceTimersByTimeAsync(6_000); // past the 5s first-read wait for df
      const stats = await pending;
      // Not 0%: the monitor must not initialise its disk state as "normal" and then
      // "escalate" (re-alert) once df finally answers.
      expect(stats.disk.percent).toBe(93);
      expect(stats.disk.totalBytes).toBe(100);
      df.resolve(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to df's root mount when statfs fails", async () => {
    platformMock.readDiskUsage.mockImplementation(async () => null);
    platformMock.readDiskMountsTracked.mockImplementation(() => ({
      mounts: Promise.resolve([
        { fs: "/dev/sdb1", mount: "/mnt/media", usedBytes: 10, totalBytes: 100, percent: 10, type: "internal" as const },
        { fs: "/dev/sda1", mount: "/", usedBytes: 70, totalBytes: 100, percent: 70, type: "internal" as const },
      ]),
      exited: Promise.resolve(),
    }));
    expect((await getSystemStats()).disk.percent).toBe(70);
  });
  it("never starts a second df while a wedged one is alive, and backs off after failures", async () => {
    const exited = deferred<void>();
    // df timed out (no output) and its child is stuck in the kernel.
    platformMock.readDiskMountsTracked.mockImplementation(() => ({ mounts: Promise.resolve(null), exited: exited.promise }));

    // Ten minutes of SSE ticks.
    for (let i = 0; i < 200; i++) {
      nowMs += 3_000;
      await getSystemStats();
    }
    expect(platformMock.readDiskMountsTracked).toHaveBeenCalledTimes(1);

    // The child finally exits; the next attempt may run.
    exited.resolve();
    await exited.promise;
    await Promise.resolve();
    nowMs += 3_000;
    await getSystemStats();
    expect(platformMock.readDiskMountsTracked).toHaveBeenCalledTimes(2);

    // Second failure → at least 30s backoff before the third df.
    for (let i = 0; i < 9; i++) {
      nowMs += 3_000;
      await getSystemStats();
    }
    expect(platformMock.readDiskMountsTracked).toHaveBeenCalledTimes(2);
    nowMs += 6_000;
    await getSystemStats();
    expect(platformMock.readDiskMountsTracked).toHaveBeenCalledTimes(3);
  });

  it("gives background callers a minute apart the average since the previous sample, not a 250ms snapshot", async () => {
    // Monitor tick: first sample of the process (short measuring window).
    let ticks = 0;
    const samples: Array<{ idle: number; total: number }> = [];
    platformMock.sampleCpuTimes.mockImplementation(() => {
      const next = samples.shift();
      if (next) return next;
      ticks += 100;
      return { idle: ticks * 0.8, total: ticks };
    });
    await getSystemStats();
    const callsAfterFirst = platformMock.sampleCpuTimes.mock.calls.length;

    // 60s later (next monitor / agent-loop tick): the last minute averaged 20%,
    // but Talome's own tick makes the current instant 100% busy.
    const last = { idle: ticks * 0.8, total: ticks };
    const minuteLater = { idle: last.idle + 4_800, total: last.total + 6_000 }; // 20% over the minute
    const burstEnd = { idle: minuteLater.idle, total: minuteLater.total + 25 }; // 250ms at 100%
    samples.push(minuteLater, burstEnd);
    nowMs += 60_000;
    const stats = await getSystemStats();
    expect(stats.cpu.usage).toBe(20);
    // One sample against the kept baseline — no fresh 250ms window.
    expect(platformMock.sampleCpuTimes.mock.calls.length - callsAfterFirst).toBe(1);
  });

  it("takes the CPU sample before spawning its helper processes", async () => {
    await getSystemStats(); // warm the CPU baseline and the disk cache
    vi.clearAllMocks();
    nowMs += 3_000;
    await getSystemStats();
    const cpuAt = platformMock.sampleCpuTimes.mock.invocationCallOrder[0];
    expect(cpuAt).toBeLessThan(platformMock.getAppMemoryUsedAsync.mock.invocationCallOrder[0]);
    expect(cpuAt).toBeLessThan(platformMock.sampleNetworkBytesAsync.mock.invocationCallOrder[0]);
  });
});
