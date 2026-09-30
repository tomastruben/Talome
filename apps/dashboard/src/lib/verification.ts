/**
 * Client model of core outcome verification (apps/core/src/verification).
 * "Verified" means the app's own API proved the user outcome works — a
 * stronger claim than "container running".
 */

export const VERIFICATION_STATUSES = ["verified", "degraded", "failed", "unknown"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const CHECK_STATUSES = ["pass", "warn", "fail", "timeout", "skip"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface VerificationCheck {
  id: string;
  label: string;
  status: CheckStatus;
  evidence: string;
  remediation?: string;
  critical: boolean;
  active: boolean;
  appId?: string;
}

export interface VerificationChainLink {
  id: string;
  label: string;
  status: CheckStatus;
}

export interface VerificationResult {
  targetType: "app" | "stack";
  targetId: string;
  status: VerificationStatus;
  summary: string;
  checks: VerificationCheck[];
  chain?: VerificationChainLink[];
  verifiedAt: string;
}

const VERIFICATION_STATUS_SET = new Set<string>(VERIFICATION_STATUSES);
const CHECK_STATUS_SET = new Set<string>(CHECK_STATUSES);

function asCheckStatus(value: unknown): CheckStatus {
  return typeof value === "string" && CHECK_STATUS_SET.has(value) ? (value as CheckStatus) : "skip";
}

function parseCheck(raw: unknown): VerificationCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.label !== "string") return null;
  return {
    id: r.id,
    label: r.label,
    status: asCheckStatus(r.status),
    evidence: typeof r.evidence === "string" ? r.evidence : "",
    ...(typeof r.remediation === "string" && r.remediation ? { remediation: r.remediation } : {}),
    critical: r.critical === true,
    active: r.active === true,
    ...(typeof r.appId === "string" ? { appId: r.appId } : {}),
  };
}

/** Parse `{ result }` from GET /api/verification/{apps|stacks}/:id or POST /run. */
export function parseVerificationResponse(raw: unknown): VerificationResult | null {
  if (!raw || typeof raw !== "object") return null;
  const result = (raw as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.status !== "string" || !VERIFICATION_STATUS_SET.has(r.status)) return null;
  const checks = Array.isArray(r.checks) ? r.checks.map(parseCheck).filter((c): c is VerificationCheck => c !== null) : [];
  const chain = Array.isArray(r.chain)
    ? r.chain
        .map((link): VerificationChainLink | null => {
          if (!link || typeof link !== "object") return null;
          const l = link as Record<string, unknown>;
          if (typeof l.id !== "string" || typeof l.label !== "string") return null;
          return { id: l.id, label: l.label, status: asCheckStatus(l.status) };
        })
        .filter((l): l is VerificationChainLink => l !== null)
    : undefined;
  return {
    targetType: r.targetType === "stack" ? "stack" : "app",
    targetId: typeof r.targetId === "string" ? r.targetId : "",
    status: r.status as VerificationStatus,
    summary: typeof r.summary === "string" ? r.summary : "",
    checks,
    ...(chain && chain.length > 0 ? { chain } : {}),
    verifiedAt: typeof r.verifiedAt === "string" ? r.verifiedAt : "",
  };
}

export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  verified: "Verified",
  degraded: "Degraded",
  failed: "Failed",
  unknown: "Not verified",
};

export const CHECK_STATUS_LABELS: Record<CheckStatus, string> = {
  pass: "Passed",
  warn: "Warning",
  fail: "Failed",
  timeout: "Timed out",
  skip: "Skipped",
};

export type VerificationTone = "healthy" | "warning" | "critical" | "muted";

export function verificationTone(status: VerificationStatus): VerificationTone {
  switch (status) {
    case "verified":
      return "healthy";
    case "degraded":
      return "warning";
    case "failed":
      return "critical";
    default:
      return "muted";
  }
}

export function checkTone(status: CheckStatus): VerificationTone {
  switch (status) {
    case "pass":
      return "healthy";
    case "warn":
    case "timeout":
      return "warning";
    case "fail":
      return "critical";
    default:
      return "muted";
  }
}

/** Failing checks first (critical before non-critical), then warnings, then the rest. */
export function sortChecks(checks: readonly VerificationCheck[]): VerificationCheck[] {
  const rank = (c: VerificationCheck): number => {
    if (c.status === "fail") return c.critical ? 0 : 1;
    if (c.status === "timeout") return 2;
    if (c.status === "warn") return 3;
    if (c.status === "pass") return 4;
    return 5;
  };
  return [...checks].sort((a, b) => rank(a) - rank(b));
}
