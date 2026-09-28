/**
 * Small async helpers for bounding concurrency and de-duplicating in-flight
 * work. Used by the Docker client (stats sampler, list cache), the agent-loop
 * detectors and the retention job so background work never fans out
 * unbounded against the Docker socket or the event loop.
 */

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Create a limiter that runs at most `max` tasks at the same time. Extra tasks
 * queue in FIFO order. A task that throws releases its slot like any other.
 */
export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };

  return <T>(fn: () => Promise<T>): Promise<T> =>
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

/** Yield to the event loop so queued I/O callbacks and timers can run. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
