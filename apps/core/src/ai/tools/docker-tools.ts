import { tool } from "ai";
import { z } from "zod";
import { getSecurityMode } from "../tool-gateway.js";
import { SHELL_ALLOWLIST } from "./shell-tool.js";
import {
  listContainers,
  getContainerLogs,
  getContainerStats,
  startContainer,
  stopContainer,
  restartContainer,
  inspectContainer,
  listImages,
  listNetworks,
  createNetwork,
  connectContainerToNetwork,
  disconnectContainerFromNetwork,
  removeNetwork,
  pruneResources,
  execInContainer,
} from "../../docker/client.js";
import { writeAuditEntry } from "../../db/audit.js";
import { db, schema } from "../../db/index.js";

/**
 * Build the set of container IDs Talome installed. Used by `exec_container`
 * to refuse execs into containers Talome doesn't own — the Talome daemon
 * itself, or user-managed containers installed outside of Talome. Returns
 * both full and short (12-char) IDs so either form matches.
 */
function getTalomeManagedContainerIds(): Set<string> {
  try {
    const rows = db.select({ containerIds: schema.installedApps.containerIds }).from(schema.installedApps).all();
    const ids = new Set<string>();
    for (const row of rows) {
      try {
        const arr = JSON.parse(row.containerIds || "[]") as string[];
        for (const id of arr) {
          if (typeof id === "string" && id.length > 0) {
            ids.add(id);
            if (id.length >= 12) ids.add(id.slice(0, 12));
          }
        }
      } catch { /* malformed row — skip */ }
    }
    return ids;
  } catch {
    return new Set();
  }
}

export const listContainersTool = tool({
  description: `List all Docker containers with their current status, ports, and images.

After calling: Present as a concise table or list. Lead with a one-sentence summary (e.g. "You have 5 containers — 4 running, 1 stopped."). Highlight any stopped or unhealthy containers as alerts. Offer to start stopped ones or check logs on unhealthy ones.
When listing containers with exposed TCP ports, include direct markdown links using the provided webUrls (e.g. [sonarr](http://localhost:8989)).`,
  inputSchema: z.object({}),
  execute: async () => {
    const rawContainers = await listContainers();
    const containers = rawContainers.map((container) => {
      const tcpPorts = container.ports
        .filter((p) => p.protocol === "tcp" && p.host > 0)
        .map((p) => p.host)
        .filter((p, i, arr) => arr.indexOf(p) === i);
      const webUrls = tcpPorts.map((port) => `http://localhost:${port}`);
      return {
        name: container.name,
        image: container.image,
        status: container.status,
        tcpPorts,
        primaryWebUrl: webUrls[0] ?? null,
      };
    });
    const running = containers.filter((c) => c.status === "running").length;
    const stopped = containers.filter((c) => c.status !== "running").length;
    const alerts = containers
      .filter((c) => c.status !== "running")
      .map((c) => `${c.name} is ${c.status}`);

    return {
      containers,
      summary: `${containers.length} containers total — ${running} running, ${stopped} stopped/other`,
      status: stopped > 0 ? "warning" : "ok",
      alerts,
    };
  },
});

export const getContainerLogsTool = tool({
  description: `Get recent logs from a specific Docker container.

After calling: Summarise the key findings first (errors, warnings, last successful action). Quote the most relevant log lines verbatim. If there are errors, suggest a likely fix or next diagnostic step.`,
  inputSchema: z.object({
    containerId: z.string().describe("Container ID or name"),
    lines: z.number().default(50).describe("Number of log lines to retrieve"),
  }),
  execute: async ({ containerId, lines }) => {
    const logs = await getContainerLogs(containerId, lines);
    const logLines = logs.split("\n").filter(Boolean);
    const errorLines = logLines.filter((l) =>
      /error|fatal|exception|panic|critical/i.test(l)
    );
    const warnLines = logLines.filter((l) => /warn|warning/i.test(l));

    return {
      containerId,
      logs,
      summary: `${logLines.length} log lines retrieved. ${errorLines.length} error(s), ${warnLines.length} warning(s).`,
      status: errorLines.length > 0 ? "error" : warnLines.length > 0 ? "warning" : "ok",
      alerts: errorLines.slice(0, 3),
    };
  },
});

export const startContainerTool = tool({
  description: `Start a stopped Docker container. Requires user confirmation.

After calling: Confirm the container has started (e.g. "✓ jellyfin is now running"). If it was already running, say so. Offer to open the web UI if the container has a known port.`,
  inputSchema: z.object({
    containerId: z.string().describe("Container ID or name to start"),
  }),
  execute: async ({ containerId }) => {
    await startContainer(containerId);
    writeAuditEntry("Started", "modify", containerId);
    return {
      success: true,
      action: "started",
      containerId,
      summary: `Container ${containerId} has been started successfully.`,
      status: "ok",
    };
  },
});

export const stopContainerTool = tool({
  description: `Stop a running Docker container. Requires user confirmation.

After calling: Confirm the container has stopped (e.g. "✓ jellyfin has been stopped"). Remind the user they can start it again anytime.`,
  inputSchema: z.object({
    containerId: z.string().describe("Container ID or name to stop"),
  }),
  execute: async ({ containerId }) => {
    await stopContainer(containerId);
    writeAuditEntry("Stopped", "modify", containerId);
    return {
      success: true,
      action: "stopped",
      containerId,
      summary: `Container ${containerId} has been stopped successfully.`,
      status: "ok",
    };
  },
});

export const restartContainerTool = tool({
  description: `Restart a Docker container. Requires user confirmation.

After calling: Confirm the restart (e.g. "✓ jellyfin restarted"). Mention if a restart typically resolves the kind of issue the user was experiencing. Offer to check logs after a moment if the issue was an error.`,
  inputSchema: z.object({
    containerId: z.string().describe("Container ID or name to restart"),
  }),
  execute: async ({ containerId }) => {
    await restartContainer(containerId);
    writeAuditEntry("Restarted", "modify", containerId);
    return {
      success: true,
      action: "restarted",
      containerId,
      summary: `Container ${containerId} has been restarted successfully.`,
      status: "ok",
    };
  },
});

export const checkServiceHealthTool = tool({
  description: `Check if a container is healthy by checking its running status and resource usage stats.

After calling: Give a clear health verdict (healthy / degraded / down). If healthy, share key stats (CPU, memory). If unhealthy, state the specific reason and suggest next steps (check logs, restart, etc.).`,
  inputSchema: z.object({
    containerId: z.string().describe("Container ID or name"),
  }),
  execute: async ({ containerId }) => {
    const containers = await listContainers();
    const container = containers.find(
      (c) => c.id === containerId || c.name === containerId
    );
    if (!container) {
      return {
        healthy: false,
        reason: "Container not found",
        summary: `No container found with ID or name "${containerId}".`,
        status: "error",
        alerts: [`Container "${containerId}" does not exist`],
      };
    }
    if (container.status !== "running") {
      return {
        healthy: false,
        reason: `Container is ${container.status}`,
        summary: `${container.name} is not running — current status: ${container.status}.`,
        status: "error",
        alerts: [`${container.name} is ${container.status}`],
      };
    }
    try {
      const stats = await getContainerStats(container.id);
      return {
        healthy: true,
        stats,
        summary: `${container.name} is running and healthy.`,
        status: "ok",
        alerts: [],
      };
    } catch {
      return {
        healthy: false,
        reason: "Could not retrieve stats",
        summary: `${container.name} is running but stats are unavailable — it may be under load or initialising.`,
        status: "warning",
        alerts: ["Stats unavailable — container may be busy"],
      };
    }
  },
});

export const inspectContainerTool = tool({
  description: `Inspect a Docker container to get detailed info: restart count, state timestamps, volume mounts, and labels.

After calling: Highlight key findings — restart count (high = crash-loop), uptime (startedAt vs now), volume mounts (check for missing/RO mounts). If restartCount > 3, flag it as likely crash-looping and suggest checking logs.`,
  inputSchema: z.object({
    containerId: z.string().describe("Container ID or name"),
  }),
  execute: async ({ containerId }) => {
    const info = await inspectContainer(containerId);
    const upSince = info.state.startedAt
      ? new Date(info.state.startedAt).toISOString()
      : "unknown";
    const crashLooping = info.restartCount > 3;

    return {
      ...info,
      summary: `${containerId}: ${info.state.status}, up since ${upSince}, ${info.restartCount} restart(s), ${info.mounts.length} mount(s).`,
      status: crashLooping ? "warning" : "ok",
      alerts: crashLooping
        ? [`High restart count (${info.restartCount}) — likely crash-looping`]
        : [],
    };
  },
});

export const getContainerStatsTool = tool({
  description: `Get real-time resource usage stats for a running container: CPU%, memory, and network I/O.

After calling: Present stats concisely. Flag high CPU (>80%) or memory approaching limit (>90%). Compare to system resources if available.`,
  inputSchema: z.object({
    containerId: z.string().describe("Container ID or name"),
  }),
  execute: async ({ containerId }) => {
    const stats = await getContainerStats(containerId);
    const memPercent =
      stats.memoryLimitMb > 0
        ? Math.round((stats.memoryUsageMb / stats.memoryLimitMb) * 1000) / 10
        : 0;
    const alerts: string[] = [];
    if (stats.cpuPercent > 80) alerts.push(`High CPU: ${stats.cpuPercent}%`);
    if (memPercent > 90) alerts.push(`Memory near limit: ${memPercent}%`);

    return {
      containerId,
      ...stats,
      memoryPercent: memPercent,
      summary: `CPU ${stats.cpuPercent}%, Memory ${stats.memoryUsageMb}/${stats.memoryLimitMb} MB (${memPercent}%)`,
      status: alerts.length > 0 ? "warning" : "ok",
      alerts,
    };
  },
});

export const listImagesTool = tool({
  description: `List all Docker images on the host with their tags, sizes, and creation dates.

After calling: Present as a table sorted by size (largest first). Highlight images with no tags ("<none>") as candidates for cleanup. Show total disk usage by images.`,
  inputSchema: z.object({}),
  execute: async () => {
    const images = await listImages();
    const totalBytes = images.reduce((sum, img) => sum + img.size, 0);
    const untagged = images.filter(
      (img) =>
        img.repoTags.length === 0 ||
        img.repoTags.every((t) => t === "<none>:<none>")
    );

    return {
      images: images
        .sort((a, b) => b.size - a.size)
        .map((img) => ({
          ...img,
          sizeMb: Math.round(img.size / (1024 * 1024)),
        })),
      summary: `${images.length} images, ${Math.round(totalBytes / (1024 * 1024))} MB total. ${untagged.length} untagged.`,
      totalSizeMb: Math.round(totalBytes / (1024 * 1024)),
      untaggedCount: untagged.length,
      status: untagged.length > 5 ? "warning" : "ok",
      alerts:
        untagged.length > 5
          ? [`${untagged.length} untagged images — consider pruning`]
          : [],
    };
  },
});

export const listNetworksTool = tool({
  description: `List all Docker networks with their drivers, scopes, and connected containers.

After calling: Present as a concise list. Highlight custom networks and how many containers are connected. Mention orphaned networks (no containers) as cleanup candidates.`,
  inputSchema: z.object({}),
  execute: async () => {
    const networks = await listNetworks();
    const custom = networks.filter(
      (n) => !["bridge", "host", "none"].includes(n.name)
    );
    const orphaned = custom.filter((n) => n.containers.length === 0);

    return {
      networks,
      summary: `${networks.length} networks (${custom.length} custom). ${orphaned.length} orphaned.`,
      customCount: custom.length,
      orphanedCount: orphaned.length,
      status: "ok",
      alerts:
        orphaned.length > 3
          ? [`${orphaned.length} orphaned networks — consider pruning`]
          : [],
    };
  },
});

export const pruneResourcesTool = tool({
  description: `Remove unused Docker resources (stopped containers, dangling images, unused volumes, unused networks). Requires user confirmation — this is destructive and cannot be undone.

After calling: Report exactly what was removed and how much disk space was reclaimed. Warn that pruned volumes cannot be recovered.`,
  inputSchema: z.object({
    targets: z
      .array(z.enum(["containers", "images", "volumes", "networks"]))
      .min(1)
      .describe("Which resource types to prune"),
    confirmed: z.boolean().describe("Must be true — ask user to confirm before calling"),
  }),
  execute: async ({ targets, confirmed }) => {
    if (!confirmed) {
      return { error: "This is a destructive action. Ask the user to confirm, then call again with confirmed: true." };
    }
    const results = await pruneResources(targets);
    writeAuditEntry(
      "Docker prune",
      "destructive",
      JSON.stringify(targets)
    );

    let totalReclaimed = 0;
    let totalRemoved = 0;
    for (const r of Object.values(results)) {
      totalReclaimed += r.spaceReclaimed ?? 0;
      totalRemoved += r.count ?? 0;
    }

    return {
      results,
      summary: `Pruned ${targets.join(", ")}: ${totalRemoved} item(s) removed, ${Math.round(totalReclaimed / (1024 * 1024))} MB reclaimed.`,
      totalReclaimedMb: Math.round(totalReclaimed / (1024 * 1024)),
      totalRemoved,
      status: "ok",
    };
  },
});

export const execContainerTool = tool({
  description: `Execute a command inside a running Docker container. Useful for diagnostics — checking config files, running health checks, testing connectivity. Requires user confirmation.

After calling: Show the command output. If exit code is non-zero, explain what likely went wrong and suggest fixes.`,
  inputSchema: z.object({
    containerId: z.string().describe("Container ID or name"),
    command: z
      .array(z.string())
      .min(1)
      .describe(
        'Command and arguments (e.g. ["cat", "/etc/nginx/nginx.conf"])'
      ),
  }),
  execute: async ({ containerId, command }) => {
    const mode = getSecurityMode();

    // Locked mode: exec entirely disabled
    if (mode === "locked") {
      writeAuditEntry("Docker exec BLOCKED (locked)", "modify", `${containerId}: ${command.join(" ")}`, false);
      return { error: 'Container exec is disabled. Security mode is set to "locked". An admin can change this in Settings > Security.' };
    }

    // Container scope — only Talome-managed containers are targets. This
    // prevents an AI-authored exec from reaching into the Talome daemon
    // itself, or into user containers that weren't installed through
    // Talome. In permissive mode an admin can override by setting
    // TALOME_ALLOW_UNMANAGED_EXEC=true, but the default is strict.
    const managedIds = getTalomeManagedContainerIds();
    const allowUnmanaged =
      mode === "permissive" && process.env.TALOME_ALLOW_UNMANAGED_EXEC === "true";
    if (!allowUnmanaged) {
      // Accept the full ID, a 12+ char prefix, or a container name that
      // inspectContainer could resolve. Since we only have IDs in the DB,
      // we match by prefix and fall back to resolving a name via inspect.
      let matched = false;
      for (const id of managedIds) {
        if (id === containerId || id.startsWith(containerId) || containerId.startsWith(id)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        try {
          const info = await inspectContainer(containerId) as { Id?: string } | null;
          const fullId = info?.Id;
          if (fullId) {
            for (const id of managedIds) {
              if (fullId === id || fullId.startsWith(id) || id.startsWith(fullId)) {
                matched = true;
                break;
              }
            }
          }
        } catch { /* container doesn't exist or daemon unreachable — fall through */ }
      }
      if (!matched) {
        writeAuditEntry("Docker exec BLOCKED (unmanaged container)", "modify", `${containerId}: ${command.join(" ")}`, false);
        return {
          error: `Refusing to exec into "${containerId}" — Talome didn't install this container and won't exec into arbitrary containers on the host. Install it through Talome, or set TALOME_ALLOW_UNMANAGED_EXEC=true in permissive mode to override.`,
        };
      }
    }

    // Cautious mode: allowlist check on the base command
    if (mode === "cautious") {
      const baseCmd = command[0]?.split("/").pop() ?? "";
      if (!SHELL_ALLOWLIST.has(baseCmd)) {
        writeAuditEntry("Docker exec BLOCKED (not in allowlist)", "modify", `${containerId}: ${command.join(" ")}`, false);
        return { error: `Command "${baseCmd}" is not in the allowed list for cautious mode. An admin can switch to permissive mode in Settings > Security.` };
      }
    }

    writeAuditEntry(
      "Docker exec",
      "modify",
      `${containerId}: ${command.join(" ")}`
    );
    const result = await execInContainer(containerId, command);

    return {
      containerId,
      command: command.join(" "),
      exitCode: result.exitCode,
      output: result.output,
      summary:
        result.exitCode === 0
          ? `Command succeeded (exit 0).`
          : `Command failed with exit code ${result.exitCode}.`,
      status: result.exitCode === 0 ? "ok" : "error",
      alerts:
        result.exitCode !== 0
          ? [`Exit code ${result.exitCode}: ${result.output.slice(0, 200)}`]
          : [],
    };
  },
});

export const createNetworkTool = tool({
  description: "Create a new Docker network for connecting containers.",
  inputSchema: z.object({
    name: z.string().describe("Network name"),
    driver: z.enum(["bridge", "overlay", "macvlan"]).default("bridge").describe("Network driver"),
  }),
  execute: async ({ name, driver }) => {
    try {
      const result = await createNetwork(name, driver);
      writeAuditEntry(`Created Docker network: ${name}`, "modify", `Driver: ${driver}`);
      return { success: true, id: result.id, message: `Network "${name}" created` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const connectContainerToNetworkTool = tool({
  description: "Connect a container to a Docker network so it can communicate with other containers on that network.",
  inputSchema: z.object({
    network: z.string().describe("Network name"),
    container: z.string().describe("Container name or ID"),
  }),
  execute: async ({ network, container }) => {
    try {
      await connectContainerToNetwork(network, container);
      return { success: true, message: `Container "${container}" connected to network "${network}"` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const disconnectContainerTool = tool({
  description: "Disconnect a container from a Docker network.",
  inputSchema: z.object({
    network: z.string().describe("Network name"),
    container: z.string().describe("Container name or ID"),
  }),
  execute: async ({ network, container }) => {
    try {
      await disconnectContainerFromNetwork(network, container);
      return { success: true, message: `Container "${container}" disconnected from network "${network}"` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const removeNetworkTool = tool({
  description: "Remove a Docker network. The network must have no connected containers.",
  inputSchema: z.object({
    name: z.string().describe("Network name"),
  }),
  execute: async ({ name }) => {
    try {
      await removeNetwork(name);
      writeAuditEntry(`Removed Docker network: ${name}`, "destructive");
      return { success: true, message: `Network "${name}" removed` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});
