import Docker from "dockerode";
import type { Container, ContainerStats, SystemStats } from "@talome/types";
import os from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  getAppMemoryUsedAsync,
  sampleNetworkBytesAsync,
  readDiskMountsTracked,
  sampleCpuTimes,
  computeCpuUsage,
  type CpuTimesSample,
  type DiskMountInfo,
} from "../platform/index.js";
import { createLimiter, settleWithin } from "../platform/concurrency.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("docker-events");

function detectDockerSocket(): string {
  if (process.env.DOCKER_SOCKET) return process.env.DOCKER_SOCKET;
  if (process.env.DOCKER_HOST?.startsWith("unix://")) return process.env.DOCKER_HOST.slice(7);
  const candidates = [
    join(os.homedir(), ".orbstack/run/docker.sock"),
    join(os.homedir(), ".docker/run/docker.sock"),
    "/var/run/docker.sock",
  ];
  for (const p of candidates) {
    try { if (statSync(p)) return p; } catch {}
  }
  return "/var/run/docker.sock";
}

const detectedSocket = detectDockerSocket();

const docker = new Docker({
  socketPath: detectedSocket,
});

/**
 * Returns true if the Docker daemon is OrbStack (detected via socket path).
 * OrbStack provides built-in *.orb.local DNS and mDNS — Talome can skip
 * running its own CoreDNS and Avahi when OrbStack handles this.
 */
export function isOrbStack(): boolean {
  return detectedSocket.includes(".orbstack/");
}

export function getDockerSocketPath(): string {
  return detectedSocket;
}

// ── Resilience helpers ────────────────────────────────────────────────────

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 2, delay = 1000): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < retries) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ── Container list cache ──────────────────────────────────────────────────
//
// `docker ps` is called from many background jobs (monitor, agent-loop
// detectors, feature stacks, app status refresh) plus polling dashboards.
// A short-lived shared cache with in-flight de-duplication collapses those
// into one Docker round-trip per few seconds.
//
// Staleness rules:
//  - Callers get cached data only when they opt in (`cached` / `maxAgeMs`)
//    or run inside `runWithContainerListCache()`. Plain `listContainers()`
//    stays a fresh read so install/compose flows that create containers
//    outside Talome's helpers never see a pre-mutation list.
//  - Talome's own start/stop/restart/remove/prune helpers and Docker
//    container events invalidate the cache immediately. The events come from
//    a private watcher (see startContainerCacheWatcher) that is independent
//    of the agent loop; while it is disconnected, cached reads fall back to
//    fresh ones so compose-driven changes are never masked.
//  - A generation counter guarantees a request that was in flight when the
//    cache was invalidated never repopulates it with pre-mutation data.

type RawContainerInfo = Docker.ContainerInfo;

export const CONTAINER_LIST_CACHE_TTL_MS = 4_000;

export interface ListContainersOptions {
  /** Always do a new Docker round-trip (never cached, never joins an older in-flight request). */
  fresh?: boolean;
  /** Accept a cached list up to CONTAINER_LIST_CACHE_TTL_MS old. */
  cached?: boolean;
  /** Accept a cached list up to this age in ms (overrides `cached`). */
  maxAgeMs?: number;
}

const containerListScope = new AsyncLocalStorage<{ maxAgeMs: number }>();

let containerListGeneration = 0;
let containerListCache: { at: number; data: RawContainerInfo[] } | null = null;
let containerListInflight: { generation: number; promise: Promise<RawContainerInfo[]> } | null = null;

/**
 * Run `fn` with container-list caching enabled for every `listContainers()`
 * call made inside it (including calls in modules that don't know about the
 * cache, e.g. `refreshAppStatuses`). Use only for read-only background work.
 */
export function runWithContainerListCache<T>(fn: () => Promise<T>, maxAgeMs = CONTAINER_LIST_CACHE_TTL_MS): Promise<T> {
  return containerListScope.run({ maxAgeMs }, fn);
}

/** Drop the cached container list. Called after any container mutation. */
export function invalidateContainerListCache(): void {
  containerListGeneration++;
  containerListCache = null;
}

function resolveListMaxAge(opts: ListContainersOptions | undefined): number {
  if (opts?.fresh) return 0;
  if (typeof opts?.maxAgeMs === "number") return Math.max(0, opts.maxAgeMs);
  if (opts?.cached) return CONTAINER_LIST_CACHE_TTL_MS;
  return containerListScope.getStore()?.maxAgeMs ?? 0;
}

function fetchContainerList(joinInflight: boolean): Promise<RawContainerInfo[]> {
  const generation = containerListGeneration;
  if (joinInflight && containerListInflight && containerListInflight.generation === generation) {
    return containerListInflight.promise;
  }
  const promise = withRetry(() => withTimeout(docker.listContainers({ all: true }), 10_000, "listContainers"))
    .then((data) => {
      // Only cache if nothing mutated containers while the request was in flight.
      if (generation === containerListGeneration) {
        containerListCache = { at: Date.now(), data };
      }
      return data;
    })
    .finally(() => {
      if (containerListInflight?.promise === promise) containerListInflight = null;
    });
  containerListInflight = { generation, promise };
  return promise;
}

/**
 * Raw Docker container list (all containers), shared with the list cache.
 * The returned array is shared between callers — treat it as read-only.
 */
export async function listContainersRaw(opts?: ListContainersOptions): Promise<readonly RawContainerInfo[]> {
  const requestedMaxAgeMs = resolveListMaxAge(opts);
  if (requestedMaxAgeMs > 0) void startContainerCacheWatcher();
  // Without a live event stream, compose-driven changes would go unnoticed:
  // only in-flight de-duplication is allowed then, never a cached list.
  const maxAgeMs = cacheWatcherConnected ? requestedMaxAgeMs : 0;
  if (maxAgeMs > 0 && containerListCache && Date.now() - containerListCache.at <= maxAgeMs) {
    return containerListCache.data;
  }
  return fetchContainerList(requestedMaxAgeMs > 0);
}

export async function listContainers(opts?: ListContainersOptions): Promise<Container[]> {
  const raw = await listContainersRaw(opts);
  return raw.map((c) => ({
    id: c.Id.slice(0, 12),
    name: c.Names[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12),
    image: c.Image,
    status: mapStatus(c.State),
    ports: (c.Ports ?? [])
      .filter((p) => p.PublicPort)
      .map((p) => ({
        host: p.PublicPort!,
        container: p.PrivatePort,
        protocol: (p.Type as "tcp" | "udp") ?? "tcp",
      })),
    created: new Date(c.Created * 1000).toISOString(),
    // Copy so callers mutating labels can't corrupt the shared cache.
    labels: { ...(c.Labels ?? {}) },
  }));
}

// ── Container stats sampler ───────────────────────────────────────────────
//
// `container.stats({ stream: false })` takes ~1-2s per container because the
// daemon waits for a second CPU sample. Samples are cached per container,
// refreshed with bounded concurrency and de-duplicated while in flight.

export const CONTAINER_STATS_TTL_MS = 10_000;
/** Older cached samples are not served as "current" — callers wait for a fresh one. */
const CONTAINER_STATS_MAX_STALE_MS = 60_000;
/** Samples for containers nobody asked about for this long are dropped. */
const CONTAINER_STATS_EVICT_MS = 5 * 60_000;
const CONTAINER_STATS_CONCURRENCY = 4;

const containerStatsLimiter = createLimiter(CONTAINER_STATS_CONCURRENCY);
const containerStatsCache = new Map<string, { stats: ContainerStats; at: number }>();
const containerStatsInflight = new Map<string, StatsInflight>();

async function fetchContainerStats(id: string): Promise<ContainerStats> {
  const container = docker.getContainer(id);
  interface DockerStatsResponse {
    cpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number; online_cpus?: number };
    precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage: number };
    memory_stats: { usage?: number; limit?: number };
    networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  }

  const stats: DockerStatsResponse = await withTimeout(
    container.stats({ stream: false }) as Promise<DockerStatsResponse>,
    10_000,
    `getContainerStats(${id})`,
  );

  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const numCpus = stats.cpu_stats.online_cpus || 1;
  const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

  const memUsage = stats.memory_stats.usage ?? 0;
  const memLimit = stats.memory_stats.limit ?? 1;

  let rxBytes = 0;
  let txBytes = 0;
  if (stats.networks) {
    for (const net of Object.values(stats.networks)) {
      rxBytes += net.rx_bytes ?? 0;
      txBytes += net.tx_bytes ?? 0;
    }
  }

  return {
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    memoryUsageMb: Math.round(memUsage / (1024 * 1024)),
    memoryLimitMb: Math.round(memLimit / (1024 * 1024)),
    networkRxBytes: rxBytes,
    networkTxBytes: txBytes,
  };
}

interface StatsInflight {
  promise: Promise<ContainerStats>;
  /** `started` flips once the task left the limiter queue and is talking to Docker. */
  state: { started: boolean };
  priority: boolean;
}

/**
 * Take a new stats sample (bounded concurrency, joined if already in flight).
 * Priority samples (interactive requests) jump ahead of queued background
 * refreshes; a queued background sample that finds a newer sample in the
 * cache when its turn comes reuses it instead of asking Docker again.
 */
function sampleContainerStats(id: string, opts: { priority?: boolean } = {}): Promise<ContainerStats> {
  const priority = opts.priority === true;
  const existing = containerStatsInflight.get(id);
  // Join unless the caller is interactive and the existing sample is still
  // waiting behind background work in the queue.
  if (existing && (existing.state.started || existing.priority || !priority)) return existing.promise;

  const queuedAt = Date.now();
  const state = { started: false };
  const promise: Promise<ContainerStats> = containerStatsLimiter(async () => {
    state.started = true;
    const cached = containerStatsCache.get(id);
    if (cached && cached.at >= queuedAt) return { stats: cached.stats, reused: true };
    return { stats: await fetchContainerStats(id), reused: false };
  }, { priority })
    .then(({ stats, reused }) => {
      if (!reused) containerStatsCache.set(id, { stats, at: Date.now() });
      return stats;
    })
    .finally(() => {
      if (containerStatsInflight.get(id)?.promise === promise) containerStatsInflight.delete(id);
    });
  containerStatsInflight.set(id, { promise, state, priority });
  return promise;
}

function evictOldContainerStats(now: number): void {
  for (const [id, entry] of containerStatsCache) {
    if (now - entry.at > CONTAINER_STATS_EVICT_MS) containerStatsCache.delete(id);
  }
}

/** Forget cached stats for a container (after stop/restart/remove). */
export function invalidateContainerStats(id?: string): void {
  if (id === undefined) containerStatsCache.clear();
  else containerStatsCache.delete(id);
}

/** Upper bound for an interactive stats request, including time spent queued. */
const CONTAINER_STATS_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Current stats for one container: a cached sample younger than
 * CONTAINER_STATS_TTL_MS when there is one, otherwise a new sample that
 * jumps ahead of queued background refreshes. Concurrent callers for the
 * same container share one Docker request, at most
 * CONTAINER_STATS_CONCURRENCY samples run at once across the process, and
 * the whole wait (queue + Docker) is bounded.
 */
export async function getContainerStats(id: string): Promise<ContainerStats> {
  const cached = getCachedContainerStats(id);
  if (cached) return cached;
  return withTimeout(
    sampleContainerStats(id, { priority: true }),
    CONTAINER_STATS_REQUEST_TIMEOUT_MS,
    `getContainerStats(${id})`,
  );
}

/** Cached stats sample if one exists and is at most `maxAgeMs` old. */
export function getCachedContainerStats(id: string, maxAgeMs = CONTAINER_STATS_TTL_MS): ContainerStats | undefined {
  const entry = containerStatsCache.get(id);
  if (!entry || Date.now() - entry.at > maxAgeMs) return undefined;
  return entry.stats;
}

/**
 * Stale-while-revalidate stats for many containers:
 *  - a cached sample younger than the TTL is returned as-is;
 *  - an older (but not ancient) sample is returned immediately while a
 *    background refresh is kicked off;
 *  - containers with no usable sample are sampled now, waiting at most
 *    `waitMs` — those still pending are simply omitted from the result.
 */
export async function getContainerStatsBatch(
  ids: readonly string[],
  opts: { waitMs?: number } = {},
): Promise<Map<string, ContainerStats>> {
  const waitMs = opts.waitMs ?? 3_000;
  const now = Date.now();
  evictOldContainerStats(now);

  const result = new Map<string, ContainerStats>();
  const pending: Array<[string, Promise<ContainerStats>]> = [];

  for (const id of ids) {
    const entry = containerStatsCache.get(id);
    const age = entry ? now - entry.at : Infinity;
    if (entry && age <= CONTAINER_STATS_MAX_STALE_MS) {
      result.set(id, entry.stats);
      if (age > CONTAINER_STATS_TTL_MS) {
        sampleContainerStats(id).catch(() => { /* keep serving the last sample */ });
      }
    } else {
      pending.push([id, sampleContainerStats(id)]);
    }
  }

  if (pending.length > 0) {
    await Promise.all(
      pending.map(async ([id, promise]) => {
        const stats = await settleWithin(promise, waitMs, null);
        if (stats) result.set(id, stats);
      }),
    );
  }

  return result;
}

async function mutateContainer(id: string, op: () => Promise<unknown>): Promise<void> {
  invalidateContainerListCache();
  try {
    await op();
  } finally {
    // Invalidate again after the daemon applied the change so no reader
    // (including one that started mid-mutation) sees the old state.
    invalidateContainerListCache();
    invalidateContainerStats(id);
  }
}

export async function startContainer(id: string): Promise<void> {
  await mutateContainer(id, () => docker.getContainer(id).start());
}

export async function stopContainer(id: string): Promise<void> {
  await mutateContainer(id, () => docker.getContainer(id).stop());
}

export async function restartContainer(id: string): Promise<void> {
  await mutateContainer(id, () => docker.getContainer(id).restart());
}

export async function removeContainer(id: string): Promise<void> {
  await mutateContainer(id, async () => {
    const container = docker.getContainer(id);
    try {
      await container.stop();
    } catch {}
    await container.remove({ force: true });
  });
}

export async function getContainerLogs(
  id: string,
  tail = 200,
  opts: { since?: number } = {},
): Promise<string> {
  const container = docker.getContainer(id);
  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
    // Unix seconds; lets pollers fetch only lines written since their last check.
    ...(opts.since !== undefined ? { since: Math.max(0, Math.floor(opts.since)) } : {}),
  });
  return stripDockerHeaders(buffer.toString("utf-8"));
}

// ── System stats ──────────────────────────────────────────────────────────────
//
// Everything here is async: no execSync on the request path. The cache TTL
// is just under the 3s SSE tick (routes/stats-stream.ts) so every tick gets
// a new sample while concurrent SSE clients / monitor / tools share it.

const STATS_CACHE_TTL_MS = 2_500;
let cachedStats: SystemStats | null = null;
let cachedStatsAt = 0;
let systemStatsInflight: Promise<SystemStats> | null = null;

export async function getSystemStats(): Promise<SystemStats> {
  const now = Date.now();
  if (cachedStats && now - cachedStatsAt < STATS_CACHE_TTL_MS) {
    return cachedStats;
  }
  if (systemStatsInflight) return systemStatsInflight;
  const promise = getSystemStatsImpl()
    .then((stats) => {
      cachedStats = stats;
      cachedStatsAt = Date.now();
      return stats;
    })
    .finally(() => {
      if (systemStatsInflight === promise) systemStatsInflight = null;
    });
  systemStatsInflight = promise;
  return promise;
}

async function getSystemStatsImpl(): Promise<SystemStats> {
  const cpus = os.cpus();
  const totalMem = os.totalmem();

  // On macOS, use vm_stat to get real app memory (excludes reclaimable file cache).
  // On Linux, os.freemem() already excludes buffers/cache (reads from MemAvailable).
  const [appMemUsed, diskInfo, network, cpuUsage] = await Promise.all([
    getAppMemoryUsedAsync().catch(() => null),
    getDiskInfo(),
    getNetworkThroughput(),
    getCpuUsage(),
  ]);
  const usedMem = appMemUsed ?? (totalMem - os.freemem());

  return {
    cpu: {
      usage: cpuUsage,
      cores: cpus.length,
      model: cpus[0]?.model ?? "unknown",
    },
    memory: {
      usedBytes: usedMem,
      totalBytes: totalMem,
      percent: Math.round((usedMem / totalMem) * 1000) / 10,
    },
    disk: diskInfo,
    network,
    uptime: Math.floor(os.uptime()),
    platform: os.platform() as "darwin" | "linux",
    arch: os.arch() as "arm64" | "x64",
    hostname: os.hostname(),
  };
}

// ── Disk (df) — stale-while-revalidate ──────────────────────────────────────
// `df` can stall for a long time on unreachable SMB/NFS mounts. It runs
// async with a timeout and callers get the last known result immediately
// while a refresh happens in the background.
//
// A df blocked in uninterruptible I/O outlives its timeout (the kernel holds
// it until the mount answers), so the "one at a time" rule is tied to the
// child's real exit, not to the timeout: no new df is spawned while the
// previous one is still alive. Failed/timed-out reads also back off
// exponentially so a dead mount is not re-probed on every stats tick.

interface DiskInfo {
  usedBytes: number;
  totalBytes: number;
  percent: number;
  mounts: DiskMountInfo[];
}

const DISK_REFRESH_MS = 15_000;
const DISK_FIRST_WAIT_MS = 5_000;
const DISK_DF_TIMEOUT_MS = 5_000;
/** Upper bound for the retry backoff after consecutive df failures. */
const DISK_BACKOFF_MAX_MS = 5 * 60_000;

let diskCache: { info: DiskInfo; at: number } | null = null;
/** Result of the latest df run (settles within the timeout). */
let diskRefresh: Promise<DiskInfo | null> | null = null;
/** True from spawn until the df child has really exited. */
let dfChildAlive = false;
let diskFailures = 0;
let diskNextAttemptAt = 0;

function summarizeMounts(mounts: DiskMountInfo[]): DiskInfo {
  if (mounts.length === 0) return { usedBytes: 0, totalBytes: 0, percent: 0, mounts: [] };
  const rootMount = mounts.find((m) => m.mount === "/") ?? mounts[0];
  return {
    usedBytes: rootMount.usedBytes,
    totalBytes: rootMount.totalBytes,
    percent: rootMount.percent,
    mounts,
  };
}

function recordDiskFailure(): void {
  diskFailures++;
  const backoff = Math.min(DISK_REFRESH_MS * 2 ** (diskFailures - 1), DISK_BACKOFF_MAX_MS);
  diskNextAttemptAt = Date.now() + backoff;
}

function refreshDiskInfo(): Promise<DiskInfo | null> {
  // Never stack df processes: a wedged child keeps this closed until it exits.
  if (dfChildAlive) return diskRefresh ?? Promise.resolve(null);
  if (Date.now() < diskNextAttemptAt) return Promise.resolve(null);

  let run: ReturnType<typeof readDiskMountsTracked>;
  try {
    run = readDiskMountsTracked(DISK_DF_TIMEOUT_MS);
  } catch {
    recordDiskFailure();
    return Promise.resolve(null);
  }
  dfChildAlive = true;
  const markExited = () => {
    if (diskRefresh === promise) dfChildAlive = false;
  };
  const promise = run.mounts
    .then((mounts) => {
      if (!mounts) {
        recordDiskFailure();
        return null;
      }
      diskFailures = 0;
      diskNextAttemptAt = 0;
      const info = summarizeMounts(mounts);
      diskCache = { info, at: Date.now() };
      return info;
    })
    .catch(() => {
      recordDiskFailure();
      return null;
    });
  diskRefresh = promise;
  run.exited.then(markExited, markExited);
  return promise;
}

async function getDiskInfo(): Promise<DiskInfo> {
  const cached = diskCache;
  if (cached && Date.now() - cached.at < DISK_REFRESH_MS) return cached.info;
  const refresh = refreshDiskInfo();
  if (cached) return cached.info; // serve stale, refresh in background
  const info = await settleWithin(refresh, DISK_FIRST_WAIT_MS, null);
  return info ?? { usedBytes: 0, totalBytes: 0, percent: 0, mounts: [] };
}

// ── CPU — real utilisation from deltas between samples ─────────────────────
// os.cpus() ticks are cumulative since boot; (1 - idle/total) over them is
// the lifetime average, not current load. We diff consecutive samples.

/** Baselines older than this are replaced by a short fresh measurement window. */
const CPU_BASELINE_MAX_AGE_MS = 30_000;
const CPU_MEASURE_WINDOW_MS = 250;

let lastCpuSample: (CpuTimesSample & { at: number }) | null = null;
let lastCpuUsage = 0;

async function getCpuUsage(): Promise<number> {
  let prev = lastCpuSample;
  if (!prev || Date.now() - prev.at > CPU_BASELINE_MAX_AGE_MS) {
    prev = { ...sampleCpuTimes(), at: Date.now() };
    await new Promise((r) => setTimeout(r, CPU_MEASURE_WINDOW_MS));
  }
  const curr = { ...sampleCpuTimes(), at: Date.now() };
  const usage = computeCpuUsage(prev, curr);
  // Keep the old baseline when no ticks elapsed so the next call measures
  // a real window instead of a zero-length one.
  if (usage !== null) {
    lastCpuUsage = usage;
    lastCpuSample = curr;
  } else if (!lastCpuSample) {
    lastCpuSample = prev;
  }
  return lastCpuUsage;
}

let lastNetSample: { time: number; rx: number; tx: number } | null = null;
let lastNetResult = { rxBytesPerSec: 0, txBytesPerSec: 0 };

async function getNetworkThroughput(): Promise<{ rxBytesPerSec: number; txBytesPerSec: number }> {
  const sample = await sampleNetworkBytesAsync();
  if (!sample) return lastNetResult;

  const now = Date.now();
  if (lastNetSample) {
    const dt = (now - lastNetSample.time) / 1000;
    if (dt > 0) {
      lastNetResult = {
        rxBytesPerSec: Math.max(0, Math.round((sample.rx - lastNetSample.rx) / dt)),
        txBytesPerSec: Math.max(0, Math.round((sample.tx - lastNetSample.tx) / dt)),
      };
    }
  }
  lastNetSample = { time: now, rx: sample.rx, tx: sample.tx };
  return lastNetResult;
}

/** Reset internal caches — test helper. */
export function __resetDockerClientCachesForTests(): void {
  stopContainerCacheWatcher();
  invalidateContainerListCache();
  containerListInflight = null;
  containerStatsCache.clear();
  containerStatsInflight.clear();
  cachedStats = null;
  cachedStatsAt = 0;
  systemStatsInflight = null;
  diskCache = null;
  diskRefresh = null;
  dfChildAlive = false;
  diskFailures = 0;
  diskNextAttemptAt = 0;
  lastCpuSample = null;
  lastCpuUsage = 0;
  lastNetSample = null;
  lastNetResult = { rxBytesPerSec: 0, txBytesPerSec: 0 };
}

function mapStatus(
  state: string
): Container["status"] {
  const map: Record<string, Container["status"]> = {
    running: "running",
    exited: "exited",
    paused: "paused",
    restarting: "restarting",
    created: "created",
    removing: "stopped",
    dead: "stopped",
  };
  return map[state.toLowerCase()] ?? "stopped";
}

function stripDockerHeaders(raw: string): string {
  return raw.replace(/[\x00-\x08]/g, "").replace(/\r/g, "");
}

export interface ContainerInspect {
  restartCount: number;
  state: {
    status: string;
    startedAt: string;
    finishedAt: string;
  };
  mounts: Array<{
    type: string;
    source: string;
    destination: string;
    rw: boolean;
  }>;
  labels: Record<string, string>;
}

export async function inspectContainer(id: string): Promise<ContainerInspect> {
  const info = await withRetry(() => docker.getContainer(id).inspect());
  const infoWithRestart = info as typeof info & { RestartCount?: number };
  return {
    restartCount: infoWithRestart.RestartCount ?? 0,
    state: {
      status: info.State.Status,
      startedAt: info.State.StartedAt,
      finishedAt: info.State.FinishedAt,
    },
    mounts: (info.Mounts ?? []).map((m) => ({
      type: m.Type ?? "bind",
      source: m.Source ?? "",
      destination: m.Destination ?? "",
      rw: m.RW ?? true,
    })),
    labels: info.Config?.Labels ?? {},
  };
}

export async function listImages(): Promise<
  Array<{
    id: string;
    repoTags: string[];
    size: number;
    created: string;
  }>
> {
  const images = await docker.listImages({ all: false });
  return images.map((img) => ({
    id: (img.Id ?? "").replace("sha256:", "").slice(0, 12),
    repoTags: img.RepoTags ?? [],
    size: img.Size ?? 0,
    created: new Date((img.Created ?? 0) * 1000).toISOString(),
  }));
}

export async function listNetworks(): Promise<
  Array<{
    id: string;
    name: string;
    driver: string;
    scope: string;
    containers: string[];
  }>
> {
  const networks = await docker.listNetworks();
  return networks.map((n) => ({
    id: (n.Id ?? "").slice(0, 12),
    name: n.Name ?? "",
    driver: n.Driver ?? "",
    scope: n.Scope ?? "",
    containers: Object.keys(n.Containers ?? {}),
  }));
}

export async function createNetwork(name: string, driver = "bridge"): Promise<{ id: string }> {
  const network = await docker.createNetwork({ Name: name, Driver: driver });
  return { id: network.id ?? "" };
}

export async function connectContainerToNetwork(networkName: string, containerIdOrName: string): Promise<void> {
  const network = docker.getNetwork(networkName);
  await network.connect({ Container: containerIdOrName });
}

export async function disconnectContainerFromNetwork(networkName: string, containerIdOrName: string): Promise<void> {
  const network = docker.getNetwork(networkName);
  await network.disconnect({ Container: containerIdOrName });
}

export async function removeNetwork(networkName: string): Promise<void> {
  const network = docker.getNetwork(networkName);
  await network.remove();
}

export async function pruneResources(
  targets: Array<"containers" | "images" | "volumes" | "networks">
): Promise<Record<string, { spaceReclaimed?: number; count?: number }>> {
  const results: Record<string, { spaceReclaimed?: number; count?: number }> = {};
  for (const target of targets) {
    switch (target) {
      case "containers": {
        const r = await docker.pruneContainers();
        invalidateContainerListCache();
        results.containers = {
          spaceReclaimed: r.SpaceReclaimed ?? 0,
          count: r.ContainersDeleted?.length ?? 0,
        };
        break;
      }
      case "images": {
        const r = await docker.pruneImages();
        results.images = {
          spaceReclaimed: r.SpaceReclaimed ?? 0,
          count: r.ImagesDeleted?.length ?? 0,
        };
        break;
      }
      case "volumes": {
        const r = await docker.pruneVolumes();
        results.volumes = {
          spaceReclaimed: r.SpaceReclaimed ?? 0,
          count: r.VolumesDeleted?.length ?? 0,
        };
        break;
      }
      case "networks": {
        const r = await docker.pruneNetworks();
        results.networks = {
          count: r.NetworksDeleted?.length ?? 0,
        };
        break;
      }
    }
  }
  return results;
}

export async function execInContainer(
  id: string,
  cmd: string[]
): Promise<{ exitCode: number; output: string }> {
  const container = docker.getContainer(id);
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", async () => {
      try {
        const inspect = await exec.inspect();
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve({
          exitCode: inspect.ExitCode ?? -1,
          output: stripDockerHeaders(raw).trim(),
        });
      } catch (err) {
        reject(err);
      }
    });
    stream.on("error", reject);
  });
}

// ── Inter-container connectivity check ───────────────────────────────────────

export interface ContainerPair {
  from: string;
  to: string;
  port?: number;
}

export interface ConnectivityResult {
  from: string;
  to: string;
  dnsResolvable: boolean;
  reachable: boolean;
  error?: string;
  latency?: number;
}

export interface ConnectivityReport {
  results: ConnectivityResult[];
  timestamp: string;
}

/**
 * Test network connectivity between container pairs using DNS resolution
 * and TCP/HTTP reachability probes executed inside the 'from' container.
 *
 * Each pair is tested with a 5-second timeout to avoid blocking health checks.
 * The 'to' name is used as the Docker internal DNS hostname. If port is not
 * specified, the first exposed TCP port of the target container is used.
 */
export async function checkInterContainerConnectivity(
  pairs: ContainerPair[],
): Promise<ConnectivityReport> {
  const allContainers = await listContainers();
  const containerByName = new Map(allContainers.map((c) => [c.name, c]));

  const results = await Promise.all(
    pairs.map((pair) => testPairConnectivity(pair, containerByName)),
  );

  return {
    results,
    timestamp: new Date().toISOString(),
  };
}

async function testPairConnectivity(
  pair: ContainerPair,
  containerByName: Map<string, Container>,
): Promise<ConnectivityResult> {
  const fromContainer = containerByName.get(pair.from);
  const toContainer = containerByName.get(pair.to);

  if (!fromContainer) {
    return { from: pair.from, to: pair.to, dnsResolvable: false, reachable: false, error: `Container '${pair.from}' not found` };
  }
  if (fromContainer.status !== "running") {
    return { from: pair.from, to: pair.to, dnsResolvable: false, reachable: false, error: `Container '${pair.from}' is not running (${fromContainer.status})` };
  }
  if (!toContainer) {
    return { from: pair.from, to: pair.to, dnsResolvable: false, reachable: false, error: `Container '${pair.to}' not found` };
  }
  if (toContainer.status !== "running") {
    return { from: pair.from, to: pair.to, dnsResolvable: false, reachable: false, error: `Container '${pair.to}' is not running (${toContainer.status})` };
  }

  // Resolve target port: explicit > first exposed TCP port > fallback 80
  const targetPort =
    pair.port ??
    toContainer.ports.find((p) => p.protocol === "tcp")?.container ??
    80;

  const targetHost = pair.to;

  // Validate hostname/port to prevent shell injection — only allow DNS-safe chars
  const DNS_RE = /^[a-zA-Z0-9._-]+$/;
  if (!DNS_RE.test(targetHost)) {
    return { from: pair.from, to: pair.to, dnsResolvable: false, reachable: false, error: `Invalid hostname: ${targetHost}` };
  }
  if (targetPort < 1 || targetPort > 65535 || !Number.isInteger(targetPort)) {
    return { from: pair.from, to: pair.to, dnsResolvable: false, reachable: false, error: `Invalid port: ${targetPort}` };
  }

  // Step 1: DNS resolution check
  // SAFETY: targetHost is validated above by DNS_RE (alphanumeric, dots, hyphens only)
  // and targetPort is validated as integer 1-65535, so shell interpolation is safe.
  let dnsResolvable = false;
  try {
    const dnsResult = await withTimeout(
      execInContainer(fromContainer.id, ["sh", "-c", `getent hosts ${targetHost} 2>/dev/null || nslookup ${targetHost} 2>/dev/null | grep -i address`]),
      5_000,
      `dns-check(${pair.from}->${pair.to})`,
    );
    dnsResolvable = dnsResult.exitCode === 0 && dnsResult.output.length > 0;
  } catch {
    // DNS check timed out or failed
  }

  // Step 2: TCP/HTTP reachability check with latency measurement
  let reachable = false;
  let latency: number | undefined;
  let error: string | undefined;

  try {
    // Use shell-level time measurement since we exec inside the container.
    // Try wget first (available in most alpine/busybox images), fall back to
    // /dev/tcp (bash built-in), then plain timeout+sh for TCP probe.
    const probeCmd = [
      "sh", "-c",
      `START=$(date +%s%N 2>/dev/null || echo 0); ` +
      `if command -v wget >/dev/null 2>&1; then ` +
      `  wget -q -O /dev/null --timeout=4 "http://${targetHost}:${targetPort}/" 2>/dev/null; RC=$?; ` +
      `elif command -v curl >/dev/null 2>&1; then ` +
      `  curl -sf --connect-timeout 4 --max-time 4 "http://${targetHost}:${targetPort}/" -o /dev/null 2>/dev/null; RC=$?; ` +
      `else ` +
      `  (echo > /dev/tcp/${targetHost}/${targetPort}) 2>/dev/null; RC=$?; ` +
      `fi; ` +
      `END=$(date +%s%N 2>/dev/null || echo 0); ` +
      `if [ "$START" != "0" ] && [ "$END" != "0" ]; then ` +
      `  echo "LATENCY:$(( (END - START) / 1000000 ))"; ` +
      `fi; ` +
      `exit $RC`,
    ];

    const probeResult = await withTimeout(
      execInContainer(fromContainer.id, probeCmd),
      5_000,
      `probe(${pair.from}->${pair.to}:${targetPort})`,
    );

    // wget returns 0 on success, curl returns 0 on success; non-zero = unreachable
    // However, HTTP 4xx/5xx may still mean the service is reachable at TCP level
    // We treat exit code 0 OR any HTTP response (even error page) as reachable
    reachable = probeResult.exitCode === 0;

    // Even if wget/curl failed with a non-zero code, if we got output that
    // looks like an HTTP response, the service is TCP-reachable
    if (!reachable && probeResult.output.includes("LATENCY:")) {
      // If we measured latency, TCP connection at least worked
      reachable = true;
    }

    // Extract latency from output
    const latencyMatch = probeResult.output.match(/LATENCY:(\d+)/);
    if (latencyMatch) {
      latency = parseInt(latencyMatch[1], 10);
    }

    if (!reachable) {
      error = `TCP probe to ${targetHost}:${targetPort} failed (exit ${probeResult.exitCode})`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    from: pair.from,
    to: pair.to,
    dnsResolvable,
    reachable,
    ...(error ? { error } : {}),
    ...(latency !== undefined ? { latency } : {}),
  };
}

// ── Real-time Docker Event Stream ───────────────────────────────────────────

export interface DockerEvent {
  type: "container" | "image" | "network" | "volume";
  action: string;
  actorId: string;
  actorName: string;
  actorImage?: string;
  time: number;
}

export type DockerEventHandler = (event: DockerEvent) => void;

let eventStream: NodeJS.ReadableStream | null = null;
let eventStreamCleanup: (() => void) | null = null;

/** Actions forwarded to the subscriber (the historical server-side filter). */
const FORWARDED_EVENT_ACTIONS = new Set(["start", "stop", "die", "restart", "destroy", "oom", "health_status"]);
/** Actions that change what `docker ps` returns — they invalidate the list cache. */
const LIST_INVALIDATING_ACTIONS = new Set([
  "create", "start", "stop", "die", "restart", "destroy", "kill", "pause", "unpause", "rename", "oom",
]);

/**
 * Keep Talome's container caches coherent with daemon state. Returns true
 * when the event should also be forwarded to the subscriber.
 */
function applyDockerEventToCaches(action: string, actorId: string): boolean {
  // health_status arrives as "health_status: healthy" — compare the prefix.
  const base = action.split(":")[0].trim();
  if (LIST_INVALIDATING_ACTIONS.has(base)) {
    invalidateContainerListCache();
    if (base === "die" || base === "destroy" || base === "stop") invalidateContainerStats(actorId);
  }
  return FORWARDED_EVENT_ACTIONS.has(base);
}

/**
 * Build a chunk handler for the daemon's event stream. The daemon sends
 * newline-delimited JSON; one chunk can carry several events or a partial
 * one, so input is buffered and split on newlines.
 */
function createDockerEventParser(onEvent: (event: DockerEvent) => void): (chunk: Buffer) => void {
  let pending = "";
  return (chunk: Buffer) => {
    pending += chunk.toString("utf-8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    const parsed: unknown[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { parsed.push(JSON.parse(line)); } catch { /* Malformed event — skip */ }
    }
    // A complete event without a trailing newline: parse it now; a
    // partial one fails to parse and stays buffered for the next chunk.
    if (pending.trim()) {
      try {
        parsed.push(JSON.parse(pending));
        pending = "";
      } catch { /* incomplete — keep buffering */ }
    }
    for (const item of parsed) {
      try {
        const raw = item as {
          Type?: DockerEvent["type"];
          Action?: string;
          status?: string;
          id?: string;
          from?: string;
          time?: number;
          Actor?: { ID?: string; Attributes?: Record<string, string> };
        };
        onEvent({
          type: raw.Type ?? "container",
          action: raw.Action ?? raw.status ?? "",
          actorId: (raw.Actor?.ID ?? raw.id ?? "").slice(0, 12),
          actorName: raw.Actor?.Attributes?.name ?? "",
          actorImage: raw.Actor?.Attributes?.image ?? raw.from ?? "",
          time: raw.time ?? Math.floor(Date.now() / 1000),
        });
      } catch {
        // Malformed event — skip
      }
    }
    // Guard against unbounded growth on a garbage stream.
    if (pending.length > 1_000_000) pending = "";
  };
}

function destroyEventStream(stream: NodeJS.ReadableStream): void {
  try {
    const s = stream as NodeJS.ReadableStream & { destroy?: () => void };
    if (typeof s.destroy === "function") s.destroy();
  } catch { /* ignore */ }
}

// ── Container cache watcher ─────────────────────────────────────────────────
//
// App lifecycle (compose up/stop/restart, installs, updates) runs through
// `docker compose` rather than the helpers above, so the list cache relies on
// Docker events to notice those changes. This private, invalidation-only
// subscription is independent of the agent loop (which may be disabled) and
// starts on the first cached read. Cached reads are honoured only while it is
// connected; otherwise callers get a fresh `docker ps`.

let cacheWatcherStop: (() => void) | null = null;
let cacheWatcherReady: Promise<void> | null = null;
let cacheWatcherConnected = false;

/**
 * Start the invalidation-only Docker event subscription (idempotent). The
 * returned promise settles after the first connection attempt.
 */
export function startContainerCacheWatcher(): Promise<void> {
  if (cacheWatcherReady) return cacheWatcherReady;
  let aborted = false;
  let current: NodeJS.ReadableStream | null = null;
  let markReady!: () => void;
  cacheWatcherReady = new Promise<void>((resolve) => { markReady = resolve; });

  const scheduleReconnect = (ms: number) => {
    const timer = setTimeout(() => { if (!aborted) void connect(); }, ms);
    timer.unref?.();
  };

  const connect = async (): Promise<void> => {
    try {
      const stream = await docker.getEvents({
        filters: { type: ["container"], event: [...LIST_INVALIDATING_ACTIONS] },
      });
      if (aborted) {
        destroyEventStream(stream);
        return;
      }
      current = stream;
      const parse = createDockerEventParser((event) => { applyDockerEventToCaches(event.action, event.actorId); });
      stream.on("data", (chunk: Buffer) => {
        if (!aborted && current === stream) parse(chunk);
      });
      const onLost = () => {
        if (current !== stream) return;
        current = null;
        cacheWatcherConnected = false;
        // Events may have been missed — don't trust the cache.
        invalidateContainerListCache();
        if (!aborted) scheduleReconnect(5_000);
      };
      stream.on("error", onLost);
      stream.on("end", onLost);
      stream.on("close", onLost);
      // Changes made before the stream was up were never seen as events.
      invalidateContainerListCache();
      cacheWatcherConnected = true;
    } catch (err) {
      cacheWatcherConnected = false;
      log.debug("Container cache watcher could not subscribe, retrying in 10s", err);
      if (!aborted) scheduleReconnect(10_000);
    } finally {
      markReady();
    }
  };

  cacheWatcherStop = () => {
    aborted = true;
    cacheWatcherConnected = false;
    if (current) destroyEventStream(current);
    current = null;
  };
  void connect();
  return cacheWatcherReady;
}

/** Stop the cache watcher (shutdown / tests). Cached reads become fresh reads. */
export function stopContainerCacheWatcher(): void {
  cacheWatcherStop?.();
  cacheWatcherStop = null;
  cacheWatcherReady = null;
  cacheWatcherConnected = false;
}

/** Whether cached container-list reads are currently trusted. */
export function isContainerCacheWatcherConnected(): boolean {
  return cacheWatcherConnected;
}

/**
 * Subscribe to real-time Docker events via the daemon's event stream.
 * Returns a cleanup function to stop listening.
 *
 * This replaces polling for container state changes — crashes, restarts,
 * starts, and stops are detected in seconds instead of 60s.
 */
export function subscribeDockerEvents(handler: DockerEventHandler): () => void {
  if (eventStream) {
    // Already subscribed — tear down the old one first
    eventStreamCleanup?.();
  }

  let aborted = false;

  const start = async () => {
    try {
      const stream = await docker.getEvents({
        filters: {
          type: ["container"],
          event: [...new Set([...FORWARDED_EVENT_ACTIONS, ...LIST_INVALIDATING_ACTIONS])],
        },
      });

      eventStream = stream;

      const parse = createDockerEventParser((event) => {
        if (applyDockerEventToCaches(event.action, event.actorId)) handler(event);
      });
      stream.on("data", (chunk: Buffer) => {
        if (aborted) return;
        parse(chunk);
      });

      stream.on("error", (err: Error) => {
        if (aborted) return;
        // Events may be missed until we reconnect — don't trust the cache.
        invalidateContainerListCache();
        log.error("Stream error, will reconnect", err.message);
        // Reconnect after a brief delay
        setTimeout(() => {
          if (!aborted) void start();
        }, 5000);
      });

      stream.on("end", () => {
        if (aborted) return;
        log.info("Stream ended, reconnecting");
        setTimeout(() => {
          if (!aborted) void start();
        }, 3000);
      });

      log.info("Subscribed to real-time Docker events");
    } catch (err) {
      if (aborted) return;
      log.error("Failed to subscribe, retrying in 10s", err);
      setTimeout(() => {
        if (!aborted) void start();
      }, 10_000);
    }
  };

  void start();

  const cleanup = () => {
    aborted = true;
    if (eventStream) {
      try {
        if ("destroy" in eventStream && typeof (eventStream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === "function") {
          (eventStream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
        }
      } catch { /* ignore */ }
      eventStream = null;
    }
    eventStreamCleanup = null;
    log.info("Unsubscribed from Docker events");
  };

  eventStreamCleanup = cleanup;
  return cleanup;
}

/**
 * Lightweight Docker daemon health check via the /_ping endpoint.
 * Much cheaper than listContainers() — no JSON parsing, no container enumeration.
 */
export async function checkDockerConnection(): Promise<{ ok: boolean; error?: string }> {
  try {
    await withTimeout(docker.ping(), 3_000, "Docker ping");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Periodic Docker Pruning ───────────────────────────────────────────────────

let pruneInterval: ReturnType<typeof setInterval> | null = null;

export function startPeriodicPrune(intervalMs = 24 * 60 * 60 * 1000): () => void {
  const pruneLog = createLogger("docker-prune");

  const doPrune = async () => {
    try {
      const results = await pruneResources(["containers", "images"]);
      const reclaimedMb = Math.round(
        ((results.containers?.spaceReclaimed ?? 0) + (results.images?.spaceReclaimed ?? 0)) / (1024 * 1024)
      );
      if (reclaimedMb > 0 || (results.containers?.count ?? 0) > 0 || (results.images?.count ?? 0) > 0) {
        pruneLog.info(`Pruned ${results.containers?.count ?? 0} containers, ${results.images?.count ?? 0} images (${reclaimedMb}MB reclaimed)`);
      }
    } catch (err) {
      pruneLog.warn("Periodic prune failed", err);
    }
  };

  // Run first prune after 5 minutes, then every intervalMs
  const initialTimer = setTimeout(() => {
    void doPrune();
    pruneInterval = setInterval(() => void doPrune(), intervalMs);
  }, 5 * 60 * 1000);

  return () => {
    clearTimeout(initialTimer);
    if (pruneInterval) clearInterval(pruneInterval);
  };
}

export { docker };
