/**
 * Automation run and step statuses as the run journal writes them
 * (core automation/engine.ts: runs in `automation_runs.status`, steps in
 * `automation_step_runs.status`). One place for their labels and tones, so the
 * list, the run history and the step rows say the same thing.
 */

export const AUTOMATION_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "blocked_approval",
  "blocked",
  "interrupted",
  "skipped",
] as const;

export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

/** Status grammar: info = in flight, warning = needs you, neutral = didn't run. */
export type AutomationStatusTone = "success" | "error" | "warning" | "info" | "neutral";

const STATUS_META: Record<AutomationStatus, { label: string; tone: AutomationStatusTone }> = {
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  // A step (and so its run) is held until the owner approves the call.
  blocked_approval: { label: "Waiting for approval", tone: "warning" },
  // Refused by the security mode or the automation's grants.
  blocked: { label: "Blocked", tone: "warning" },
  // The server restarted mid-run; Talome never re-runs it on its own.
  interrupted: { label: "Interrupted", tone: "warning" },
  // A step that never ran because an earlier one stopped the run.
  skipped: { label: "Skipped", tone: "neutral" },
};

function isAutomationStatus(value: unknown): value is AutomationStatus {
  return typeof value === "string" && (AUTOMATION_STATUSES as readonly string[]).includes(value);
}

/**
 * The status of a run or step row. Rows written before the run journal have
 * no status: they fall back to the `blocked` and `success` flags.
 */
export function automationStatus(row: {
  status?: string | null;
  success?: boolean | null;
  blocked?: boolean | null;
}): AutomationStatus {
  if (isAutomationStatus(row.status)) return row.status;
  if (row.blocked) return "blocked";
  return row.success ? "succeeded" : "failed";
}

export function automationStatusMeta(status: AutomationStatus): { label: string; tone: AutomationStatusTone } {
  return STATUS_META[status];
}
