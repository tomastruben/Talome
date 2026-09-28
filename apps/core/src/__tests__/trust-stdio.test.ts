import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installStdioShutdown } from "../mcp-stdio-lifecycle.js";

function setup(overrides: { getPpid?: () => number; onShutdown?: () => Promise<void> } = {}) {
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

  it("does not exit while the parent is alive", async () => {
    const { exit } = setup({ getPpid: () => 4242 });
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("MCP stdio shutdown (real process)", () => {
  it("a child with open handles exits 0 once its stdin ends", async () => {
    const script = fileURLToPath(new URL("./helpers/stdio-child.ts", import.meta.url));
    const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", script], { stdio: ["pipe", "pipe", "inherit"] });
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
