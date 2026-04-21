/**
 * Platform abstraction — centralizes all macOS vs Linux differences.
 *
 * Every platform-specific workaround lives here instead of being scattered
 * across docker/client.ts, compose-pipeline.ts, and proxy modules.
 */

import { execSync } from "node:child_process";
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
    const raw = execSync("vm_stat", { encoding: "utf-8", timeout: 3000 });
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

    return (active + wired + speculative + compressor) * pageSize;
  } catch {
    return null;
  }
}

// ── Docker host address ──────────────────────────────────────────────────

/**
 * Get the address that a Docker container can use to reach the host machine.
 * macOS (Docker Desktop / OrbStack): always supports `host.docker.internal`.
 * Linux (native Docker): `host.docker.internal` only works with Docker Desktop;
 * native installs need the bridge gateway IP (typically 172.17.0.1).
 */
export function getDockerHostAddress(): string {
  if (isDarwin) return "host.docker.internal";
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
      const out = execSync("netstat -ib", { encoding: "utf-8" });
      let rx = 0, tx = 0;
      for (const line of out.split("\n").slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 10 && cols[0] === "en0" && !cols[2].includes(":")) {
          rx += parseInt(cols[6], 10) || 0;
          tx += parseInt(cols[9], 10) || 0;
        }
      }
      if (rx > 0 || tx > 0) return { rx, tx };
    } else {
      const out = execSync("cat /proc/net/dev", { encoding: "utf-8" });
      let rx = 0, tx = 0;
      for (const line of out.split("\n").slice(2)) {
        const parts = line.trim().split(/[:\s]+/);
        if (parts.length >= 10 && parts[0] !== "lo") {
          rx += parseInt(parts[1], 10) || 0;
          tx += parseInt(parts[9], 10) || 0;
        }
      }
      if (rx > 0 || tx > 0) return { rx, tx };
    }
  } catch {}
  return null;
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
