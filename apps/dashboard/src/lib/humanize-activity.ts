import type { AuditLogEntry } from "@talome/types";

// ── Shared types for unified timeline ────────────────────────────────────────

export interface AgentEvent {
  id: string;
  type: string;
  severity: string;
  source: string;
  message: string;
  displayMessage?: string;
  triageVerdict: string | null;
  createdAt: string;
}

export interface AgentRemediation {
  id: string;
  eventId: string;
  action: string;
  outcome: string;
  confidence: number;
  createdAt: string;
}

export interface EvolutionEntry {
  id: string;
  timestamp: string;
  task: string;
  scope: string;
  filesChanged: string[];
  typeErrors: string;
  rolledBack: boolean;
  duration: number;
}

export type UnifiedTimelineItem =
  | { kind: "audit"; ts: string; data: AuditLogEntry }
  | { kind: "event"; ts: string; data: AgentEvent }
  | { kind: "evolution"; ts: string; data: EvolutionEntry }
  | { kind: "remediation"; ts: string; data: AgentRemediation };

// ── Dot colors (semantic Tailwind classes) ───────────────────────────────────

const DOT_CRITICAL = "bg-status-critical";
const DOT_WARNING = "bg-status-warning";
const DOT_HEALTHY = "bg-status-healthy";
const DOT_NEUTRAL = "bg-muted-foreground/30";

// ── Event type labels ────────────────────────────────────────────────────────

export const eventTypeLabels: Record<string, string> = {
  container_down: "Container stopped",
  restart_loop: "Container restarting",
  high_memory: "High memory usage",
  high_cpu: "High CPU usage",
  disk_trend: "Disk usage warning",
  disk_reclaimable: "Reclaimable disk space",
  image_stale: "Outdated container image",
  connectivity_broken: "Connectivity issue",
  error_spike: "Error spike detected",
  download_stuck: "Download stuck",
  service_degraded: "Service degraded",
  post_update_crash_loop: "Post-update crash loop",
};

// ── Humanize audit log action ────────────────────────────────────────────────

/** Try to extract a single field from a JSON string. Returns null on failure. */
function tryJsonField(json: string | undefined | null, field: string): string | null {
  if (!json || !json.startsWith("{")) return null;
  try { return (JSON.parse(json) as Record<string, unknown>)[field] as string ?? null; } catch { return null; }
}

export function humanizeAction(entry: AuditLogEntry): string {
  const { action, details } = entry;

  // AI tool calls
  if (action.startsWith("AI: ")) {
    const tool = action.slice(4);
    const appMatch = tool.match(/\((.+?)\)/);
    const app = appMatch?.[1];

    if (tool.startsWith("set_app_env")) return `Changed environment variable for ${app ?? "app"}`;
    if (tool.startsWith("change_port_mapping")) return `Changed port mapping for ${app ?? "app"}`;
    if (tool.startsWith("add_volume_mount")) return `Added volume mount for ${app ?? "app"}`;
    if (tool.startsWith("set_resource_limits")) return `Set resource limits for ${app ?? "app"}`;
    if (tool.startsWith("upgrade_app_image")) return `Upgraded image for ${app ?? "app"}`;
    if (tool.startsWith("write_app_config_file")) return `Updated config file for ${app ?? "app"}`;
    if (tool === "apply_change") return "Applied code change";
    if (tool === "plan_change") return "Planned code change";
    if (tool === "rollback_change") return "Rolled back code change";
    if (tool === "evolution_execute") return "Started self-improvement";
    if (tool.startsWith("create_automation")) return `Created automation${details ? `: ${details}` : ""}`;
    if (tool.startsWith("update_automation")) return `Updated automation${details ? `: ${details}` : ""}`;
    if (tool.startsWith("delete_automation")) return `Deleted automation${details ? `: ${details}` : ""}`;
    if (tool === "creator_execute") return `Started app creation${details ? `: ${details}` : ""}`;
    if (tool === "creator_complete") return `Completed app creation${details ? `: ${details}` : ""}`;
    if (tool === "create_widget_manifest") return "Created widget layout";
    if (tool === "update_widget_manifest") return "Updated widget layout";
    if (tool === "rollback_file") return "Rolled back file";
    if (tool === "create_tool") return `Created custom tool${details ? `: ${details}` : ""}`;
    if (tool === "reload_tools") return "Reloaded custom tools";
    if (tool === "track_issue") {
      const title = tryJsonField(details, "title");
      return title ? `Tracked issue: ${title}` : "Tracked issue";
    }
    return `AI tool: ${tool.replace(/_/g, " ")}`;
  }

  // MCP calls
  if (action.startsWith("MCP: ")) {
    return `External tool: ${action.slice(5).replace(/_/g, " ")}`;
  }

  // Agent loop
  if (action.startsWith("Agent loop: ")) {
    return `Auto-${action.slice(12)}`;
  }

  // Container actions
  if (action === "Started" || action === "Stopped" || action === "Restarted" || action === "Removed") {
    return details ? `${action} ${details}` : `${action} container`;
  }

  // App actions
  if (action.endsWith(" app")) {
    return details ? `${action}: ${details}` : action;
  }

  // Bulk operations
  if (action.startsWith("Bulk ")) {
    return details ? `${action}: ${details}` : action;
  }

  // Group operations
  if (action.startsWith("Group ") || action.startsWith("Create app group") || action.startsWith("Update app group") || action.startsWith("Delete app group")) {
    return details ? `${action}: ${details}` : action;
  }

  // Network operations
  if (action.startsWith("Created Docker network") || action.startsWith("Removed Docker network") ||
      action.startsWith("Created network") || action.startsWith("Removed network")) {
    return action;
  }

  // Backup/Restore
  if (action.startsWith("Backup: ") || action.startsWith("Restore: ")) {
    return action.startsWith("Backup: ") ? `Backed up ${action.slice(8)}` : `Restored ${action.slice(9)}`;
  }

  // Docker operations
  if (action === "Docker prune") return "Cleaned up Docker resources";
  if (action === "Docker exec") return details ? `Ran command in ${details.split(":")[0]}` : "Ran command in container";

  // Config patches
  if (action.startsWith("config patch: ")) return `Updated config for ${action.slice(14)}`;

  // Shell
  if (action.startsWith("run_shell: ")) return "Ran shell command";

  // Store
  if (action === "Added store") return details ? `Added app store: ${details}` : "Added app store";

  // Fallback
  return details ? `${action}: ${details}` : action;
}

// ── Humanize agent event message ─────────────────────────────────────────────

export function humanizeEventMessage(e: AgentEvent): string {
  const msg = e.displayMessage || e.message;

  if (msg.toLowerCase().includes("check the full error") || msg.toLowerCase().includes("see below") || !msg.trim()) {
    const label = eventTypeLabels[e.type] ?? e.type.replace(/_/g, " ");
    return e.source ? `${label} — ${e.source}` : label;
  }

  return msg;
}

// ── Humanize unified timeline item ───────────────────────────────────────────

export function humanizeUnifiedItem(item: UnifiedTimelineItem): { text: string; dotColor: string } {
  switch (item.kind) {
    case "audit": {
      const entry = item.data;
      const color =
        entry.tier === "destructive" ? DOT_CRITICAL :
        entry.tier === "modify" ? DOT_WARNING :
        DOT_NEUTRAL;
      return { text: humanizeAction(entry), dotColor: color };
    }
    case "event": {
      const e = item.data;
      const color =
        e.severity === "critical" ? DOT_CRITICAL :
        e.severity === "warning" ? DOT_WARNING :
        DOT_NEUTRAL;
      return { text: humanizeEventMessage(e), dotColor: color };
    }
    case "evolution": {
      const e = item.data;
      return {
        text: e.rolledBack ? `Reverted: ${e.task}` : `Applied: ${e.task}`,
        dotColor: e.rolledBack ? DOT_CRITICAL : DOT_HEALTHY,
      };
    }
    case "remediation": {
      const r = item.data;
      const label = r.outcome === "success" ? "Fixed" : r.outcome === "failure" ? "Failed to fix" : "Attempted";
      return {
        text: `${label}: ${r.action}`,
        dotColor:
          r.outcome === "success" ? DOT_HEALTHY :
          r.outcome === "failure" ? DOT_CRITICAL :
          DOT_WARNING,
      };
    }
  }
}

// ── Filter logic ─────────────────────────────────────────────────────────────

export type FilterType = "all" | "system" | "apps" | "ai" | "blocked";

export function matchesFilter(item: UnifiedTimelineItem, filter: FilterType): boolean {
  if (filter === "all") return true;

  if (item.kind === "audit") {
    const entry = item.data;
    if (filter === "blocked") return !entry.approved;

    const a = entry.action.toLowerCase();

    if (filter === "ai") {
      return a.startsWith("ai: ") || a.startsWith("mcp: ") || a.startsWith("agent loop:") || a.startsWith("automation");
    }
    if (filter === "apps") {
      return a.endsWith(" app") || a.startsWith("bulk ") || a.startsWith("group ") ||
        a.startsWith("backup:") || a.startsWith("restore:") ||
        a.includes("install") || a.includes("update") || a === "added store";
    }
    if (filter === "system") {
      return a === "started" || a === "stopped" || a === "restarted" || a === "removed" ||
        a.includes("network") || a.includes("docker") || a.includes("disk") ||
        a.startsWith("run_shell") || a.startsWith("config patch");
    }
    return true;
  }

  // Non-audit items (events, evolutions, remediations) are AI/system-originated
  if (filter === "blocked") return false;
  if (filter === "ai") return item.kind === "evolution" || item.kind === "remediation";
  if (filter === "system") return item.kind === "event";
  if (filter === "apps") return false;

  return true;
}

// ── Priority ordering for suggestions ────────────────────────────────────────

export const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
