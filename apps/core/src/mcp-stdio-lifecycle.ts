/**
 * Lifecycle for the MCP stdio server: make sure the process exits when its
 * client goes away.
 *
 * The SDK's StdioServerTransport only listens for `data`/`error` on stdin, so
 * when Claude Code (or any client) exits, the server process keeps running on
 * timers and open handles — dozens of orphaned mcp-stdio processes, reparented
 * to launchd/init, were observed on a real host. Exit on any of:
 *   - stdin `end` / `close` / `error`   (client closed the pipe)
 *   - stdout `error` (EPIPE)            (client stopped reading)
 *   - the MCP transport closing
 *   - SIGTERM / SIGINT / SIGHUP
 *   - the parent process disappearing   (reparented, ppid changed)
 *
 * …but never in the middle of work that must not be cut short. A backup,
 * restore or update this process started keeps running after the client is
 * gone (the MCP server is closed, so nothing new starts), and the process
 * exits once that work is done — bounded by `drainTimeoutMs`. Exiting mid-way
 * would leave the app stopped or its data half-restored. (SIGKILL cannot be
 * caught: the server's backup recovery undoes such work once this process is
 * gone.)
 */

import type { EventEmitter } from "node:events";

export interface StdioLifecycleOptions {
  stdin: EventEmitter;
  stdout: EventEmitter;
  /** Cleanup hook (close server, clear timers). Bounded by `shutdownTimeoutMs`. */
  onShutdown?: (reason: string) => void | Promise<void>;
  exit: (code: number) => void;
  /** Usually `process` — receives SIGTERM/SIGINT/SIGHUP listeners. */
  signals?: EventEmitter;
  /** Usually `() => process.ppid`; enables the orphan watchdog. */
  getPpid?: () => number;
  watchdogIntervalMs?: number;
  shutdownTimeoutMs?: number;
  /**
   * Work this process is running that must finish before it exits (app
   * operations: backups, restores, updates…). One description per item,
   * empty when idle.
   */
  pendingWork?: () => string[];
  /** Upper bound for waiting on `pendingWork` once shutdown started (default 2 h). */
  drainTimeoutMs?: number;
  drainPollMs?: number;
  log?: (message: string) => void;
}

/** A restore can load a database dump for up to an hour, plus health checks and a possible rollback. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface StdioLifecycle {
  shutdown: (reason: string) => Promise<void>;
  readonly shuttingDown: boolean;
}

export function installStdioShutdown(options: StdioLifecycleOptions): StdioLifecycle {
  const log = options.log ?? ((m: string) => process.stderr.write(`[mcp-stdio] ${m}\n`));
  let shuttingDown = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;

  const pending = (): string[] => {
    try {
      return options.pendingWork?.() ?? [];
    } catch {
      return [];
    }
  };

  /** Wait (bounded) until the work this process started has finished. */
  const drain = async (): Promise<void> => {
    let work = pending();
    if (work.length === 0) return;
    const limitMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const pollMs = options.drainPollMs ?? 1_000;
    log(`client gone — finishing ${work.join(", ")} before exiting (up to ${Math.round(limitMs / 60_000)} min)`);
    const deadline = Date.now() + limitMs;
    while (work.length > 0 && Date.now() < deadline) {
      // Not unref'd: this timer keeps the process alive while the work runs
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, Math.min(pollMs, deadline - Date.now()))));
      work = pending();
    }
    if (work.length > 0) log(`exiting with work still running after ${Math.round(limitMs / 60_000)} min: ${work.join(", ")}`);
    else log("in-flight work finished");
  };

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watchdog) clearInterval(watchdog);
    log(`shutting down: ${reason}`);
    const timeoutMs = options.shutdownTimeoutMs ?? 2_000;
    try {
      // Stop taking requests first (closing the server does not cancel running tool calls)
      await Promise.race([
        Promise.resolve(options.onShutdown?.(reason)),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, timeoutMs);
          t.unref?.();
        }),
      ]);
    } catch {
      // Exiting anyway
    }
    await drain();
    options.exit(0);
  };

  options.stdin.on("end", () => void shutdown("stdin ended"));
  options.stdin.on("close", () => void shutdown("stdin closed"));
  options.stdin.on("error", () => void shutdown("stdin error"));
  options.stdout.on("error", (err: NodeJS.ErrnoException) =>
    void shutdown(err?.code === "EPIPE" ? "stdout EPIPE (client gone)" : "stdout error"),
  );

  if (options.signals) {
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      options.signals.on(signal, () => void shutdown(signal));
    }
  }

  if (options.getPpid) {
    const initialPpid = options.getPpid();
    watchdog = setInterval(() => {
      const ppid = options.getPpid?.();
      if (ppid !== initialPpid) void shutdown(`parent process ${initialPpid} gone`);
    }, options.watchdogIntervalMs ?? 5_000);
    watchdog.unref?.();
  }

  return {
    shutdown,
    get shuttingDown() {
      return shuttingDown;
    },
  };
}
