/**
 * Fixed-window in-memory rate limiter. Good for a single API node; for several nodes
 * swap for a Redis-backed implementation with the same interface.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {}

  /** Returns true when the call is allowed. */
  take(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 50_000) this.sweep(now);
      return true;
    }
    h.count += 1;
    return h.count <= this.limit;
  }

  reset(key: string) {
    this.hits.delete(key);
  }

  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
