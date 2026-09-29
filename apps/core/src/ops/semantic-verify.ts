// ── Semantic (outcome) verification around updates ────────────────────────────
//
// Container/HTTP verification proves the new version runs. For apps with an
// outcome probe (verification/verifyApp) it can also prove the app still does
// its job — API key valid, root folders reachable, download client wired, …
//
// Regression rule (applied by the update pipeline):
//   last stored result before the update was "verified" and the result after
//   the update is "failed"  → the update broke the app: roll back + notify.
//   "degraded" / "unknown" (or "failed" without a verified baseline)
//                           → record + notify only.
//
// Every run is bounded: per-check timeouts plus an overall deadline. A run that
// cannot finish in time counts as "unknown" — never as a regression.

import type { VerificationStatus } from "../verification/types.js";

export interface SemanticVerification {
  /** False when the app has no outcome probe (nothing was run). */
  ran: boolean;
  /** Last stored status before the update (null when never verified). */
  baseline: VerificationStatus | null;
  status?: VerificationStatus;
  summary?: string;
  /** Non-passing checks, for the operation detail and notifications. */
  problems?: Array<{ id: string; label: string; status: string; evidence: string }>;
  /** baseline "verified" → status "failed" */
  regression: boolean;
  /** Runs made (a failed first run after a verified baseline is retried once). */
  attempts: number;
  durationMs: number;
  error?: string;
}

export interface SemanticVerifyOptions {
  /** Status recorded before the update (see getSemanticBaseline). */
  baseline: VerificationStatus | null;
  /** Overall deadline per run (default TALOME_SEMANTIC_VERIFY_TIMEOUT_MS or 60s). */
  timeoutMs?: number;
  /** Per-check timeout (default 10s). */
  checkTimeoutMs?: number;
  /** Delay before re-checking a suspected regression (default TALOME_SEMANTIC_VERIFY_RETRY_MS or 15s). */
  retryDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.TALOME_SEMANTIC_VERIFY_TIMEOUT_MS) || 60_000;
const DEFAULT_RETRY_MS = Number(process.env.TALOME_SEMANTIC_VERIFY_RETRY_MS) || 15_000;
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

type VerificationModule = typeof import("../verification/index.js");

async function loadVerification(): Promise<VerificationModule | null> {
  try {
    return await import("../verification/index.js");
  } catch {
    return null;
  }
}

/** Does the app have an outcome probe? */
export async function hasSemanticProbe(appId: string): Promise<boolean> {
  const mod = await loadVerification();
  if (!mod) return false;
  try {
    return mod.isVerifiableApp(appId.toLowerCase());
  } catch {
    return false;
  }
}

/** Last stored verification status for the app (read BEFORE changing it). */
export async function getSemanticBaseline(appId: string): Promise<VerificationStatus | null> {
  const mod = await loadVerification();
  if (!mod) return null;
  try {
    return mod.getLatestVerificationResult("app", appId.toLowerCase())?.status ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunOutcome {
  status: VerificationStatus;
  summary: string;
  problems: NonNullable<SemanticVerification["problems"]>;
  error?: string;
}

async function runOnce(mod: VerificationModule, appId: string, timeoutMs: number, checkTimeoutMs: number): Promise<RunOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([mod.verifyApp(appId, { timeoutMs: checkTimeoutMs }), deadline]);
    if (!outcome) {
      return { status: "unknown", summary: `Outcome verification did not finish within ${Math.round(timeoutMs / 1000)}s`, problems: [], error: "timeout" };
    }
    if (!outcome.ok) return { status: "unknown", summary: outcome.error, problems: [], error: outcome.error };
    const r = outcome.result;
    return {
      status: r.status,
      summary: r.summary,
      problems: r.checks
        .filter((c) => c.status !== "pass" && c.status !== "skip")
        .slice(0, 10)
        .map((c) => ({ id: c.id, label: c.label, status: c.status, evidence: c.evidence.slice(0, 300) })),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "unknown", summary: `Outcome verification failed to run: ${message}`, problems: [], error: message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run the app's outcome probe after an update. Never throws. Results are
 * persisted by verifyApp, so they become the next update's baseline.
 */
export async function runSemanticVerification(appId: string, opts: SemanticVerifyOptions): Promise<SemanticVerification> {
  const started = Date.now();
  const id = appId.toLowerCase();
  const mod = await loadVerification();
  if (!mod || !mod.isVerifiableApp(id)) {
    return { ran: false, baseline: opts.baseline, regression: false, attempts: 0, durationMs: 0 };
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const checkTimeoutMs = Math.min(opts.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS, timeoutMs);

  let attempts = 1;
  let run = await runOnce(mod, id, timeoutMs, checkTimeoutMs);
  // A freshly recreated app may need a moment before every integration answers:
  // confirm a suspected regression once before acting on it.
  if (opts.baseline === "verified" && run.status === "failed") {
    await sleep(opts.retryDelayMs ?? DEFAULT_RETRY_MS);
    attempts = 2;
    run = await runOnce(mod, id, timeoutMs, checkTimeoutMs);
  }
  return {
    ran: true,
    baseline: opts.baseline,
    status: run.status,
    summary: run.summary,
    problems: run.problems,
    regression: opts.baseline === "verified" && run.status === "failed",
    attempts,
    durationMs: Date.now() - started,
    ...(run.error ? { error: run.error } : {}),
  };
}
