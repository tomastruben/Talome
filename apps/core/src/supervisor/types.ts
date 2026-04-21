// ── Process Supervisor Types ────────────────────────────────────────────────

export type ProcessName = "core" | "dashboard" | "terminal_daemon";

export type ProcessStatus = "starting" | "healthy" | "unhealthy" | "crashed" | "stopped";

export type EscalationLevel = "restart" | "diagnose" | "revert" | "stopped";

export type SupervisorEventType =
  | "crash"
  | "restart"
  | "health_fail"
  | "diagnosis"
  | "revert"
  | "escalation"
  | "known_good";

export interface ProcessConfig {
  name: ProcessName;
  healthUrl: string;
  command: string;
  args: string[];
  cwd: string;
  /** Terminal daemon runs detached — supervisor only monitors via health endpoint */
  detached: boolean;
  env?: Record<string, string>;
}

export interface ProcessState {
  config: ProcessConfig;
  pid: number | null;
  status: ProcessStatus;
  consecutiveFailures: number;
  /** Ring buffer of recent crash timestamps */
  crashTimestamps: number[];
  lastHealthyAt: number | null;
  startedAt: number | null;
  backoffMs: number;
  escalationLevel: EscalationLevel;
  /** Circular buffer of last 200 lines of stderr */
  logBuffer: string[];
  /** Pending restart timer */
  restartTimer: ReturnType<typeof setTimeout> | null;
  /** Grace period after evolution restart — no escalation beyond Level 1 until this time */
  postEvolutionGraceUntil: number | null;
  /** Whether autofix was already attempted in this escalation cycle */
  autofixAttempted?: boolean;
}

export interface SupervisorConfig {
  /** Health check polling interval */
  healthCheckIntervalMs: number;
  /** HTTP timeout for each health check */
  healthCheckTimeoutMs: number;
  /** Consecutive health failures before marking unhealthy */
  failuresForUnhealthy: number;
  /** Initial restart backoff delay */
  initialBackoffMs: number;
  /** Maximum backoff delay */
  maxBackoffMs: number;
  /** Backoff multiplier */
  backoffMultiplier: number;
  /** Number of crashes in window before escalating to diagnosis */
  crashesBeforeDiagnosis: number;
  /** Number of crashes in window before escalating to revert */
  crashesBeforeRevert: number;
  /** Crash counting window */
  crashWindowMs: number;
  /** How long all processes must be healthy before tagging known-good */
  stabilityWindowMs: number;
  /** Grace period after spawn before health failures count */
  startupGraceMs: number;
  /** Maximum AI diagnosis calls per day */
  maxDiagnosesPerDay: number;
  /** Whether git-based auto-revert is enabled */
  autoRevertEnabled: boolean;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  healthCheckIntervalMs: 5_000,
  healthCheckTimeoutMs: 3_000,
  failuresForUnhealthy: 3,
  initialBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  backoffMultiplier: 2,
  crashesBeforeDiagnosis: 3,
  crashesBeforeRevert: 5,
  crashWindowMs: 5 * 60 * 1000,       // 5 minutes
  stabilityWindowMs: 5 * 60 * 1000,   // 5 minutes
  startupGraceMs: 30_000,             // 30 seconds
  maxDiagnosesPerDay: 3,
  autoRevertEnabled: true,
};

export interface DiagnosticsBundle {
  processName: string;
  exitCode: number | null;
  exitSignal: string | null;
  crashCount: number;
  logTail: string;
  recentCommits: string;
  uncommittedChanges: string;
  systemResources: {
    cpu: number;
    memPercent: number;
    diskPercent: number;
  };
  recentEvolutionRuns: string;
  recentAuditEntries: string;
}

export interface DiagnosisResult {
  rootCause: string;
  confidence: number;
  recommendedAction: "restart" | "revert_evolution" | "revert_uncommitted" | "notify_user" | "none";
  model: string;
  costUsd: number;
}

export interface SupervisorStateSnapshot {
  processes: Record<ProcessName, {
    pid: number | null;
    status: ProcessStatus;
    escalationLevel: EscalationLevel;
    consecutiveFailures: number;
    lastHealthyAt: number | null;
    startedAt: number | null;
    totalCrashes: number;
  }>;
  lastKnownGoodTag: string | null;
  uptime: number;
  timestamp: string;
}
