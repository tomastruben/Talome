/**
 * Lightweight circuit breaker — prevents cascading failures when a dependency
 * (Docker API, Radarr, Sonarr, etc.) is down. Instead of every request paying
 * the full timeout, the breaker trips after N consecutive failures and
 * fast-fails until a recovery probe succeeds.
 *
 * States: closed (normal) → open (fast-fail) → half-open (one probe allowed)
 */

export class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;
  private lastFailure = 0;
  private readonly threshold: number;
  private readonly resetTimeout: number;
  private readonly name: string;

  constructor(opts: {
    /** Name for logging */
    name: string;
    /** Number of consecutive failures before tripping (default: 5) */
    threshold?: number;
    /** Time in ms before trying again after tripping (default: 30s) */
    resetTimeout?: number;
  }) {
    this.name = opts.name;
    this.threshold = opts.threshold ?? 5;
    this.resetTimeout = opts.resetTimeout ?? 30_000;
  }

  /**
   * Execute a function through the circuit breaker.
   * If the breaker is open, throws immediately without calling fn.
   * If half-open, allows one probe call — success closes the breaker,
   * failure re-opens it.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = "half-open";
      } else {
        throw new Error(`[circuit-breaker] ${this.name} is open — fast-failing`);
      }
    }

    try {
      const result = await fn();
      if (this.state === "half-open") {
        console.log(`[circuit-breaker] ${this.name} recovered — closing`);
        this.state = "closed";
        this.failures = 0;
      }
      return result;
    } catch (err) {
      this.failures++;
      this.lastFailure = Date.now();
      if (this.failures >= this.threshold) {
        console.warn(`[circuit-breaker] ${this.name} tripped after ${this.failures} failures — opening for ${this.resetTimeout}ms`);
        this.state = "open";
      }
      throw err;
    }
  }

  /**
   * Execute with a fallback value when the circuit is open.
   * Returns the fallback instead of throwing.
   */
  async execWithFallback<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await this.exec(fn);
    } catch (err) {
      if (this.isOpen) return fallback;
      throw err;
    }
  }

  get isOpen(): boolean {
    if (this.state === "open" && Date.now() - this.lastFailure > this.resetTimeout) {
      this.state = "half-open";
      return false;
    }
    return this.state === "open";
  }

  get currentState(): string {
    return this.state;
  }

  reset(): void {
    this.state = "closed";
    this.failures = 0;
  }
}
