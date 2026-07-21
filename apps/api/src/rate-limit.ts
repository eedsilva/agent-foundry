export interface RateLimiter {
  /** Returns true if `key` is still under budget for the current window. */
  allow(key: string): boolean;
}

/**
 * Fixed-window request counter, keyed by caller (e.g. IP). Used to bound the
 * blob-signing routes: they authorize access to storage, so unlimited
 * requests let an attacker brute-force tokens or churn signed URLs.
 *
 * ponytail: in-memory per-process, one counter per key that's never evicted.
 * Fine for a single API replica; swap for @fastify/rate-limit or an
 * LB-level limiter if this ever runs multi-replica or the key cardinality
 * becomes a memory concern.
 */
export function createFixedWindowRateLimiter(
  max: number,
  windowMs: number,
  now: () => number = Date.now,
): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    allow(key: string): boolean {
      const time = now();
      const entry = windows.get(key);
      if (!entry || time >= entry.resetAt) {
        windows.set(key, { count: 1, resetAt: time + windowMs });
        return true;
      }
      entry.count += 1;
      return entry.count <= max;
    },
  };
}
