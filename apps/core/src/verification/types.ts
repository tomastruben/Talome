/**
 * Outcome verification — shared types.
 *
 * "Verified working" is a stronger claim than "container running": every
 * check gathers evidence from the app's own API (or the host) that the user
 * outcome actually works — libraries exist, downloads land where the *arr can
 * import them, the phone can reach Immich, and so on.
 */

export const CHECK_STATUSES = ["pass", "warn", "fail", "timeout", "skip"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const VERIFICATION_STATUSES = ["verified", "degraded", "failed", "unknown"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export type VerificationTargetType = "app" | "stack";

/** What a check's `run` returns. Timeouts are produced by the runner, never by a check. */
export interface CheckOutcome {
  status: Exclude<CheckStatus, "timeout">;
  /** Human-readable proof of the result. Never contains secrets (redacted by the runner). */
  evidence: string;
  /** What the user (or the assistant) should do to fix a non-passing check. */
  remediation?: string;
}

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  evidence: string;
  durationMs: number;
  remediation?: string;
  /** A failing critical check fails the whole target; others only degrade it. */
  critical: boolean;
  /** Active checks have side effects and only run when explicitly requested. */
  active: boolean;
  /** App this check is about (set on stack checks). */
  appId?: string;
}

/** One stage of a stack's outcome chain (e.g. request → indexer → download → import → library). */
export interface ChainLink {
  id: string;
  label: string;
  status: CheckStatus;
  checkIds: string[];
}

export interface VerificationResult {
  targetType: VerificationTargetType;
  targetId: string;
  status: VerificationStatus;
  summary: string;
  checks: CheckResult[];
  /** Stack results only: the outcome chain, in order. */
  chain?: ChainLink[];
  includeActive: boolean;
  durationMs: number;
  verifiedAt: string;
}

export interface VerifyOptions {
  /** Run checks flagged `active` (side effects, disposable test data). Off by default. */
  includeActive?: boolean;
  /** Default per-check timeout in ms (individual checks may override). */
  timeoutMs?: number;
  /** Persist the result so GET endpoints can return it later. Defaults to true. */
  persist?: boolean;
}
