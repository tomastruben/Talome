/**
 * Docker operations used by the backup engine. Everything that talks to the
 * Docker daemon or runs `docker compose` lives here so the engine can be
 * tested with this module mocked.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import type { Duplex } from "node:stream";
import { docker, listContainers, startContainer } from "../docker/client.js";
import { errorMessage } from "./fs-utils.js";

export interface AppContainer {
  id: string;
  name: string;
  service: string | null;
  status: string;
  image: string;
}

export interface ContainerState {
  id: string;
  name: string;
  status: string;
  running: boolean;
  health: string | null;
  restartCount: number;
  image: string;
  imageId: string | null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const OUTPUT_LIMIT = 64 * 1024;

function normalizeProjectName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function isNotModified(err: unknown): boolean {
  const e = err as { statusCode?: number } | null;
  return e?.statusCode === 304;
}

/** Containers belonging to an app's compose project. */
export async function listAppContainers(opts: {
  appId: string;
  composePath: string;
  projectName?: string | null;
}): Promise<AppContainer[]> {
  const all = await listContainers();
  const project = normalizeProjectName(opts.projectName ?? basename(dirname(opts.composePath)));
  const byLabel = all.filter((c) => {
    const files = c.labels["com.docker.compose.project.config_files"];
    if (files && files.split(",").map((f) => f.trim()).includes(opts.composePath)) return true;
    const p = c.labels["com.docker.compose.project"];
    return !!p && (p === project || p === normalizeProjectName(opts.appId));
  });
  const matched =
    byLabel.length > 0
      ? byLabel
      : all.filter((c) => {
          const name = c.name.toLowerCase();
          const id = opts.appId.toLowerCase();
          return name === id || name.startsWith(`${id}-`) || name.startsWith(`${id}_`);
        });
  return matched.map((c) => ({
    id: c.id,
    name: c.name,
    service: c.labels["com.docker.compose.service"] ?? null,
    status: c.status,
    image: c.image,
  }));
}

export async function stopContainerGracefully(id: string, timeoutSec = 30): Promise<void> {
  try {
    await docker.getContainer(id).stop({ t: timeoutSec });
  } catch (err) {
    if (!isNotModified(err)) throw err;
  }
}

export async function startContainerById(id: string): Promise<void> {
  try {
    await startContainer(id);
  } catch (err) {
    if (!isNotModified(err)) throw err;
  }
}

export async function getContainerState(id: string): Promise<ContainerState> {
  const info = await docker.getContainer(id).inspect();
  const state = info.State as typeof info.State & { Health?: { Status?: string } };
  return {
    id,
    name: (info.Name ?? id).replace(/^\//, ""),
    status: state.Status,
    running: state.Running === true && state.Restarting !== true,
    health: state.Health?.Status ?? null,
    restartCount: (info as typeof info & { RestartCount?: number }).RestartCount ?? 0,
    image: info.Config?.Image ?? "",
    imageId: info.Image ?? null,
  };
}

export async function getImageDigests(imageId: string): Promise<string[]> {
  try {
    const info = await docker.getImage(imageId).inspect();
    return info.RepoDigests ?? [];
  } catch {
    return [];
  }
}

// ── Exec helpers ────────────────────────────────────────────────────────────

interface DemuxSinks {
  stdout: (chunk: Buffer, pause: () => () => void) => void;
  stderr: (chunk: Buffer) => void;
}

/** Parse Docker's multiplexed exec stream (8-byte frame headers). */
function demux(stream: Duplex, sinks: DemuxSinks): void {
  let pending: Buffer = Buffer.alloc(0);
  const pause = () => {
    stream.pause();
    return () => stream.resume();
  };
  stream.on("data", (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const type = pending[0];
      const len = pending.readUInt32BE(4);
      if (pending.length < 8 + len) break;
      const payload = pending.subarray(8, 8 + len);
      pending = pending.subarray(8 + len);
      if (type === 2) sinks.stderr(payload);
      else sinks.stdout(payload, pause);
    }
  });
}

async function waitForExitCode(exec: { inspect: () => Promise<{ ExitCode: number | null; Running: boolean }> }): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const info = await exec.inspect();
    if (!info.Running) return info.ExitCode ?? -1;
    await new Promise((r) => setTimeout(r, 100));
  }
  return -1;
}

async function runExec(
  containerId: string,
  cmd: string[],
  timeoutMs: number,
  onStdout: (chunk: Buffer, pause: () => () => void) => void,
): Promise<{ exitCode: number; stderr: string }> {
  const container = docker.getContainer(containerId);
  const exec = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
  const stream = (await exec.start({ hijack: true, stdin: false })) as Duplex;
  let stderr = "";
  demux(stream, {
    stdout: onStdout,
    stderr: (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf-8");
    },
  });
  await new Promise<void>((resolveDone, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      resolveDone();
    };
    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  const exitCode = await waitForExitCode(exec as unknown as { inspect: () => Promise<{ ExitCode: number | null; Running: boolean }> });
  return { exitCode, stderr: stderr.trim() };
}

/** Run a command in a container and capture its (bounded) output. */
export async function execCapture(containerId: string, cmd: string[], timeoutMs = 60_000): Promise<ExecResult> {
  let stdout = "";
  const { exitCode, stderr } = await runExec(containerId, cmd, timeoutMs, (chunk) => {
    if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf-8");
  });
  return { exitCode, stdout: stdout.trim(), stderr };
}

/** Run a command in a container, streaming stdout into a file. */
export async function execToFile(
  containerId: string,
  cmd: string[],
  outPath: string,
  timeoutMs = 60 * 60_000,
): Promise<{ exitCode: number; stderr: string; bytes: number }> {
  const out = createWriteStream(outPath, { mode: 0o600 });
  let bytes = 0;
  let writeError: Error | null = null;
  out.on("error", (err) => {
    writeError = err;
  });
  try {
    const { exitCode, stderr } = await runExec(containerId, cmd, timeoutMs, (chunk, pause) => {
      bytes += chunk.length;
      if (!out.write(chunk)) {
        const resume = pause();
        out.once("drain", resume);
      }
    });
    return { exitCode, stderr, bytes };
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
    if (writeError) throw writeError;
  }
}

/** Copy a local .tar.gz into a container directory (Docker extracts it). */
export async function putArchive(containerId: string, tarGzPath: string, destDir: string): Promise<void> {
  await docker.getContainer(containerId).putArchive(createReadStream(tarGzPath), { path: destDir });
}

// ── Compose ─────────────────────────────────────────────────────────────────

/**
 * `docker compose up -d [services]` for an app. Arguments are passed as an
 * array (no shell); the environment mirrors Talome's lifecycle env.
 */
export async function composeUp(opts: {
  appId: string;
  composePath: string;
  envOverrides: Record<string, string>;
  services?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const { buildEnv } = await import("../stores/compose-exec.js");
  const env = buildEnv(opts.appId, opts.envOverrides);
  try {
    const { ensureTalomeNetwork } = await import("../docker/talome-network.js");
    await ensureTalomeNetwork();
  } catch {
    // best effort — compose will report a missing network
  }
  const args = ["compose", "-f", opts.composePath, "up", "-d", ...(opts.services ?? [])];
  await new Promise<void>((resolveDone, reject) => {
    execFile(
      "docker",
      args,
      { cwd: dirname(opts.composePath), env, timeout: opts.timeoutMs ?? 180_000, maxBuffer: 10 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(String(stderr || errorMessage(err)).trim()));
        else resolveDone();
      },
    );
  });
}

/** Start an app through Talome's lifecycle (network, hooks, dependencies). */
export async function startAppViaLifecycle(appId: string): Promise<{ success: boolean; error?: string }> {
  const { startApp } = await import("../stores/lifecycle.js");
  return startApp(appId);
}
