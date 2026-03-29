/**
 * Evolution restart coordinator.
 *
 * Separated from index.ts to avoid circular imports (evolution.ts ↔ index.ts).
 * The main server registers its shutdown handler on startup; evolution routes
 * call scheduleEvolutionRestart() after compiling new backend code.
 */

// Exit code 75 (EX_TEMPFAIL) signals the process wrapper to restart the server.
const EVOLUTION_RESTART_CODE = 75;

let pendingRestart = false;
let shutdownFn: ((signal: string, exitCode: number) => Promise<void>) | null = null;

/**
 * Register the server's graceful shutdown function.
 * Called once during server startup in index.ts.
 */
export function registerShutdownHandler(fn: (signal: string, exitCode: number) => Promise<void>): void {
  shutdownFn = fn;
}

/**
 * Schedule a graceful restart after evolution changes are compiled.
 * The process exits with code 75, which the production wrapper (scripts/start-core.sh)
 * interprets as "restart requested" and relaunches the server with the new dist/.
 * Short delay allows in-flight HTTP responses to complete.
 */
export function scheduleEvolutionRestart(): void {
  if (pendingRestart) return; // Deduplicate concurrent restart requests
  pendingRestart = true;
  console.log("[evolution] Backend rebuilt — restarting to load new code…");
  setTimeout(() => {
    if (shutdownFn) {
      void shutdownFn("evolution-reload", EVOLUTION_RESTART_CODE);
    } else {
      // Fallback if shutdown handler wasn't registered (shouldn't happen)
      process.exit(EVOLUTION_RESTART_CODE);
    }
  }, 500);
}
