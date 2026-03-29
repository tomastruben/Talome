/**
 * In-process evolution event emitter.
 * SSE clients subscribe via addEvolutionListener; apply_change/claude-code-tool emit via emitEvolutionEvent.
 */

export type EvolutionEventType =
  | "started"
  | "progress"
  | "output"
  | "applied"
  | "reverted"
  | "failed"
  | "rebuild_started"
  | "rebuild_complete"
  | "rebuild_failed"
  | "backend_rebuild_started"
  | "backend_rebuild_complete"
  | "backend_rebuild_failed";

export interface EvolutionEvent {
  type: EvolutionEventType;
  runId?: string;
  task?: string;
  scope?: string;
  message?: string;
  chunk?: string;
  filesChanged?: string[];
  typeErrors?: string;
  duration?: number;
  error?: string;
}

type Listener = (event: EvolutionEvent) => void;

const listeners = new Set<Listener>();

// Keep the last "started" event and recent output lines so late-connecting
// SSE clients can replay the current in-progress run immediately on connect.
let activeRun: { started: EvolutionEvent; outputLines: string[] } | null = null;

export function addEvolutionListener(fn: Listener): () => void {
  // Replay current active run state to this new listener immediately
  if (activeRun) {
    try { fn(activeRun.started); } catch { /* ignore */ }
    if (activeRun.outputLines.length > 0) {
      const buffered = activeRun.outputLines.join("\n");
      try { fn({ type: "output", chunk: buffered }); } catch { /* ignore */ }
    }
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitEvolutionEvent(event: EvolutionEvent): void {
  if (event.type === "started") {
    activeRun = { started: event, outputLines: [] };
  } else if (event.type === "output" && event.chunk != null) {
    if (activeRun) {
      activeRun.outputLines.push(event.chunk);
      if (activeRun.outputLines.length > 300) {
        activeRun.outputLines = activeRun.outputLines.slice(-300);
      }
    }
  } else if (
    event.type === "applied" ||
    event.type === "reverted" ||
    event.type === "failed"
  ) {
    activeRun = null;
  }

  for (const fn of listeners) {
    try { fn(event); } catch { /* ignore dead listeners */ }
  }
}

// ── In-memory result store — populated by worker via internal-event ───────────
// Maps runId → result payload. Entries expire after 10 minutes.

interface RunResult {
  payload: Record<string, unknown>;
  expiresAt: number;
}
const runResults = new Map<string, RunResult>();

export function storeRunResult(runId: string, payload: Record<string, unknown>): void {
  runResults.set(runId, { payload, expiresAt: Date.now() + 10 * 60 * 1000 });
  for (const [k, v] of runResults) {
    if (v.expiresAt < Date.now()) runResults.delete(k);
  }
}

/**
 * Wait for a plan_result or apply_result event from the detached worker.
 * The tool calls this after spawning the worker; it resolves when the worker
 * posts its final result back via /api/evolution/internal-event.
 */
export function waitForRunResult(runId: string, timeoutMs = 600_000): Promise<Record<string, unknown>> {
  const existing = runResults.get(runId);
  if (existing) return Promise.resolve(existing.payload);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for run ${runId}`));
    }, timeoutMs);

    const unsubscribe = addEvolutionListener((event: EvolutionEvent) => {
      // plan_result / apply_result are not standard EvolutionEvent types but
      // the worker posts them via the internal-event bridge which calls
      // emitEvolutionEvent with the raw object — cast through unknown.
      const ev = event as unknown as Record<string, unknown>;
      if (
        (ev.type === "plan_result" || ev.type === "apply_result") &&
        ev.runId === runId
      ) {
        clearTimeout(timer);
        unsubscribe();
        resolve(ev);
      }
    });
  });
}
