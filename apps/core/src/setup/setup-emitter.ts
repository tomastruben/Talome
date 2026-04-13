/**
 * In-process setup event emitter.
 * SSE clients subscribe via addSetupListener; the setup loop emits via emitSetupEvent.
 * Follows the same pattern as evolution-emitter.ts.
 */

export type SetupEventType =
  | "started"
  | "iteration"
  | "attempt"
  | "health_update"
  | "paused"
  | "completed"
  | "failed";

export interface SetupEvent {
  type: SetupEventType;
  runId?: string;
  appId?: string;
  action?: string;
  approach?: string;
  message?: string;
  healthScore?: number;
  appScores?: Array<{ appId: string; name: string; score: number }>;
  iteration?: number;
  error?: string;
}

type Listener = (event: SetupEvent) => void;

const listeners = new Set<Listener>();

let activeRun: { started: SetupEvent; recentEvents: SetupEvent[] } | null = null;

export function addSetupListener(fn: Listener): () => void {
  // Replay current active run state to new listener
  if (activeRun) {
    try { fn(activeRun.started); } catch { /* ignore */ }
    for (const ev of activeRun.recentEvents) {
      try { fn(ev); } catch { /* ignore */ }
    }
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emitSetupEvent(event: SetupEvent): void {
  if (event.type === "started") {
    activeRun = { started: event, recentEvents: [] };
  } else if (activeRun) {
    activeRun.recentEvents.push(event);
    if (activeRun.recentEvents.length > 100) {
      activeRun.recentEvents = activeRun.recentEvents.slice(-100);
    }
  }

  if (event.type === "completed" || event.type === "failed" || event.type === "paused") {
    activeRun = null;
  }

  for (const fn of listeners) {
    try { fn(event); } catch { /* ignore dead listeners */ }
  }
}

export function isSetupActive(): boolean {
  return activeRun !== null;
}
