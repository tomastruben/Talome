import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installStdioShutdown } from "../mcp-stdio-lifecycle.js";

function setup(
  overrides: { getPpid?: () => number; onShutdown?: () => Promise<void>; pendingWork?: () => string[]; drainTimeoutMs?: number } = {},
) {
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const signals = new EventEmitter();
  const exit = vi.fn();
  const onShutdown = vi.fn(overrides.onShutdown ?? (async () => {}));
  const lifecycle = installStdioShutdown({
    stdin,
    stdout,
    signals,
    exit,
    onShutdown,
    getPpid: overrides.getPpid,
    watchdogIntervalMs: 10,
    shutdownTimeoutMs: 50,
    pendingWork: overrides.pendingWork,
    drainTimeoutMs: overrides.drainTimeoutMs,
    drainPollMs: 10,
    log: () => {},
  });
  return { stdin, stdout, signals, exit, onShutdown, lifecycle };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MCP stdio shutdown", () => {
  it("exits cleanly when stdin ends (client disconnected)", async () => {
    const { stdin, exit, onShutdown } = setup();
    stdin.emit("end");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("exits when stdin closes", async () => {
    const { stdin, exit } = setup();
    stdin.emit("close");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("exits on EPIPE from stdout", async () => {
    const { stdout, exit } = setup();
    stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it("exits on SIGTERM / SIGHUP", async () => {
    const a = setup();
    a.signals.emit("SIGTERM");
    await vi.waitFor(() => expect(a.exit).toHaveBeenCalledWith(0));
    const b = setup();
    b.signals.emit("SIGHUP");
    await vi.waitFor(() => expect(b.exit).toHaveBeenCalledWith(0));
  });

  it("exits when the transport closes (explicit shutdown)", async () => {
    const { lifecycle, exit } = setup();
    await lifecycle.shutdown("transport closed");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("shuts down only once even if several triggers fire", async () => {
    const { stdin, stdout, exit, onShutdown } = setup();
    stdin.emit("end");
    stdin.emit("close");
    stdout.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());
    expect(exit).toHaveBeenCalledTimes(1);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("still exits if cleanup hangs", async () => {
    const { stdin, exit } = setup({ onShutdown: () => new Promise<void>(() => {}) });
    stdin.emit("end");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 1000 });
  });

  it("exits when reparented (parent process died)", async () => {
    let ppid = 4242;
    const { exit } = setup({ getPpid: () => ppid });
    await new Promise((r) => setTimeout(r, 30));
    expect(exit).not.toHaveBeenCalled();
    ppid = 1;
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 1000 });
  });

  it("finishes a running backup/restore/update before exiting when the client goes away", async () => {
    let work = ["restore of immich"];
    const { stdin, exit, onShutdown } = setup({ pendingWork: () => work });
    stdin.emit("end");
    await vi.waitFor(() => expect(onShutdown).toHaveBeenCalled());
    // well past the cleanup timeout: still running because the restore is
    await new Promise((r) => setTimeout(r, 200));
    expect(exit).not.toHaveBeenCalled();
    work = [];
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 1000 });
  });

  it("waits for in-flight work on signals and a vanished parent too", async () => {
    let work = ["backup of nextcloud"];
    let ppid = 4242;
    const a = setup({ pendingWork: () => work, getPpid: () => ppid });
    ppid = 1;
    a.signals.emit("SIGTERM");
    await new Promise((r) => setTimeout(r, 150));
    expect(a.exit).not.toHaveBeenCalled();
    work = [];
    await vi.waitFor(() => expect(a.exit).toHaveBeenCalledWith(0), { timeout: 1000 });
    expect(a.exit).toHaveBeenCalledTimes(1);
  });

  it("gives up waiting after the drain bound", async () => {
    const { stdin, exit } = setup({ pendingWork: () => ["update of plex"], drainTimeoutMs: 100 });
    stdin.emit("end");
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 1000 });
  });

  it("does not exit while the parent is alive", async () => {
    const { exit } = setup({ getPpid: () => 4242 });
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled();
  });
});

function spawnChild(env: Record<string, string> = {}): ChildProcess {
  const script = fileURLToPath(new URL("./helpers/stdio-child.ts", import.meta.url));
  return spawn(process.execPath, ["--import", "tsx", script], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
}

describe("MCP stdio shutdown (real process)", () => {
  it("a child still running a restore outlives its client until the restore is done", async () => {
    const child = spawnChild({ STDIO_CHILD_BUSY_MS: "4000" });
    const events = child as unknown as EventEmitter;
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("child never became ready")), 15_000);
        child.stdout?.on("data", (d: Buffer) => {
          if (d.toString().includes("ready")) {
            clearTimeout(t);
            resolve();
          }
        });
        events.on("error", reject);
      });
      const endedAt = Date.now();
      const exited = new Promise<number | null>((resolve) => events.on("exit", (code: number | null) => resolve(code)));
      child.stdin?.end();
      const early = await Promise.race([exited, new Promise<"running">((r) => setTimeout(() => r("running"), 1_000))]);
      expect(early).toBe("running");
      const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 10_000))]);
      expect(code).toBe(0);
      expect(Date.now() - endedAt).toBeGreaterThanOrEqual(1_000);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("a child with open handles exits 0 once its stdin ends", async () => {
    const child = spawnChild();
    // @types/node regression: ChildProcess lost .on() (see activity-summary.ts)
    const events = child as unknown as EventEmitter;
    try {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("child never became ready")), 15_000);
        child.stdout?.on("data", (d: Buffer) => {
          if (d.toString().includes("ready")) {
            clearTimeout(t);
            resolve();
          }
        });
        events.on("error", reject);
      });
      const exited = new Promise<number | null>((resolve) => events.on("exit", (code: number | null) => resolve(code)));
      child.stdin?.end();
      const code = await Promise.race([exited, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5_000))]);
      expect(code).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 30_000);
});
