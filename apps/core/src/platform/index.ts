/**
 * Platform abstraction — centralizes all macOS vs Linux differences.
 *
 * Every platform-specific workaround lives here instead of being scattered
 * across docker/client.ts, compose-pipeline.ts, and proxy modules.
 */

import { execSync, execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import os from "node:os";

export const isDarwin = process.platform === "darwin";
export const isLinux = process.platform === "linux";

// ── Memory ────────────────────────────────────────────────────────────────

/**
 * Get "app memory" on macOS using vm_stat.
 *
 * os.freemem() on macOS only reports truly free pages — it doesn't count
 * the file-backed cache that macOS can instantly reclaim under pressure.
 * This makes a Mac Mini (which aggressively caches) always look like it's
 * at 90%+ memory, triggering false warnings.
 *
 * We compute: app memory = (active + wired + speculative + compressor) pages
 * which matches Activity Monitor's "Memory Used" (excluding cached files).
 *
 * On Linux, returns null (os.freemem() already excludes buffers/cache).
 */
export function getAppMemoryUsed(): number | null {
  if (!isDarwin) return null;
  try {
    return parseVmStat(execSync("vm_stat", { encoding: "utf-8", timeout: 3000 }));
  } catch {
    return null;
  }
}

/**
 * Async, non-blocking variant of {@link getAppMemoryUsed}. Spawns `vm_stat`
 * via execFile with a hard timeout so a wedged child can never stall the
 * event loop (the sync variant blocks for the whole child lifetime).
 */
export async function getAppMemoryUsedAsync(): Promise<number | null> {
  if (!isDarwin) return null;
  const raw = await execFileText("/usr/bin/vm_stat", [], 3_000);
  return raw ? parseVmStat(raw) : null;
}

/** Parse `vm_stat` output into "app memory" bytes (active + wired + speculative + compressor). */
export function parseVmStat(raw: string): number | null {
  const pageMatch = raw.match(/page size of (\d+) bytes/);
  const pageSize = pageMatch ? parseInt(pageMatch[1], 10) : 16384;

  const get = (label: string): number => {
    const m = raw.match(new RegExp(`${label}:\\s+(\\d+)`));
    return m ? parseInt(m[1], 10) : 0;
  };

  const active = get("Pages active");
  const wired = get("Pages wired down");
  const speculative = get("Pages speculative");
  const compressor = get("Pages occupied by compressor");

  const total = (active + wired + speculative + compressor) * pageSize;
  return total > 0 ? total : null;
}

// ── Docker host address ──────────────────────────────────────────────────

/**
 * Get the address that a Docker container can use to reach the host machine.
 * macOS (Docker Desktop / OrbStack): always supports `host.docker.internal`.
 * Linux (native Docker): `host.docker.internal` only works with Docker Desktop;
 * native installs need the bridge gateway IP (typically 172.17.0.1).
 */
let dockerHostAddressCache: { value: string; at: number } | null = null;
const DOCKER_HOST_ADDRESS_TTL_MS = 5 * 60 * 1000;

export function getDockerHostAddress(): string {
  if (isDarwin) return "host.docker.internal";
  // The default gateway rarely changes; avoid a blocking shell spawn on
  // every Caddy config render.
  if (dockerHostAddressCache && Date.now() - dockerHostAddressCache.at < DOCKER_HOST_ADDRESS_TTL_MS) {
    return dockerHostAddressCache.value;
  }
  const value = resolveDockerHostAddress();
  dockerHostAddressCache = { value, at: Date.now() };
  return value;
}

function resolveDockerHostAddress(): string {
  try {
    const out = execSync("ip route show default 2>/dev/null | awk '{print $3}'", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const gateway = out.trim();
    if (gateway && /^\d+\.\d+\.\d+\.\d+$/.test(gateway)) return gateway;
  } catch { /* not available — fall through */ }
  return "host.docker.internal"; // Docker Desktop for Linux supports this
}

// ── Network sampling ──────────────────────────────────────────────────────

/**
 * Sample total network bytes (RX + TX) from the system.
 * macOS: parses `netstat -ib` for en0.
 * Linux: reads `/proc/net/dev` for all non-loopback interfaces.
 */
export function sampleNetworkBytes(): { rx: number; tx: number } | null {
  try {
    if (isDarwin) {
      // Absolute path — macOS netstat lives in /usr/sbin, which is not on
      // the launchd-spawned process PATH by default. Without this we'd
      // silently return null and the network widget would stick at 0 kb/s.
      return parseNetstatIb(execSync("/usr/sbin/netstat -ib", { encoding: "utf-8", timeout: 3000 }));
    }
    return parseProcNetDev(execSync("cat /proc/net/dev", { encoding: "utf-8", timeout: 3000 }));
  } catch {
    return null;
  }
}

/**
 * Async, non-blocking variant of {@link sampleNetworkBytes}.
 * macOS: `/usr/sbin/netstat -ib` via execFile with a timeout.
 * Linux: reads `/proc/net/dev` directly (no child process at all).
 */
export async function sampleNetworkBytesAsync(): Promise<{ rx: number; tx: number } | null> {
  try {
    if (isDarwin) {
      const out = await execFileText("/usr/sbin/netstat", ["-ib"], 3_000);
      return out ? parseNetstatIb(out) : null;
    }
    return parseProcNetDev(await readFile("/proc/net/dev", "utf-8"));
  } catch {
    return null;
  }
}

/** Sum en0 link-level byte counters from `netstat -ib`. */
export function parseNetstatIb(out: string): { rx: number; tx: number } | null {
  let rx = 0, tx = 0;
  for (const line of out.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 10 && cols[0] === "en0" && !cols[2].includes(":")) {
      rx += parseInt(cols[6], 10) || 0;
      tx += parseInt(cols[9], 10) || 0;
    }
  }
  return rx > 0 || tx > 0 ? { rx, tx } : null;
}

/** Sum byte counters of all non-loopback interfaces from `/proc/net/dev`. */
export function parseProcNetDev(out: string): { rx: number; tx: number } | null {
  let rx = 0, tx = 0;
  for (const line of out.split("\n").slice(2)) {
    const parts = line.trim().split(/[:\s]+/);
    if (parts.length >= 10 && parts[0] !== "lo") {
      rx += parseInt(parts[1], 10) || 0;
      tx += parseInt(parts[9], 10) || 0;
    }
  }
  return rx > 0 || tx > 0 ? { rx, tx } : null;
}

// ── Disk usage ───────────────────────────────────────────────────────────

export interface DiskMountInfo {
  fs: string;
  mount: string;
  usedBytes: number;
  totalBytes: number;
  percent: number;
  type: "internal" | "external" | "network";
}

const PSEUDO_FS = new Set([
  "tmpfs", "devtmpfs", "sysfs", "proc", "udev", "devfs", "autofs",
  "squashfs", "nsfs", "cgroup", "cgroup2", "pstore",
  "securityfs", "debugfs", "tracefs", "hugetlbfs", "mqueue",
  "fusectl", "binfmt_misc", "configfs", "efivarfs",
]);

const NETWORK_FS_PREFIXES = ["nfs", "nfs4", "cifs", "smb", "smbfs", "afpfs", "ftp", "sshfs", "davfs"];

function getMountType(fs: string, mount: string): DiskMountInfo["type"] {
  if (NETWORK_FS_PREFIXES.some((n) => fs.toLowerCase().startsWith(n))) return "network";
  if (fs.includes(":/")) return "network";
  if (mount.startsWith("/Volumes/") || mount.startsWith("/media/") || mount.startsWith("/run/media/")) return "external";
  return "internal";
}

/**
 * Parse POSIX `df -Pk` output into the mounts Talome reports, skipping
 * pseudo filesystems, macOS system volumes and virtual container mounts.
 */
export function parseDfOutput(dfOutput: string): DiskMountInfo[] {
  const lines = dfOutput.trim().split("\n").slice(1);
  const mounts: DiskMountInfo[] = [];

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
    if (fs.includes(":/") && !["nfs", "nfs4", "cifs", "smb", "smbfs", "afpfs"].some((n) => fs.toLowerCase().startsWith(n))) continue;
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

  return mounts;
}

/**
 * Run `df -Pk` asynchronously. Returns null on failure or timeout — `df`
 * can stall indefinitely on a dead SMB/NFS mount, so the caller must never
 * await it without a bound.
 */
export async function readDiskMountsAsync(timeoutMs = 5_000): Promise<DiskMountInfo[] | null> {
  return readDiskMountsTracked(timeoutMs).mounts;
}

export interface TrackedDiskRead {
  /** Parsed mounts, or null on failure/timeout. Always settles by timeoutMs + 500ms. */
  mounts: Promise<DiskMountInfo[] | null>;
  /**
   * Settles when the `df` child has actually exited. A df blocked in
   * uninterruptible I/O on a dead network mount outlives its timeout (it
   * ignores even SIGKILL until the kernel gives up), so callers that must
   * never run two df processes at once wait on this, not on `mounts`.
   */
  exited: Promise<void>;
}

/** Like {@link readDiskMountsAsync}, but also reports when the child really exits. */
export function readDiskMountsTracked(timeoutMs = 5_000): TrackedDiskRead {
  const run = execFileTracked("df", ["-Pk"], timeoutMs);
  return {
    mounts: run.output.then((out) => (out ? parseDfOutput(out) : null)),
    exited: run.exited,
  };
}

/** Usage of one filesystem, in the same form {@link parseDfOutput} reports. */
export interface DiskUsage {
  usedBytes: number;
  totalBytes: number;
  percent: number;
}

/**
 * Convert statfs() figures to {@link DiskUsage}. Like parseDfOutput, "used" is
 * total − available (APFS volumes share their container's free space), and
 * the percentage has one decimal. Null when the figures are unusable.
 */
export function diskUsageFromStatfs(s: { bsize: number; blocks: number; bavail: number }): DiskUsage | null {
  const totalBytes = s.blocks * s.bsize;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  const availBytes = Math.min(Math.max(s.bavail * s.bsize, 0), totalBytes);
  const usedBytes = totalBytes - availBytes;
  return { usedBytes, totalBytes, percent: Math.round((usedBytes / totalBytes) * 1000) / 10 };
}

/**
 * statfs() a single path — "/" by default. Unlike `df`, which walks the whole
 * mount table (and on Linux blocks on a hard-mounted NFS/SMB share whose
 * server is gone), this only asks the filesystem holding `path`, so one dead
 * network mount cannot hide the root disk. Resolves null on failure; never
 * rejects. It is not bounded here: callers race it against a timeout and must
 * not start another one while it is still pending.
 */
export function readDiskUsage(path = "/"): Promise<DiskUsage | null> {
  return statfs(path).then(diskUsageFromStatfs, () => null);
}

// ── CPU utilisation ──────────────────────────────────────────────────────

export interface CpuTimesSample {
  idle: number;
  total: number;
}

/** Sum idle and total ticks across all cores (cumulative since boot). */
export function sampleCpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimesSample {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
    idle += t.idle;
  }
  return { idle, total };
}

/**
 * CPU utilisation (0-100, one decimal) between two cumulative samples.
 * Returns null when the samples are unusable (no elapsed ticks or a counter
 * reset), so callers can fall back instead of reporting garbage.
 */
export function computeCpuUsage(prev: CpuTimesSample, curr: CpuTimesSample): number | null {
  const totalDelta = curr.total - prev.total;
  const idleDelta = curr.idle - prev.idle;
  if (totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) return null;
  const usage = (1 - idleDelta / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, usage)) * 10) / 10;
}

// ── Child process helper ─────────────────────────────────────────────────

/**
 * execFile wrapper that resolves stdout, or null on error/timeout. The
 * outer timer guarantees resolution even when the child ignores the kill
 * signal (e.g. a process stuck in uninterruptible I/O on a dead network mount).
 */
export function execFileText(cmd: string, args: string[], timeoutMs: number): Promise<string | null> {
  return execFileTracked(cmd, args, timeoutMs).output;
}

export interface TrackedExec {
  /** stdout, or null on error/timeout. Always settles by timeoutMs + 500ms. */
  output: Promise<string | null>;
  /** Settles once the child process has exited (or failed to spawn). */
  exited: Promise<void>;
}

/**
 * Spawn a child with a hard timeout (SIGKILL) and expose both its output and
 * its real lifetime. `output` is bounded; `exited` may take much longer when
 * the child is wedged in the kernel.
 */
export function execFileTracked(cmd: string, args: string[], timeoutMs: number): TrackedExec {
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => { markExited = resolve; });
  const output = new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(value);
    };
    const guard = setTimeout(() => finish(null), timeoutMs + 500);
    guard.unref?.();
    try {
      // The callback fires once the child has exited and its pipes closed
      // (or it failed to spawn) — never earlier, even after a timeout kill.
      execFile(
        cmd,
        args,
        { encoding: "utf-8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout) => {
          markExited();
          // df exits non-zero when a single mount is unreadable but still
          // prints the rest — keep partial output when there is any.
          if (err && !stdout) finish(null);
          else finish(stdout);
        },
      );
    } catch {
      markExited();
      finish(null);
    }
  });
  return { output, exited };
}

// ── Filesystem detection ──────────────────────────────────────────────────

/**
 * Detect the filesystem type of a given path.
 * macOS: uses `diskutil info`.
 * Linux: uses `df -T`.
 */
export function detectFilesystemType(path: string): string {
  try {
    if (isDarwin) {
      const out = execSync(`diskutil info "${path}" 2>/dev/null || diskutil info "$(df "${path}" | tail -1 | awk '{print $1}')" 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const match = out.match(/Type.*?:\s*(\S+)/i);
      if (match) return match[1].toLowerCase();
    } else {
      const out = execSync(`df -T "${path}" 2>/dev/null | tail -1`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const parts = out.trim().split(/\s+/);
      if (parts.length >= 2) return parts[1].toLowerCase();
    }
  } catch { /* detection failed — non-fatal */ }
  return "unknown";
}
