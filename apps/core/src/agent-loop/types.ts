// ── Agent Loop Types ────────────────────────────────────────────────────────

export type EventSeverity = "info" | "warning" | "critical";

export type EventType =
  | "restart_loop"
  | "container_down"
  | "disk_trend"
  | "disk_reclaimable"
  | "connectivity_broken"
  | "high_cpu"
  | "high_memory"
  | "error_spike"
  | "image_stale"
  | "download_stuck"
  | "service_degraded"
  | "post_update_crash_loop"
  | "process_crash";

export interface SystemEvent {
  id: string;
  type: EventType;
  severity: EventSeverity;
  source: string;
  message: string;
  data: Record<string, unknown>;
  detectedAt: string;
  /** Number of deduplicated occurrences (1 = first/only occurrence) */
  occurrenceCount?: number;
  /** ISO timestamp of the most recent aggregated occurrence */
  lastSeen?: string;
}

export type TriageVerdict = "dismiss" | "notify" | "act";

export interface TriageResult {
  eventId: string;
  verdict: TriageVerdict;
  reason: string;
  suggestedAction?: string;
}

export type RemediationOutcome = "success" | "failure" | "partial" | "pending";

export interface RemediationResult {
  eventId: string;
  action: string;
  model: string;
  confidence: number;
  outcome: RemediationOutcome;
  details: string;
}

export interface AgentLoopConfig {
  enabled: boolean;
  /** Tier 0 check interval in ms (default 60s) */
  checkIntervalMs: number;
  /** Max Haiku (Tier 1) calls per hour */
  maxTriagePerHour: number;
  /** Max Sonnet (Tier 2) calls per hour */
  maxRemediationPerHour: number;
  /** Whether to auto-remediate or just notify */
  autoRemediate: boolean;
  /** Restart count within window to trigger restart_loop event */
  restartLoopThreshold: number;
  /** Window for restart loop detection in ms (default 1h) */
  restartLoopWindowMs: number;
  /** CPU threshold percent */
  highCpuThreshold: number;
  /** Memory threshold percent */
  highMemoryThreshold: number;
  /** Days after which an image is considered stale */
  imageStalenessDays: number;
  /** Cooldown between same detector event type+source in minutes (default 240 = 4 hours) */
  eventCooldownMinutes: number;
}

export const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  enabled: true,
  checkIntervalMs: 60_000,
  maxTriagePerHour: 3,
  maxRemediationPerHour: 1,
  autoRemediate: false,
  restartLoopThreshold: 3,
  restartLoopWindowMs: 60 * 60 * 1000,
  highCpuThreshold: 90,
  highMemoryThreshold: 90,
  imageStalenessDays: 30,
  eventCooldownMinutes: 240,
};
