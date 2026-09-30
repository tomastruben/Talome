/**
 * Check runner — executes typed checks with per-check timeouts, dependency
 * skipping, active-probe gating and secret redaction, then aggregates an
 * overall status.
 */

import type { ProbeEnv } from "./env.js";
import type { ProbeCallContext } from "./http.js";
import { redactSecrets, clip } from "./redact.js";
import type { CheckOutcome, CheckResult, CheckStatus, VerificationStatus } from "./types.js";

export const DEFAULT_CHECK_TIMEOUT_MS = 8_000;

export interface CheckContext extends ProbeCallContext {
  /** Results of checks that already ran in this verification (by id). */
  results: ReadonlyMap<string, CheckResult>;
}

export interface CheckDefinition {
  id: string;
  label: string;
  /** A failing critical check fails the whole target. */
  critical?: boolean;
  /**
   * Has side effects (writes to an app, creates data). Active checks only run
   * when the caller passes includeActive, and must use disposable test data.
   */
  active?: boolean;
  timeoutMs?: number;
  /** Ids of checks that must pass (or warn) before this one is worth running. */
  dependsOn?: string[];
  /** Attributed app for stack checks. */
  appId?: string;
  /** Remediation used when the check times out. */
  timeoutRemediation?: string;
  run: (ctx: CheckContext) => Promise<CheckOutcome>;
}

export interface RunChecksOptions {
  includeActive?: boolean;
  timeoutMs?: number;
}

const USABLE: ReadonlySet<CheckStatus> = new Set<CheckStatus>(["pass", "warn"]);

function finalize(def: CheckDefinition, outcome: Omit<CheckResult, "id" | "label" | "critical" | "active" | "appId">, env: ProbeEnv): CheckResult {
  const result: CheckResult = {
    id: def.id,
    label: def.label,
    status: outcome.status,
    evidence: clip(redactSecrets(outcome.evidence, env.secrets), 600),
    durationMs: Math.max(0, Math.round(outcome.durationMs)),
    critical: def.critical ?? false,
    active: def.active ?? false,
  };
  if (outcome.remediation) result.remediation = clip(redactSecrets(outcome.remediation, env.secrets), 600);
  if (def.appId) result.appId = def.appId;
  return result;
}

async function runOne(def: CheckDefinition, env: ProbeEnv, results: Map<string, CheckResult>, opts: RunChecksOptions): Promise<CheckResult> {
  const startedAt = env.now();

  if (def.active && !opts.includeActive) {
    return finalize(def, {
      status: "skip",
      evidence: "Active probe (makes changes using disposable test data) — not run by default.",
      remediation: "Re-run verification with includeActive to execute this probe.",
      durationMs: 0,
    }, env);
  }

  const blocker = (def.dependsOn ?? [])
    .map((id) => results.get(id))
    .find((r) => !r || !USABLE.has(r.status));
  if (blocker !== undefined || (def.dependsOn ?? []).some((id) => !results.has(id))) {
    const label = blocker?.label ?? "a prerequisite check";
    return finalize(def, {
      status: "skip",
      evidence: `Skipped — depends on "${label}", which did not pass.`,
      durationMs: 0,
    }, env);
  }

  const timeoutMs = def.timeoutMs ?? opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });

  try {
    const outcome = await Promise.race([
      def.run({ env, signal: controller.signal, results }),
      timeout,
    ]);
    if (outcome === "timeout" || timedOut) {
      return finalize(def, {
        status: "timeout",
        evidence: `No answer within ${timeoutMs} ms.`,
        remediation: def.timeoutRemediation ?? "The app is slow or unreachable — check that its container is running and not overloaded, then retry.",
        durationMs: env.now() - startedAt,
      }, env);
    }
    return finalize(def, { ...outcome, durationMs: env.now() - startedAt }, env);
  } catch (err: unknown) {
    if (timedOut) {
      return finalize(def, {
        status: "timeout",
        evidence: `No answer within ${timeoutMs} ms.`,
        remediation: def.timeoutRemediation,
        durationMs: env.now() - startedAt,
      }, env);
    }
    const message = err instanceof Error ? err.message : String(err);
    return finalize(def, {
      status: "fail",
      evidence: `Probe error: ${message}`,
      durationMs: env.now() - startedAt,
    }, env);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run checks sequentially (later checks may depend on earlier ones and reuse cached responses). */
export async function runChecks(defs: CheckDefinition[], env: ProbeEnv, opts: RunChecksOptions = {}): Promise<CheckResult[]> {
  const results = new Map<string, CheckResult>();
  const ordered: CheckResult[] = [];
  for (const def of defs) {
    const result = await runOne(def, env, results, opts);
    results.set(def.id, result);
    ordered.push(result);
  }
  return ordered;
}

/**
 * verified — at least one check passed and nothing failed, warned or timed out
 * degraded — only non-critical problems (fail/timeout/warn)
 * failed   — a critical check failed or timed out
 * unknown  — nothing could be checked (e.g. app not configured)
 */
export function aggregateStatus(checks: CheckResult[]): VerificationStatus {
  const ran = checks.filter((c) => c.status !== "skip");
  if (ran.length === 0) return "unknown";
  if (ran.some((c) => c.critical && (c.status === "fail" || c.status === "timeout"))) return "failed";
  if (ran.some((c) => c.status === "fail" || c.status === "timeout" || c.status === "warn")) return "degraded";
  // A skipped critical check (not configured / prerequisite missing) means we can't vouch for it.
  if (checks.some((c) => c.critical && c.status === "skip" && !c.active)) return "unknown";
  return ran.some((c) => c.status === "pass") ? "verified" : "unknown";
}

/** Worst status across a set of checks (for chain links). */
export function worstStatus(statuses: CheckStatus[]): CheckStatus {
  const order: CheckStatus[] = ["fail", "timeout", "warn", "pass", "skip"];
  for (const s of order) if (statuses.includes(s)) return s;
  return "skip";
}

export function summarize(name: string, status: VerificationStatus, checks: CheckResult[]): string {
  const ran = checks.filter((c) => c.status !== "skip");
  const passed = ran.filter((c) => c.status === "pass").length;
  const problems = ran.filter((c) => c.status !== "pass");
  if (status === "unknown") {
    const first = checks.find((c) => c.status === "skip" && c.critical) ?? checks[0];
    return `${name}: could not be verified${first ? ` — ${first.evidence}` : ""}`;
  }
  if (problems.length === 0) return `${name} verified working — ${passed}/${ran.length} checks passed.`;
  const worst = problems.slice(0, 3).map((c) => `${c.label} (${c.status})`).join(", ");
  return `${name} ${status} — ${passed}/${ran.length} checks passed; issues: ${worst}${problems.length > 3 ? ", …" : ""}.`;
}

/** Shorthand constructors used by probes. */
export const outcome = {
  pass: (evidence: string): CheckOutcome => ({ status: "pass", evidence }),
  warn: (evidence: string, remediation?: string): CheckOutcome => ({ status: "warn", evidence, remediation }),
  fail: (evidence: string, remediation?: string): CheckOutcome => ({ status: "fail", evidence, remediation }),
  skip: (evidence: string, remediation?: string): CheckOutcome => ({ status: "skip", evidence, remediation }),
};

/** Prefix check ids (and their dependencies) so app checks can be embedded in a stack. */
export function prefixChecks(prefix: string, defs: CheckDefinition[], appId?: string): CheckDefinition[] {
  return defs.map((d) => ({
    ...d,
    id: `${prefix}:${d.id}`,
    dependsOn: d.dependsOn?.map((id) => `${prefix}:${id}`),
    appId: d.appId ?? appId,
  }));
}
