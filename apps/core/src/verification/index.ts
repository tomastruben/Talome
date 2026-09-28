/**
 * Outcome verification — "verified working" instead of "container running".
 *
 *   verifyApp("sonarr")          → API key valid, root folder accessible,
 *                                  download client healthy, indexers present
 *   verifyStack("media-server")  → request → indexer → download → import → library
 *
 * All default checks are read-only. Checks flagged `active` (side effects,
 * disposable test data) only run with { includeActive: true }.
 */

import { createProbeEnv, type ProbeEnv, type ProbeEnvDeps } from "./env.js";
import { getAppName } from "./http.js";
import { getAppProbe, listProbedApps } from "./probes/index.js";
import { aggregateStatus, runChecks, summarize, worstStatus } from "./runner.js";
import { getStackPlan, listVerifiableStacks, resolveStackId } from "./stacks.js";
import { saveVerificationResult } from "./store.js";
import type { ChainLink, CheckResult, VerificationResult, VerifyOptions } from "./types.js";

export type { VerificationResult, VerifyOptions, CheckResult, ChainLink, VerificationStatus, CheckStatus } from "./types.js";
export { getLatestVerificationResult, getVerificationHistory } from "./store.js";
export { listVerifiableStacks, resolveStackId } from "./stacks.js";
export { listProbedApps } from "./probes/index.js";

export interface VerifyRunOptions extends VerifyOptions {
  /** Test seam: inject fetch/settings/docker instead of the real ones. */
  deps?: Partial<ProbeEnvDeps>;
}

export type VerifyOutcome =
  | { ok: true; result: VerificationResult }
  | { ok: false; error: string; code: "unknown_target" };

export function isVerifiableApp(appId: string): boolean {
  return getAppProbe(appId) !== undefined;
}

export function isVerifiableStack(stackId: string): boolean {
  return resolveStackId(stackId) !== null;
}

/** Concurrent requests for the same target share one run instead of hammering the apps. */
const inFlight = new Map<string, Promise<VerifyOutcome>>();

function dedupe(key: string, run: () => Promise<VerifyOutcome>): Promise<VerifyOutcome> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = run().finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

function finish(
  env: ProbeEnv,
  base: Pick<VerificationResult, "targetType" | "targetId">,
  name: string,
  checks: CheckResult[],
  startedAt: number,
  opts: VerifyRunOptions,
  chain?: ChainLink[],
): VerificationResult {
  const status = aggregateStatus(checks);
  const result: VerificationResult = {
    ...base,
    status,
    summary: summarize(name, status, checks),
    checks,
    includeActive: opts.includeActive ?? false,
    durationMs: Math.max(0, Math.round(env.now() - startedAt)),
    verifiedAt: new Date().toISOString(),
  };
  if (chain) result.chain = chain;
  if (opts.persist !== false) saveVerificationResult(result);
  return result;
}

export function verifyApp(appId: string, opts: VerifyRunOptions = {}): Promise<VerifyOutcome> {
  const id = appId.toLowerCase();
  const probe = getAppProbe(id);
  if (!probe) {
    return Promise.resolve({
      ok: false,
      code: "unknown_target",
      error: `No outcome probe for app "${appId}". Verifiable apps: ${listProbedApps().join(", ")}.`,
    });
  }
  return dedupe(`app:${id}:${opts.includeActive ? "active" : "passive"}`, async () => {
    const env = createProbeEnv(opts.deps);
    const startedAt = env.now();
    const checks = await runChecks(probe(), env, { includeActive: opts.includeActive, timeoutMs: opts.timeoutMs });
    return { ok: true, result: finish(env, { targetType: "app", targetId: id }, getAppName(id), checks, startedAt, opts) };
  });
}

function matchesLink(checkId: string, pattern: string): boolean {
  return pattern.endsWith(":") ? checkId.startsWith(pattern) : checkId === pattern;
}

export function verifyStack(stackId: string, opts: VerifyRunOptions = {}): Promise<VerifyOutcome> {
  const id = resolveStackId(stackId);
  if (!id) {
    return Promise.resolve({
      ok: false,
      code: "unknown_target",
      error: `No outcome probe for stack "${stackId}". Verifiable stacks: ${listVerifiableStacks().map((s) => s.id).join(", ")}.`,
    });
  }
  return dedupe(`stack:${id}:${opts.includeActive ? "active" : "passive"}`, async () => {
    const env = createProbeEnv(opts.deps);
    const plan = getStackPlan(id, env);
    if (!plan) return { ok: false, code: "unknown_target", error: `Unknown stack "${stackId}".` };
    const startedAt = env.now();
    const checks = await runChecks(plan.checks, env, { includeActive: opts.includeActive, timeoutMs: opts.timeoutMs });
    const chain: ChainLink[] = plan.chain.map((link) => {
      const members = checks.filter((c) => link.checkIds.some((p) => matchesLink(c.id, p)));
      return { id: link.id, label: link.label, status: worstStatus(members.map((c) => c.status)), checkIds: members.map((c) => c.id) };
    });
    return { ok: true, result: finish(env, { targetType: "stack", targetId: id }, plan.name, checks, startedAt, opts, chain) };
  });
}
