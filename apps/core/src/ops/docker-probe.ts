// ── Docker probes for safe updates ────────────────────────────────────────────
//
// Everything the update pipeline needs to know about an app's live containers:
// which image each service runs (ref + image id + repo digest) so a rollback can
// restore the exact bytes, and whether the app is actually healthy after a
// recreate (running, healthcheck healthy, not restart-looping, HTTP answering).
//
// Only public docker/client exports are used. Container listings go straight
// to the Docker API (not the cached listContainers()): verification must see
// the containers `up -d` just created, never a stale list of removed ones.

import { docker } from "../docker/client.js";
import { run } from "../stores/compose-exec.js";

/** Minimal container view used by the probes (fresh from the Docker API). */
export interface ProbeContainer {
  id: string;
  name: string;
  image: string;
  /** Docker state: running | restarting | exited | created | paused | dead */
  status: string;
  labels: Record<string, string>;
}

export interface ServiceImageState {
  service: string;
  containerId: string;
  containerName: string;
  /** Image reference from the container config (e.g. "linuxserver/sonarr:4.0") */
  imageRef: string;
  /** Local image id the container was created from ("sha256:…") */
  imageId: string | null;
  /** Registry digest reference ("repo@sha256:…") when known — survives local prunes */
  repoDigest: string | null;
  /** Container state at capture time */
  status: string;
}

export interface ContainerHealthState {
  id: string;
  name: string;
  service: string;
  status: string;
  /** healthy | unhealthy | starting | none | unknown (inspect failed) */
  health: string;
  restartCount: number;
  /**
   * How long the image's healthcheck may legitimately report "starting":
   * start_period + interval × retries (ms). Absent without a healthcheck.
   */
  healthcheckBudgetMs?: number;
  /** Set when the container could not be inspected (e.g. removed meanwhile). */
  inspectError?: string;
}

export interface HttpProbeResult {
  port: number;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface VerifyOptions {
  composePath?: string;
  /** Services that were running before the operation — each must be running again. */
  requiredServices?: string[];
  /** Host port of the web UI; probed when requireHttp is true. */
  webPort?: number | null;
  requireHttp?: boolean;
  /**
   * Base deadline. Extended — up to maxTimeoutMs — while a container's
   * healthcheck is still inside its own start_period + interval × retries.
   */
  timeoutMs?: number;
  /** Hard cap for the healthcheck-derived extension (default 15 min). */
  maxTimeoutMs?: number;
  intervalMs?: number;
  /** Consecutive all-good observations required (guards against crash loops). */
  stableChecks?: number;
  /** Consecutive hard-failure observations before giving up early (default 3). */
  hardFailChecks?: number;
}

/**
 * healthy      — verified up.
 * unhealthy    — a hard failure: container exited, healthcheck unhealthy, or
 *                restart-looping. Safe to act on (e.g. roll back).
 * inconclusive — still settling at the deadline ("starting" healthcheck, UI
 *                answering 5xx / not yet listening, container could not be
 *                inspected). The app may be mid-migration: do NOT roll back.
 */
export type VerifyVerdict = "healthy" | "unhealthy" | "inconclusive";

export interface VerifyResult {
  healthy: boolean;
  verdict: VerifyVerdict;
  reason: string;
  containers: ContainerHealthState[];
  http?: HttpProbeResult;
  checks: number;
  elapsedMs: number;
}

// Image references come from Docker itself, but are interpolated into shell
// commands — accept only the characters a valid reference can contain.
const IMAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

export function isSafeImageRef(ref: string): boolean {
  return ref.length > 0 && ref.length < 512 && IMAGE_REF_PATTERN.test(ref);
}

function nameMatchesApp(name: string, appId: string): boolean {
  const n = name.toLowerCase();
  const id = appId.toLowerCase();
  return n === id || n.startsWith(`${id}-`) || n.startsWith(`${id}_`);
}

/** Compose's default project name for an app directory named after the app id. */
export function composeProjectName(appId: string): string {
  return appId.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

const PROJECT_LABEL = "com.docker.compose.project";
const CONFIG_FILES_LABEL = "com.docker.compose.project.config_files";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** All containers, straight from the Docker API (bypasses any list cache). */
export async function listContainersFresh(): Promise<ProbeContainer[]> {
  const raw = await withTimeout(docker.listContainers({ all: true }), 15_000, "listContainers");
  return raw.map((c) => ({
    id: c.Id.slice(0, 12),
    name: c.Names?.[0]?.replace(/^\//, "") || c.Id.slice(0, 12),
    image: c.Image,
    status: (c.State ?? "unknown").toLowerCase(),
    labels: c.Labels ?? {},
  }));
}

/**
 * Pick an app's containers out of a listing.
 *
 * Compose labels are authoritative: containers whose config_files label names
 * the app's compose file, or whose project label is the app's project. Only
 * when no labelled container exists does the container-name heuristic apply,
 * and even then a container of a *different* compose project whose name merely
 * starts with the id (plex → plex-meta-manager, sonarr → sonarr-4k) is excluded.
 */
export function selectAppContainers<T extends { name: string; labels: Record<string, string> }>(
  all: T[],
  appId: string,
  composePath?: string,
): T[] {
  const project = composeProjectName(appId);
  const labelled = all.filter((c) => {
    const files = c.labels[CONFIG_FILES_LABEL];
    if (composePath && files && files.split(",").map((f) => f.trim()).includes(composePath)) return true;
    return c.labels[PROJECT_LABEL] === project;
  });
  if (labelled.length > 0) return labelled;
  return all.filter((c) => {
    const otherProject = c.labels[PROJECT_LABEL];
    if (otherProject && otherProject !== project && nameMatchesApp(otherProject, appId)) return false;
    return nameMatchesApp(c.name, appId);
  });
}

/** Containers belonging to an app (fresh listing; see selectAppContainers). */
export async function findAppContainers(appId: string, composePath?: string): Promise<ProbeContainer[]> {
  return selectAppContainers(await listContainersFresh(), appId, composePath);
}

function serviceOf(c: ProbeContainer): string {
  return c.labels["com.docker.compose.service"] ?? c.name;
}

function pickRepoDigest(repoDigests: string[], imageRef: string): string | null {
  if (repoDigests.length === 0) return null;
  const refRepo = splitImageRef(imageRef).repo;
  const match = repoDigests.find((d) => d.split("@")[0] === refRepo);
  return match ?? repoDigests[0] ?? null;
}

/** Split "registry:5000/org/name:tag" into repo + tag (digest refs return tag null). */
export function splitImageRef(ref: string): { repo: string; tag: string | null } {
  if (ref.includes("@")) return { repo: ref.split("@")[0], tag: null };
  const lastSlash = ref.lastIndexOf("/");
  const lastColon = ref.lastIndexOf(":");
  if (lastColon > lastSlash) return { repo: ref.slice(0, lastColon), tag: ref.slice(lastColon + 1) };
  return { repo: ref, tag: "latest" };
}

/**
 * Capture the image each service currently runs. Must be called BEFORE pulling:
 * after a pull the tag points at the new image, but containers still hold the
 * old image id, which is what we record.
 */
export async function captureServiceImages(appId: string, composePath?: string): Promise<ServiceImageState[]> {
  const containers = await findAppContainers(appId, composePath);
  const states: ServiceImageState[] = [];
  for (const c of containers) {
    let imageRef = c.image;
    let imageId: string | null = null;
    let repoDigest: string | null = null;
    try {
      const info = await docker.getContainer(c.id).inspect();
      imageRef = info.Config?.Image || c.image;
      imageId = info.Image || null;
      if (imageId) {
        try {
          const img = await docker.getImage(imageId).inspect();
          repoDigest = pickRepoDigest(img.RepoDigests ?? [], imageRef);
        } catch {
          // Image may be local-only — no digest
        }
      }
    } catch {
      // Container vanished between list and inspect — keep what we have
    }
    states.push({
      service: serviceOf(c),
      containerId: c.id,
      containerName: c.name,
      imageRef,
      imageId,
      repoDigest,
      status: c.status,
    });
  }
  return states;
}

const NS_PER_MS = 1_000_000;
// Docker's defaults when a healthcheck omits them.
const DEFAULT_HC_INTERVAL_MS = 30_000;
const DEFAULT_HC_RETRIES = 3;

interface HealthcheckConfig {
  Test?: string[];
  Interval?: number;
  StartPeriod?: number;
  Retries?: number;
}

/** start_period + interval × retries for an image/compose healthcheck (ms), or undefined. */
export function healthcheckBudgetMs(hc: HealthcheckConfig | undefined | null): number | undefined {
  if (!hc || !Array.isArray(hc.Test) || hc.Test.length === 0 || hc.Test[0] === "NONE") return undefined;
  const interval = hc.Interval && hc.Interval > 0 ? hc.Interval / NS_PER_MS : DEFAULT_HC_INTERVAL_MS;
  const retries = hc.Retries && hc.Retries > 0 ? hc.Retries : DEFAULT_HC_RETRIES;
  const startPeriod = hc.StartPeriod && hc.StartPeriod > 0 ? hc.StartPeriod / NS_PER_MS : 0;
  return Math.round(startPeriod + interval * retries);
}

export async function inspectContainerHealth(c: ProbeContainer): Promise<ContainerHealthState> {
  const base: ContainerHealthState = {
    id: c.id,
    name: c.name,
    service: serviceOf(c),
    status: c.status,
    health: "none",
    restartCount: 0,
  };
  try {
    const info = await docker.getContainer(c.id).inspect();
    const state = info.State as typeof info.State & { Health?: { Status?: string } };
    const config = info.Config as (typeof info.Config & { Healthcheck?: HealthcheckConfig }) | undefined;
    const budget = healthcheckBudgetMs(config?.Healthcheck);
    return {
      ...base,
      status: state.Restarting ? "restarting" : state.Running ? "running" : (state.Status ?? c.status),
      health: state.Health?.Status ?? "none",
      restartCount: (info as typeof info & { RestartCount?: number }).RestartCount ?? 0,
      ...(budget !== undefined ? { healthcheckBudgetMs: budget } : {}),
    };
  } catch (err) {
    // Never report a container we could not inspect as healthy.
    return { ...base, status: "unknown", health: "unknown", inspectError: err instanceof Error ? err.message : String(err) };
  }
}

export async function probeHttp(port: number, timeoutMs = 5_000): Promise<HttpProbeResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    // Any answer below 500 means the app is serving (401/302 are normal for UIs).
    // 5xx is not "ok", but the verifier treats it as still settling (maintenance
    // pages during migrations answer 503), never as a hard failure.
    return { port, ok: res.status < 500, status: res.status };
  } catch (err) {
    return { port, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Hard failures justify acting (rollback); soft ones mean "still settling". */
type Problem = { hard: boolean; reason: string };

function classifyObservation(
  states: ContainerHealthState[],
  opts: VerifyOptions,
  firstRestartCounts: Map<string, number>,
  lastRestartCounts: Map<string, number>,
): Problem | null {
  if (states.length === 0) return { hard: true, reason: "No containers found for the app" };

  // Restart accounting first — it decides whether "restarting" is a loop.
  let restartProblem: Problem | null = null;
  for (const s of states) {
    if (s.inspectError) continue;
    const first = firstRestartCounts.get(s.id);
    const last = lastRestartCounts.get(s.id);
    if (first === undefined) firstRestartCounts.set(s.id, s.restartCount);
    lastRestartCounts.set(s.id, s.restartCount);
    const total = s.restartCount - (first ?? s.restartCount);
    if (total >= 2) {
      restartProblem = { hard: true, reason: `Container ${s.name} restarted ${total} time(s) during verification (restart loop)` };
      break;
    }
    if (!restartProblem && last !== undefined && s.restartCount > last) {
      // A single restart (e.g. an init step exiting once) is not yet a loop —
      // but the container must stay up for the full stability window again.
      restartProblem = { hard: false, reason: `Container ${s.name} restarted ${total} time(s) during verification` };
    }
  }
  if (restartProblem?.hard) return restartProblem;

  const required = opts.requiredServices ?? [];
  for (const svc of required) {
    const svcStates = states.filter((s) => s.service === svc);
    if (svcStates.some((s) => s.status === "running")) continue;
    if (svcStates.some((s) => s.status === "restarting" || s.inspectError)) {
      return { hard: false, reason: `Service "${svc}" is not running yet` };
    }
    return { hard: true, reason: `Service "${svc}" is not running` };
  }
  if (required.length === 0 && !states.some((s) => s.status === "running")) {
    if (states.some((s) => s.status === "restarting" || s.inspectError)) {
      return { hard: false, reason: "No container is running yet" };
    }
    return { hard: true, reason: "No container is running" };
  }

  const unhealthy = states.find((s) => s.status === "running" && s.health === "unhealthy");
  if (unhealthy) return { hard: true, reason: `Container ${unhealthy.name} healthcheck is unhealthy` };

  if (restartProblem) return restartProblem;

  const restarting = states.find((s) => s.status === "restarting");
  if (restarting) return { hard: false, reason: `Container ${restarting.name} is restarting` };

  const uninspected = states.find((s) => s.inspectError);
  if (uninspected) return { hard: false, reason: `Container ${uninspected.name} could not be inspected (${uninspected.inspectError})` };

  const starting = states.find((s) => s.status === "running" && s.health === "starting");
  if (starting) return { hard: false, reason: `Container ${starting.name} healthcheck is starting` };

  return null;
}

/**
 * Wait until the app is verifiably healthy, fails hard, or the deadline passes.
 *
 * Healthy means: every required service (or, when none are known, at least one
 * container) is running, no container is restarting, every container with a
 * healthcheck reports healthy, restart counts are stable, and — when requested —
 * the web port answers HTTP below 500. The all-good state must hold for
 * `stableChecks` consecutive observations so a crash loop is not mistaken for up.
 *
 * Only hard failures (exited, unhealthy, restart loop) that persist for
 * `hardFailChecks` observations end verification early as "unhealthy". Slow
 * starts — a healthcheck still "starting" within its own start_period +
 * interval × retries, a UI answering 5xx during a migration — keep waiting and,
 * if the deadline passes, end as "inconclusive" rather than "unhealthy".
 */
export async function verifyAppHealth(appId: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const maxTimeoutMs = Math.max(timeoutMs, opts.maxTimeoutMs ?? 15 * 60_000);
  const intervalMs = opts.intervalMs ?? 3_000;
  const stableChecks = Math.max(1, opts.stableChecks ?? 3);
  const hardFailChecks = Math.max(1, opts.hardFailChecks ?? 3);
  const started = Date.now();
  let deadline = started + timeoutMs;
  const hardCap = started + maxTimeoutMs;

  let consecutiveOk = 0;
  let consecutiveHard = 0;
  let checks = 0;
  let lastProblem: Problem = { hard: false, reason: "No observation yet" };
  let lastContainers: ContainerHealthState[] = [];
  let lastHttp: HttpProbeResult | undefined;
  const firstRestartCounts = new Map<string, number>();
  const lastRestartCounts = new Map<string, number>();

  const result = (verdict: VerifyVerdict, reason: string): VerifyResult => ({
    healthy: verdict === "healthy",
    verdict,
    reason,
    containers: lastContainers,
    ...(lastHttp ? { http: lastHttp } : {}),
    checks,
    elapsedMs: Date.now() - started,
  });

  for (;;) {
    checks++;
    let problem: Problem | null = null;
    try {
      const containers = await findAppContainers(appId, opts.composePath);
      const states = await Promise.all(containers.map(inspectContainerHealth));
      lastContainers = states;

      // A healthcheck still inside its own grace window extends the deadline.
      for (const s of states) {
        if (s.health === "starting" && s.healthcheckBudgetMs !== undefined) {
          deadline = Math.min(hardCap, Math.max(deadline, started + s.healthcheckBudgetMs + intervalMs * stableChecks));
        }
      }

      problem = classifyObservation(states, opts, firstRestartCounts, lastRestartCounts);
      if (!problem && opts.requireHttp && opts.webPort) {
        lastHttp = await probeHttp(opts.webPort);
        if (!lastHttp.ok) {
          problem = {
            hard: false,
            reason: `Web UI on port ${opts.webPort} is not answering (${lastHttp.error ?? `HTTP ${lastHttp.status}`})`,
          };
        }
      }
    } catch (err) {
      problem = { hard: false, reason: `Docker query failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    if (problem) {
      consecutiveOk = 0;
      lastProblem = problem;
      consecutiveHard = problem.hard ? consecutiveHard + 1 : 0;
      if (consecutiveHard >= hardFailChecks) return result("unhealthy", problem.reason);
    } else {
      consecutiveHard = 0;
      consecutiveOk++;
      if (consecutiveOk >= stableChecks) return result("healthy", "All required containers running and healthy");
      lastProblem = { hard: false, reason: "Waiting for containers to stay stable" };
    }

    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }

  return result(lastProblem.hard ? "unhealthy" : "inconclusive", lastProblem.reason);
}

/**
 * Point each service's image tag back at the exact image it ran before the
 * update. Uses the local image id when it still exists, otherwise pulls the
 * recorded repo digest. Returns per-service outcomes; never throws.
 */
export async function restoreServiceImages(
  states: ServiceImageState[],
): Promise<{ service: string; restored: boolean; method?: "tag" | "pull"; error?: string }[]> {
  const results: { service: string; restored: boolean; method?: "tag" | "pull"; error?: string }[] = [];
  const seen = new Set<string>();
  for (const s of states) {
    if (seen.has(s.imageRef)) continue;
    seen.add(s.imageRef);

    if (s.imageRef.includes("@")) {
      // Digest-pinned reference is immutable — nothing to re-point.
      results.push({ service: s.service, restored: true });
      continue;
    }
    if (!isSafeImageRef(s.imageRef)) {
      results.push({ service: s.service, restored: false, error: `Unsafe image reference: ${s.imageRef}` });
      continue;
    }

    if (s.imageId && isSafeImageRef(s.imageId)) {
      try {
        await run(`docker tag "${s.imageId}" "${s.imageRef}"`, { timeout: 30_000 });
        results.push({ service: s.service, restored: true, method: "tag" });
        continue;
      } catch {
        // Old image was pruned — fall through to the digest
      }
    }

    if (s.repoDigest && isSafeImageRef(s.repoDigest)) {
      try {
        await run(`docker pull "${s.repoDigest}"`, { timeout: 600_000 });
        await run(`docker tag "${s.repoDigest}" "${s.imageRef}"`, { timeout: 30_000 });
        results.push({ service: s.service, restored: true, method: "pull" });
        continue;
      } catch (err) {
        results.push({ service: s.service, restored: false, error: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }

    results.push({ service: s.service, restored: false, error: "Previous image is no longer available locally and has no registry digest" });
  }
  return results;
}
