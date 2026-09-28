// ── Docker probes for safe updates ────────────────────────────────────────────
//
// Everything the update pipeline needs to know about an app's live containers:
// which image each service runs (ref + image id + repo digest) so a rollback can
// restore the exact bytes, and whether the app is actually healthy after a
// recreate (running, healthcheck healthy, not restart-looping, HTTP answering).
//
// Only public docker/client exports are used.

import type { Container } from "@talome/types";
import { docker, listContainers } from "../docker/client.js";
import { run } from "../stores/compose-exec.js";

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
  /** healthy | unhealthy | starting | none */
  health: string;
  restartCount: number;
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
  timeoutMs?: number;
  intervalMs?: number;
  /** Consecutive all-good observations required (guards against crash loops). */
  stableChecks?: number;
}

export interface VerifyResult {
  healthy: boolean;
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

/** Containers belonging to an app: compose config-file label first, then name heuristic. */
export async function findAppContainers(appId: string, composePath?: string): Promise<Container[]> {
  const all = await listContainers();
  return all.filter((c) => {
    const files = c.labels["com.docker.compose.project.config_files"];
    if (composePath && files && files.split(",").map((f) => f.trim()).includes(composePath)) return true;
    return nameMatchesApp(c.name, appId);
  });
}

function serviceOf(c: Container): string {
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

export async function inspectContainerHealth(c: Container): Promise<ContainerHealthState> {
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
    return {
      ...base,
      status: state.Restarting ? "restarting" : state.Running ? "running" : (state.Status ?? c.status),
      health: state.Health?.Status ?? "none",
      restartCount: (info as typeof info & { RestartCount?: number }).RestartCount ?? 0,
    };
  } catch {
    return base;
  }
}

export async function probeHttp(port: number, timeoutMs = 5_000): Promise<HttpProbeResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    // Any answer below 500 means the app is serving (401/302 are normal for UIs).
    return { port, ok: res.status < 500, status: res.status };
  } catch (err) {
    return { port, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the app is verifiably healthy or the timeout expires.
 *
 * Healthy means: every required service (or, when none are known, at least one
 * container) is running, no container is restarting, every container with a
 * healthcheck reports healthy, restart counts are stable, and — when requested —
 * the web port answers HTTP. The all-good state must hold for `stableChecks`
 * consecutive observations so a crash-looping container is not mistaken for up.
 */
export async function verifyAppHealth(appId: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const stableChecks = Math.max(1, opts.stableChecks ?? 3);
  const started = Date.now();
  const deadline = started + timeoutMs;

  let consecutiveOk = 0;
  let checks = 0;
  let lastReason = "No observation yet";
  let lastContainers: ContainerHealthState[] = [];
  let lastHttp: HttpProbeResult | undefined;
  const firstRestartCounts = new Map<string, number>();

  for (;;) {
    checks++;
    let problem: string | null = null;
    try {
      const containers = await findAppContainers(appId, opts.composePath);
      const states = await Promise.all(containers.map(inspectContainerHealth));
      lastContainers = states;

      if (states.length === 0) {
        problem = "No containers found for the app";
      } else {
        const required = opts.requiredServices ?? [];
        for (const svc of required) {
          if (!states.some((s) => s.service === svc && s.status === "running")) {
            problem = `Service "${svc}" is not running`;
            break;
          }
        }
        if (!problem && required.length === 0 && !states.some((s) => s.status === "running")) {
          problem = "No container is running";
        }
        if (!problem) {
          const restarting = states.find((s) => s.status === "restarting");
          if (restarting) problem = `Container ${restarting.name} is restarting`;
        }
        if (!problem) {
          const unhealthy = states.find((s) => s.status === "running" && (s.health === "unhealthy" || s.health === "starting"));
          if (unhealthy) problem = `Container ${unhealthy.name} healthcheck is ${unhealthy.health}`;
        }
        if (!problem) {
          for (const s of states) {
            const first = firstRestartCounts.get(s.id);
            if (first === undefined) firstRestartCounts.set(s.id, s.restartCount);
            else if (s.restartCount > first) {
              problem = `Container ${s.name} restarted ${s.restartCount - first} time(s) during verification`;
              firstRestartCounts.set(s.id, s.restartCount);
              break;
            }
          }
        }
        if (!problem && opts.requireHttp && opts.webPort) {
          lastHttp = await probeHttp(opts.webPort);
          if (!lastHttp.ok) {
            problem = `Web UI on port ${opts.webPort} is not answering (${lastHttp.error ?? `HTTP ${lastHttp.status}`})`;
          }
        }
      }
    } catch (err) {
      problem = `Docker query failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    if (problem) {
      consecutiveOk = 0;
      lastReason = problem;
    } else {
      consecutiveOk++;
      if (consecutiveOk >= stableChecks) {
        return {
          healthy: true,
          reason: "All required containers running and healthy",
          containers: lastContainers,
          ...(lastHttp ? { http: lastHttp } : {}),
          checks,
          elapsedMs: Date.now() - started,
        };
      }
      lastReason = "Waiting for containers to stay stable";
    }

    if (Date.now() + intervalMs > deadline) break;
    await sleep(intervalMs);
  }

  return {
    healthy: false,
    reason: lastReason,
    containers: lastContainers,
    ...(lastHttp ? { http: lastHttp } : {}),
    checks,
    elapsedMs: Date.now() - started,
  };
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
