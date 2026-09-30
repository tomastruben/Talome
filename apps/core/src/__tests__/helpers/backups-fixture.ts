/**
 * Test fixtures for the backup engine: temp DB + backup root, a fake
 * installed app with a compose file, and an in-memory Docker double for
 * backup/docker-ops.ts. No real Docker, no network.
 *
 * prepareBackupEnv() must run BEFORE anything imports db/index.js.
 */

import { vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function prepareBackupEnv(name: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `talome-${name}-`));
  process.env.DATABASE_PATH = join(root, "talome.db");
  process.env.TALOME_APP_BACKUP_DIR = join(root, "backups");
  process.env.TALOME_SECRET ??= "a".repeat(64);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export async function installFakeApp(
  root: string,
  appId: string,
  compose: string,
  files: Record<string, string | Buffer>,
): Promise<{ appDir: string; composePath: string }> {
  const { db } = await import("../../db/index.js");
  const { sql } = await import("drizzle-orm");
  const appDir = join(root, "apps", appId);
  mkdirSync(appDir, { recursive: true });
  const composePath = join(appDir, "docker-compose.yml");
  writeFileSync(composePath, compose);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(appDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const now = new Date().toISOString();
  db.run(sql`INSERT OR REPLACE INTO installed_apps (app_id, store_source_id, status, installed_at, updated_at, env_config, container_ids, version, override_compose_path)
    VALUES (${appId}, 'test-store', 'running', ${now}, ${now}, '{}', '[]', '1.0.0', ${composePath})`);
  return { appDir, composePath };
}

// ── Docker double ───────────────────────────────────────────────────────────

export interface FakeContainer {
  id: string;
  name: string;
  service: string;
  status: string;
  image: string;
  /** When set, the container never reaches a healthy running state after start */
  crashOnStart?: boolean;
  /** One-shot container: exits with this code right after being started */
  oneShotExitCode?: number;
}

export const dockerState = {
  containers: [] as FakeContainer[],
  events: [] as string[],
  failStartIds: new Set<string>(),
  failStopIds: new Set<string>(),
  /** Called before each stop (e.g. to cancel a backup mid-way) */
  onStop: null as ((id: string) => void) | null,
  loadStderr: "",
  /** stderr of the next dump loads, one per load (falls back to loadStderr) */
  loadStderrQueue: [] as string[],
  dumps: new Map<string, string>(),
  /** Services whose dump fails (execToFile exits non-zero) */
  failDumpServices: new Set<string>(),
  /** Contents of every tar.gz passed to putArchive */
  putArchives: [] as Buffer[],
  /** Output of `id -u` / `id -g` inside containers (empty = command fails) */
  execUid: "",
  execGid: "",
};

export function resetDocker(containers: Array<Omit<FakeContainer, "status"> & { status?: string }>): void {
  dockerState.containers = containers.map((c) => ({ status: "running", ...c }));
  dockerState.events = [];
  dockerState.failStartIds = new Set();
  dockerState.failStopIds = new Set();
  dockerState.onStop = null;
  dockerState.loadStderr = "";
  dockerState.loadStderrQueue = [];
  dockerState.dumps = new Map();
  dockerState.failDumpServices = new Set();
  dockerState.putArchives = [];
  dockerState.execUid = "";
  dockerState.execGid = "";
}

function find(id: string): FakeContainer | undefined {
  return dockerState.containers.find((c) => c.id === id);
}

export function dockerOpsMock() {
  return {
    listAppContainers: vi.fn(async () =>
      dockerState.containers.map((c) => ({ id: c.id, name: c.name, service: c.service, status: c.status, image: c.image })),
    ),
    stopContainerGracefully: vi.fn(async (id: string) => {
      dockerState.onStop?.(id);
      dockerState.events.push(`stop:${id}`);
      if (dockerState.failStopIds.has(id)) throw new Error("stop timeout");
      const c = find(id);
      if (c) c.status = "exited";
    }),
    startContainerById: vi.fn(async (id: string) => {
      dockerState.events.push(`start:${id}`);
      if (dockerState.failStartIds.has(id)) throw new Error("start failed");
      const c = find(id);
      if (c) c.status = c.oneShotExitCode !== undefined ? "exited" : "running";
    }),
    getContainerState: vi.fn(async (id: string) => {
      const c = find(id);
      const running = c?.status === "running" && !c.crashOnStart;
      return {
        id,
        name: c?.name ?? id,
        status: c?.crashOnStart ? "restarting" : (c?.status ?? "exited"),
        running,
        health: null,
        restartCount: c?.crashOnStart ? 5 : 0,
        image: c?.image ?? "",
        imageId: `sha256:${id}`,
        exitCode: c?.status === "exited" ? (c.oneShotExitCode ?? 137) : null,
      };
    }),
    getImageDigests: vi.fn(async (imageId: string) => [`example/app@${imageId}`]),
    execCapture: vi.fn(async (_id: string, cmd: string[]) => {
      const joined = cmd.join(" ");
      if (joined.includes("INFO persistence")) {
        const now = Math.floor(Date.now() / 1000) + 1;
        return { exitCode: 0, stdout: `rdb_bgsave_in_progress:0\r\nrdb_last_bgsave_status:ok\r\nrdb_last_save_time:${now}\r\n`, stderr: "" };
      }
      if (cmd[0] === "id" && (cmd[1] === "-u" || cmd[1] === "-g")) {
        const out = cmd[1] === "-u" ? dockerState.execUid : dockerState.execGid;
        return out ? { exitCode: 0, stdout: `${out}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "id: not found" };
      }
      dockerState.events.push(`exec:${joined.includes("BGSAVE") ? "bgsave" : joined.includes("psql") ? "psql" : joined.includes("pg_isready") ? "ready" : "other"}`);
      if (!joined.includes("psql")) return { exitCode: 0, stdout: "", stderr: "" };
      const loadStderr = dockerState.loadStderrQueue.length > 0 ? dockerState.loadStderrQueue.shift()! : dockerState.loadStderr;
      return { exitCode: 0, stdout: "", stderr: loadStderr };
    }),
    execToFile: vi.fn(async (id: string, _cmd: string[], outPath: string) => {
      const c = find(id);
      if (dockerState.failDumpServices.has(c?.service ?? "")) {
        dockerState.events.push(`dumpfail:${c?.service}`);
        return { exitCode: 1, stderr: "pg_dumpall: error: connection failed", bytes: 0 };
      }
      const content =
        dockerState.dumps.get(c?.service ?? "") ??
        "--\n-- PostgreSQL database cluster dump\n--\nCREATE TABLE t (id int);\n--\n-- PostgreSQL database cluster dump complete\n--\n";
      writeFileSync(outPath, content);
      dockerState.events.push(`dump:${c?.service}`);
      return { exitCode: 0, stderr: "", bytes: Buffer.byteLength(content) };
    }),
    putArchive: vi.fn(async (_id: string, tarGzPath: string) => {
      dockerState.events.push("putArchive");
      dockerState.putArchives.push(readFileSync(tarGzPath));
    }),
    composeUp: vi.fn(async (opts: { services?: string[] }) => {
      dockerState.events.push(`composeUp:${(opts.services ?? []).join(",")}`);
      for (const c of dockerState.containers) {
        if (!opts.services || opts.services.includes(c.service)) c.status = c.oneShotExitCode !== undefined ? "exited" : "running";
      }
    }),
    startAppViaLifecycle: vi.fn(async () => {
      dockerState.events.push("startApp");
      for (const c of dockerState.containers) c.status = c.oneShotExitCode !== undefined ? "exited" : "running";
      return { success: true };
    }),
  };
}
