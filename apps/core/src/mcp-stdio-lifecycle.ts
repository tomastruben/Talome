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
  log?: (message: string) => void;
}

export interface StdioLifecycle {
  shutdown: (reason: string) => Promise<void>;
  readonly shuttingDown: boolean;
}

export function installStdioShutdown(options: StdioLifecycleOptions): StdioLifecycle {
  const log = options.log ?? ((m: string) => process.stderr.write(`[mcp-stdio] ${m}\n`));
  let shuttingDown = false;
  let watchdog: ReturnType<typeof setInterval> | undefined;

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watchdog) clearInterval(watchdog);
    log(`shutting down: ${reason}`);
    const timeoutMs = options.shutdownTimeoutMs ?? 2_000;
    try {
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
