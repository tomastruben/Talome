import { tool } from "ai";
import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { getSetting } from "../../utils/settings.js";

const execAsync = promisify(exec);

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
  return `${size.toFixed(1)} ${units[unit]}`;
}

export const getSmartStatusTool = tool({
  description: "Get SMART disk health status. Shows drive health indicators like temperature, reallocated sectors, and overall health status.",
  inputSchema: z.object({
    device: z.string().optional().describe("Device path (e.g., /dev/sda). If omitted, scans all drives."),
  }),
  execute: async ({ device }) => {
    try {
      const cmd = device
        ? `smartctl --json -a ${device}`
        : `smartctl --scan --json`;

      const { stdout } = await execAsync(cmd, { timeout: 10000 });
      const data = JSON.parse(stdout);

      if (!device && data.devices) {
        // Scan mode — return list of devices
        return {
          success: true,
          devices: data.devices.map((d: { name: string; type: string; protocol: string }) => ({
            name: d.name,
            type: d.type,
            protocol: d.protocol,
          })),
          message: "Use get_smart_status with a specific device path for detailed health info.",
        };
      }

      return { success: true, data };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("ENOENT")) {
        return { success: false, error: "smartctl is not installed. Install smartmontools to enable SMART monitoring." };
      }
      return { success: false, error: msg };
    }
  },
});

export const cleanupDockerTool = tool({
  description: "Clean up unused Docker resources (stopped containers, dangling images, unused volumes, build cache). Shows what would be removed before proceeding.",
  inputSchema: z.object({
    dryRun: z.boolean().default(true).describe("If true, only show what would be cleaned. If false, actually clean."),
    targets: z.array(z.enum(["containers", "images", "volumes", "networks", "buildcache"]))
      .default(["containers", "images", "buildcache"])
      .describe("What to clean up"),
  }),
  execute: async ({ dryRun, targets }) => {
    try {
      // First get Docker disk usage
      const { stdout: dfOutput } = await execAsync("docker system df --format json", { timeout: 15000 });
      const lines = dfOutput.trim().split("\n").filter(Boolean);
      const usage = lines.map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          currentUsage: usage,
          targets,
          message: "Set dryRun to false to actually clean up these resources.",
        };
      }

      // Actually clean
      const results: Record<string, string> = {};
      for (const target of targets) {
        try {
          switch (target) {
            case "containers": {
              const { stdout } = await execAsync("docker container prune -f", { timeout: 30000 });
              results.containers = stdout.trim();
              break;
            }
            case "images": {
              const { stdout } = await execAsync("docker image prune -f", { timeout: 30000 });
              results.images = stdout.trim();
              break;
            }
            case "volumes": {
              const { stdout } = await execAsync("docker volume prune -f", { timeout: 30000 });
              results.volumes = stdout.trim();
              break;
            }
            case "networks": {
              const { stdout } = await execAsync("docker network prune -f", { timeout: 30000 });
              results.networks = stdout.trim();
              break;
            }
            case "buildcache": {
              const { stdout } = await execAsync("docker builder prune -f", { timeout: 30000 });
              results.buildcache = stdout.trim();
              break;
            }
          }
        } catch (e) {
          results[target] = `Error: ${e instanceof Error ? e.message : String(e)}`;
        }
      }

      return { success: true, dryRun: false, results };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const getStorageBreakdownTool = tool({
  description: "Get a breakdown of disk usage for key directories: Docker data, Talome data, app volumes, and system directories.",
  inputSchema: z.object({}),
  execute: async () => {
    const dirs = [
      { path: "/var/lib/docker", label: "Docker data" },
      { path: `${process.env.HOME}/.talome`, label: "Talome data" },
      { path: "/tmp", label: "Temp files" },
    ];

    const results: { path: string; label: string; sizeHuman: string; sizeBytes: number }[] = [];

    for (const dir of dirs) {
      try {
        const { stdout } = await execAsync(`du -sb ${dir.path} 2>/dev/null || echo "0\t${dir.path}"`, { timeout: 10000 });
        const [sizeStr] = stdout.trim().split("\t");
        const bytes = parseInt(sizeStr, 10) || 0;
        const units = ["B", "KB", "MB", "GB", "TB"];
        let size = bytes;
        let unit = 0;
        while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++; }
        results.push({
          path: dir.path,
          label: dir.label,
          sizeHuman: `${size.toFixed(1)} ${units[unit]}`,
          sizeBytes: bytes,
        });
      } catch {
        results.push({ path: dir.path, label: dir.label, sizeHuman: "unavailable", sizeBytes: 0 });
      }
    }

    return { success: true, breakdown: results };
  },
});

// ── Reclaimable space calculator ──────────────────────────────────────────

export const getReclaimableSpaceTool = tool({
  description: "Calculate reclaimable disk space from Docker resources (dangling images, stopped containers, build cache, unused volumes). Always a read-only analysis — nothing is deleted.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const { stdout } = await execAsync("docker system df --format json", { timeout: 15000 });
      const lines = stdout.trim().split("\n").filter(Boolean);

      const categories: { type: string; totalCount: number; reclaimable: string; reclaimableBytes: number }[] = [];

      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          categories.push({
            type: row.Type,
            totalCount: parseInt(row.TotalCount, 10) || 0,
            reclaimable: row.Reclaimable || "0B",
            reclaimableBytes: parseReclaimableBytes(row.Reclaimable),
          });
        } catch { /* skip malformed lines */ }
      }

      const totalReclaimableBytes = categories.reduce((sum, c) => sum + c.reclaimableBytes, 0);

      return {
        success: true,
        categories,
        totalReclaimable: formatBytes(totalReclaimableBytes),
        totalReclaimableBytes,
        message: totalReclaimableBytes > 1024 * 1024 * 100
          ? `${formatBytes(totalReclaimableBytes)} can be reclaimed from Docker resources. Use cleanup_docker with dryRun=false to clean (requires user approval).`
          : "Docker resources are clean — minimal space to reclaim.",
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

function parseReclaimableBytes(str: string | undefined): number {
  if (!str) return 0;
  // Parse strings like "1.5GB (30%)", "500MB", "0B"
  const match = str.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };
  return Math.round(value * (multipliers[unit] ?? 1));
}

// ── Content-aware media reclaim ───────────────────────────────────────────

interface WatchedMediaItem {
  title: string;
  type: "tv" | "movie";
  sizeOnDisk: string;
  sizeBytes: number;
  watchedAt?: string;
  sonarrId?: number;
  radarrId?: number;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export const analyzeWatchedMediaTool = tool({
  description: "Analyze media library to find already-watched shows and movies that could be removed to reclaim disk space. Cross-references Plex/Jellyfin watch history with Sonarr/Radarr library data. This is READ-ONLY — nothing is deleted. Always present results to the user for approval before any cleanup.",
  inputSchema: z.object({
    minAgeDays: z.number().default(30).describe("Only include media watched at least this many days ago"),
  }),
  execute: async ({ minAgeDays }) => {
    const results: WatchedMediaItem[] = [];
    const cutoffDate = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000);

    // Get Plex watch history
    const plexUrl = getSetting("plex_url");
    const plexToken = getSetting("plex_token");
    const watchedRatingKeys = new Set<string>();
    const watchedTitles = new Map<string, string>(); // title → watchedAt

    if (plexUrl && plexToken) {
      const cleanUrl = plexUrl.replace(/\/$/, "");
      const histData = await fetchJson(
        `${cleanUrl}/status/sessions/history/all?sort=viewedAt:desc&limit=500&X-Plex-Token=${plexToken}`,
        { Accept: "application/json" },
      );

      if (histData) {
        const mc = (histData as Record<string, unknown>).MediaContainer as Record<string, unknown> | undefined;
        const items = (mc?.Metadata ?? []) as Array<Record<string, unknown>>;

        for (const item of items) {
          const viewedAt = item.viewedAt ? new Date((item.viewedAt as number) * 1000) : null;
          if (viewedAt && viewedAt < cutoffDate) {
            const title = ((item.grandparentTitle ?? item.title) as string) || "";
            if (item.ratingKey) watchedRatingKeys.add(String(item.ratingKey));
            if (title) watchedTitles.set(title.toLowerCase(), viewedAt.toISOString());
          }
        }
      }
    }

    // Get Jellyfin watch history
    const jellyfinUrl = getSetting("jellyfin_url");
    const jellyfinKey = getSetting("jellyfin_api_key");

    if (jellyfinUrl && jellyfinKey) {
      const cleanUrl = jellyfinUrl.replace(/\/$/, "");
      const headers = { Authorization: `MediaBrowser Token="${jellyfinKey}"` };

      // Get played items
      const usersData = await fetchJson(`${cleanUrl}/Users`, headers);
      if (Array.isArray(usersData) && usersData.length > 0) {
        const userId = (usersData[0] as Record<string, unknown>).Id;
        const playedData = await fetchJson(
          `${cleanUrl}/Users/${userId}/Items?IsPlayed=true&Recursive=true&IncludeItemTypes=Movie,Series&Limit=500`,
          headers,
        );
        if (playedData) {
          const items = ((playedData as Record<string, unknown>).Items ?? []) as Array<Record<string, unknown>>;
          for (const item of items) {
            const title = (item.Name as string) || "";
            const lastPlayed = item.UserData ? ((item.UserData as Record<string, unknown>).LastPlayedDate as string) : null;
            if (lastPlayed && new Date(lastPlayed) < cutoffDate && title) {
              watchedTitles.set(title.toLowerCase(), lastPlayed);
            }
          }
        }
      }
    }

    if (watchedTitles.size === 0) {
      return {
        success: true,
        message: "No watch history found. Connect Plex or Jellyfin to enable content-aware reclaim suggestions.",
        items: [],
        totalReclaimable: "0 B",
        totalReclaimableBytes: 0,
      };
    }

    // Cross-reference with Sonarr (TV shows)
    const sonarrUrl = getSetting("sonarr_url");
    const sonarrKey = getSetting("sonarr_api_key");
    if (sonarrUrl && sonarrKey) {
      const cleanUrl = sonarrUrl.replace(/\/$/, "");
      const series = await fetchJson(`${cleanUrl}/api/v3/series`, { "X-Api-Key": sonarrKey });
      if (Array.isArray(series)) {
        for (const s of series as Array<Record<string, unknown>>) {
          const title = (s.title as string) || "";
          const watchedAt = watchedTitles.get(title.toLowerCase());
          if (watchedAt) {
            const sizeBytes = (s.statistics as Record<string, unknown>)?.sizeOnDisk as number ?? 0;
            if (sizeBytes > 0) {
              results.push({
                title,
                type: "tv",
                sizeOnDisk: formatBytes(sizeBytes),
                sizeBytes,
                watchedAt,
                sonarrId: s.id as number,
              });
            }
          }
        }
      }
    }

    // Cross-reference with Radarr (Movies)
    const radarrUrl = getSetting("radarr_url");
    const radarrKey = getSetting("radarr_api_key");
    if (radarrUrl && radarrKey) {
      const cleanUrl = radarrUrl.replace(/\/$/, "");
      const movies = await fetchJson(`${cleanUrl}/api/v3/movie`, { "X-Api-Key": radarrKey });
      if (Array.isArray(movies)) {
        for (const m of movies as Array<Record<string, unknown>>) {
          const title = (m.title as string) || "";
          const watchedAt = watchedTitles.get(title.toLowerCase());
          if (watchedAt && m.hasFile) {
            const sizeBytes = (m.sizeOnDisk as number) ?? 0;
            if (sizeBytes > 0) {
              results.push({
                title,
                type: "movie",
                sizeOnDisk: formatBytes(sizeBytes),
                sizeBytes,
                watchedAt,
                radarrId: m.id as number,
              });
            }
          }
        }
      }
    }

    // Sort by size descending
    results.sort((a, b) => b.sizeBytes - a.sizeBytes);

    const totalReclaimableBytes = results.reduce((sum, r) => sum + r.sizeBytes, 0);

    return {
      success: true,
      items: results.slice(0, 50),
      totalItems: results.length,
      totalReclaimable: formatBytes(totalReclaimableBytes),
      totalReclaimableBytes,
      message: results.length > 0
        ? `Found ${results.length} watched media items (${formatBytes(totalReclaimableBytes)} total). Review the list and confirm which items to remove. Nothing has been deleted.`
        : "No watched media found that matches your Sonarr/Radarr library.",
    };
  },
});

// ── HLS transcode cache cleanup ───────────────────────────────────────────

import { getHlsCacheStats, clearAllHlsCache } from "../../routes/files.js";

export const cleanupHlsCacheTool = tool({
  description: "Check or clear the HLS transcode cache. The media player creates temporary HLS segments when streaming video. Idle jobs auto-expire after 90s, but orphaned files can accumulate. Use action='stats' to check usage, action='clear' to clean up.",
  inputSchema: z.object({
    action: z.enum(["stats", "clear"]).default("stats").describe("'stats' to check cache size, 'clear' to delete all cached segments and stop running transcodes"),
  }),
  execute: async ({ action }) => {
    try {
      if (action === "clear") {
        const freedSize = await clearAllHlsCache();
        return {
          success: true,
          action: "clear",
          freedSize,
          freedSizeHuman: formatBytes(freedSize),
          message: freedSize > 0
            ? `Cleared HLS cache — freed ${formatBytes(freedSize)}.`
            : "HLS cache was already empty.",
        };
      }

      const stats = await getHlsCacheStats();
      return {
        success: true,
        action: "stats",
        ...stats,
        totalSizeHuman: formatBytes(stats.totalSize),
        message: stats.totalSize > 0
          ? `HLS cache: ${stats.jobCount} job(s) (${stats.runningCount} running), using ${formatBytes(stats.totalSize)}. Use action='clear' to clean up.`
          : "HLS cache is empty — no cleanup needed.",
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
