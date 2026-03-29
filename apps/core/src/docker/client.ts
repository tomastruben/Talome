import Docker from "dockerode";
import type { Container, ContainerStats, SystemStats } from "@talome/types";
import os from "node:os";
import { execSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { getAppMemoryUsed, sampleNetworkBytes as platformSampleNetworkBytes } from "../platform/index.js";
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

export async function listContainers(): Promise<Container[]> {
  const raw = await withRetry(() => withTimeout(docker.listContainers({ all: true }), 10_000, "listContainers"));
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
    labels: c.Labels ?? {},
  }));
}

export async function getContainerStats(id: string): Promise<ContainerStats> {
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

export async function startContainer(id: string): Promise<void> {
  await docker.getContainer(id).start();
}

export async function stopContainer(id: string): Promise<void> {
  await docker.getContainer(id).stop();
}

export async function restartContainer(id: string): Promise<void> {
  await docker.getContainer(id).restart();
}

export async function removeContainer(id: string): Promise<void> {
  const container = docker.getContainer(id);
  try {
    await container.stop();
  } catch {}
  await container.remove({ force: true });
}

export async function getContainerLogs(
  id: string,
  tail = 200
): Promise<string> {
  const container = docker.getContainer(id);
  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
  });
  return stripDockerHeaders(buffer.toString("utf-8"));
}

// getAppMemoryUsed imported from platform/index.ts

// ── Stats caching ─────────────────────────────────────────────────────────────
let cachedStats: SystemStats | null = null;
let cachedStatsAt = 0;
const STATS_CACHE_TTL_MS = 5_000;

export async function getSystemStats(): Promise<SystemStats> {
  const now = Date.now();
  if (cachedStats && now - cachedStatsAt < STATS_CACHE_TTL_MS) {
    return cachedStats;
  }
  const stats = getSystemStatsImpl();
  cachedStats = stats;
  cachedStatsAt = now;
  return stats;
}

function getSystemStatsImpl(): SystemStats {
  const cpus = os.cpus();
  const totalMem = os.totalmem();

  // On macOS, use vm_stat to get real app memory (excludes reclaimable file cache).
  // On Linux, os.freemem() already excludes buffers/cache (reads from MemAvailable).
  const appMemUsed = getAppMemoryUsed();
  const usedMem = appMemUsed ?? (totalMem - os.freemem());

  const PSEUDO_FS = new Set([
    "tmpfs", "devtmpfs", "sysfs", "proc", "udev", "devfs", "autofs",
    "squashfs", "nsfs", "cgroup", "cgroup2", "pstore",
    "securityfs", "debugfs", "tracefs", "hugetlbfs", "mqueue",
    "fusectl", "binfmt_misc", "configfs", "efivarfs",
  ]);

  function getMountType(fs: string, mount: string): "internal" | "external" | "network" {
    const netFs = ["nfs", "nfs4", "cifs", "smb", "smbfs", "afpfs", "ftp", "sshfs", "davfs"];
    if (netFs.some((n) => fs.toLowerCase().startsWith(n))) return "network";
    if (fs.includes(":/")) return "network";
    if (mount.startsWith("/Volumes/") || mount.startsWith("/media/") || mount.startsWith("/run/media/")) return "external";
    return "internal";
  }

  interface MountInfo {
    fs: string;
    mount: string;
    usedBytes: number;
    totalBytes: number;
    percent: number;
    type: "internal" | "external" | "network";
  }
  let diskInfo = { usedBytes: 0, totalBytes: 0, percent: 0, mounts: [] as MountInfo[] };
  try {
    // -P uses POSIX format: fixed 5 columns then mount path (handles spaces in names)
    const dfOutput = execSync("df -Pk", { encoding: "utf-8" });
    const lines = dfOutput.trim().split("\n").slice(1);
    const mounts: MountInfo[] = [];

    for (const line of lines) {
      // POSIX df -P columns: Filesystem 1K-blocks Used Available Capacity% MountedOn
      const match = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/);
      if (!match) continue;
      const [, fs, totalKbStr, , availKbStr, mount] = match;
      const totalKb = parseInt(totalKbStr, 10);
      const availKb = parseInt(availKbStr, 10);

      if (!totalKb || totalKb <= 0) continue;
      if (PSEUDO_FS.has(fs.toLowerCase())) continue;
      if (fs.startsWith("map ") || fs === "none") continue;
      // Skip macOS internal APFS system volumes (VM, Preboot, Update, Data, etc.)
      if (mount.startsWith("/System/Volumes/")) continue;
      // Skip Xcode simulator runtime disk images
      if (mount.startsWith("/Library/Developer/")) continue;
      // Skip macOS cryptex mounts (Metal toolchains, security extensions)
      if (mount.startsWith("/private/var/run/com.apple.")) continue;
      // Skip virtual container filesystems (OrbStack, Lima, etc.)
      if (fs.includes(":/") && !["nfs", "nfs4", "cifs", "smb", "smbfs", "afpfs"].some(n => fs.toLowerCase().startsWith(n))) continue;
      // Skip Talome-managed RAM disks
      if (mount === "/Volumes/TalomeHLS") continue;

      // Use total - available instead of the raw "Used" column.
      // On macOS APFS, volumes share a container pool — the "Used" column
      // only reflects per-volume usage, while "Available" correctly shows
      // the shared free space. total - available gives true disk consumption.
      const usedKb = totalKb - availKb;

      mounts.push({
        fs,
        mount,
        usedBytes: usedKb * 1024,
        totalBytes: totalKb * 1024,
        percent: Math.round((usedKb / totalKb) * 1000) / 10,
        type: getMountType(fs, mount),
      });
    }

    if (mounts.length > 0) {
      const rootMount = mounts.find((m) => m.mount === "/") ?? mounts[0];
      diskInfo = {
        usedBytes: rootMount.usedBytes,
        totalBytes: rootMount.totalBytes,
        percent: rootMount.percent,
        mounts,
      };
    }
  } catch {}

  return {
    cpu: {
      usage: getCpuUsage(),
      cores: cpus.length,
      model: cpus[0]?.model ?? "unknown",
    },
    memory: {
      usedBytes: usedMem,
      totalBytes: totalMem,
      percent: Math.round((usedMem / totalMem) * 1000) / 10,
    },
    disk: diskInfo,
    network: getNetworkThroughput(),
    uptime: Math.floor(os.uptime()),
    platform: os.platform() as "darwin" | "linux",
    arch: os.arch() as "arm64" | "x64",
    hostname: os.hostname(),
  };
}

function getCpuUsage(): number {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    for (const type of Object.values(cpu.times)) {
      totalTick += type;
    }
    totalIdle += cpu.times.idle;
  }
  return Math.round((1 - totalIdle / totalTick) * 1000) / 10;
}

let lastNetSample: { time: number; rx: number; tx: number } | null = null;
let lastNetResult = { rxBytesPerSec: 0, txBytesPerSec: 0 };

// sampleNetworkBytes imported from platform/index.ts as platformSampleNetworkBytes

function getNetworkThroughput(): { rxBytesPerSec: number; txBytesPerSec: number } {
  const sample = platformSampleNetworkBytes();
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
          event: ["start", "stop", "die", "restart", "destroy", "oom", "health_status"],
        },
      });

      eventStream = stream;

      stream.on("data", (chunk: Buffer) => {
        if (aborted) return;
        try {
          const raw = JSON.parse(chunk.toString("utf-8"));
          const event: DockerEvent = {
            type: raw.Type ?? "container",
            action: raw.Action ?? raw.status ?? "",
            actorId: (raw.Actor?.ID ?? raw.id ?? "").slice(0, 12),
            actorName: raw.Actor?.Attributes?.name ?? "",
            actorImage: raw.Actor?.Attributes?.image ?? raw.from ?? "",
            time: raw.time ?? Math.floor(Date.now() / 1000),
          };
          handler(event);
        } catch {
          // Malformed event — skip
        }
      });

      stream.on("error", (err: Error) => {
        if (aborted) return;
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
