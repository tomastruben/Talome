/**
 * Run `callback` once the browser is idle, no earlier than `minDelayMs` after
 * scheduling. Used to preload code-split chunks without competing with the
 * initial render. Returns a cancel function.
 */
export function scheduleIdle(callback: () => void, minDelayMs = 0, idleTimeoutMs = 3_000): () => void {
  if (typeof window === "undefined") return () => {};

  let cancelled = false;
  let idleHandle: number | null = null;
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const run = () => {
    if (!cancelled) callback();
  };

  const delayTimer = setTimeout(() => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(run, { timeout: idleTimeoutMs });
    } else {
      fallbackTimer = setTimeout(run, 0);
    }
  }, minDelayMs);

  return () => {
    cancelled = true;
    clearTimeout(delayTimer);
    if (fallbackTimer !== null) clearTimeout(fallbackTimer);
    if (idleHandle !== null && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(idleHandle);
    }
  };
}
