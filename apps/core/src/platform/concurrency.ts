/**
 * Small async helpers for bounding concurrency and de-duplicating in-flight
 * work. Used by the Docker client (stats sampler, list cache), the agent-loop
 * detectors and the retention job so background work never fans out
 * unbounded against the Docker socket or the event loop.
 */

export interface LimiterTaskOptions {
  /** Jump ahead of queued (non-priority) tasks, e.g. for interactive requests. */
  priority?: boolean;
}

export type Limiter = <T>(fn: () => Promise<T>, opts?: LimiterTaskOptions) => Promise<T>;

/**
 * Create a limiter that runs at most `max` tasks at the same time. Extra tasks
 * queue in FIFO order; priority tasks queue ahead of normal ones (FIFO among
 * themselves). A task that throws releases its slot like any other.
 */
export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const priorityQueue: Array<() => void> = [];
  const queue: Array<() => void> = [];

  const release = () => {
    active--;
    const next = priorityQueue.shift() ?? queue.shift();
    if (next) next();
  };

  return <T>(fn: () => Promise<T>, opts?: LimiterTaskOptions): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++;
        let result: Promise<T>;
        try {
          result = fn();
        } catch (err) {
          release();
          reject(err);
          return;
        }
        result.then(
          (value) => { release(); resolve(value); },
          (err: unknown) => { release(); reject(err); },
        );
      };
      if (active < limit) run();
      else if (opts?.priority) priorityQueue.push(run);
      else queue.push(run);
    });
}

/**
 * Map over `items` with at most `limit` concurrent calls. Never rejects:
 * every item yields a settled result in input order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const limiter = createLimiter(limit);
  return Promise.allSettled(items.map((item, i) => limiter(() => fn(item, i))));
}

/**
 * Resolve with the promise's value, or with `fallback` once `ms` elapses.
 * Unlike a rejecting timeout this never throws, so callers can degrade
 * gracefully (e.g. return a container without stats).
 */
export async function settleWithin<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.catch(() => fallback), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface SkipIfRunningOptions {
  /** A run still pending after this long is treated as wedged and may start again. */
  abandonAfterMs: number;
  /** Called when a wedged run is abandoned. */
  onAbandon?: (name: string) => void;
}

/**
 * Per-name overlap guard for periodic jobs: `guard(name, fn)` skips `fn` while
 * a previous run under the same name is still pending, so one slow job only
 * skips itself instead of stalling every other job on the same tick. A run
 * pending for longer than `abandonAfterMs` no longer blocks new runs, so a
 * promise that never settles cannot disable a job for good. The returned
 * promise never rejects.
 */
export function createSkipIfRunning(
  opts: SkipIfRunningOptions,
): (name: string, fn: () => Promise<unknown>) => Promise<void> {
  const running = new Map<string, { token: symbol; startedAt: number }>();
  return (name, fn) => {
    const current = running.get(name);
    if (current && Date.now() - current.startedAt < opts.abandonAfterMs) return Promise.resolve();
    if (current) opts.onAbandon?.(name);
    const token = Symbol(name);
    running.set(name, { token, startedAt: Date.now() });
    let result: Promise<unknown>;
    try {
      result = fn();
    } catch (err) {
      result = Promise.reject(err);
    }
    return result
      .then(() => undefined, () => undefined)
      .finally(() => {
        if (running.get(name)?.token === token) running.delete(name);
      });
  };
}

/** Yield to the event loop so queued I/O callbacks and timers can run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
