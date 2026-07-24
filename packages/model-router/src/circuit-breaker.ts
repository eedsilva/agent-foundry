import type { ExecutorHealth, ModelMetric } from '@agent-foundry/contracts';

export interface CircuitBreakerConfig {
  /** consecutiveFailures at or above this trips the breaker open. */
  failureThreshold: number;
  /** Minimum time since lastFailureAt before a failure/latency-tripped
   *  breaker moves from open to half-open (allows one probe). */
  cooldownMs: number;
  /** Average duration (totalDurationMs / attempts) at or above this trips
   *  the breaker open on latency grounds. */
  latencyCeilingMs: number;
  /** Minimum attempts before latency is trusted enough to trip the breaker
   *  (avoids one slow cold-start run tripping it). */
  latencyMinAttempts: number;
}

export const DEFAULT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  cooldownMs: 60_000,
  latencyCeilingMs: 15 * 60_000,
  latencyMinAttempts: 3,
};

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerResult {
  state: BreakerState;
  /** Human-readable explanation, present whenever state !== 'closed'. */
  reason?: string;
}

/**
 * Resolves whether a `lastFailureAt`-anchored trip (consecutive failures or
 * latency) has cooled down enough to move from open to half-open.
 * Absent `lastFailureAt` means elapsed time can't be measured, so it never
 * cools down to half-open.
 */
function cooldownState(
  lastFailureAt: string | undefined,
  cooldownMs: number,
  now: Date,
): { elapsed: boolean; cooldownUntil: string | null } {
  if (!lastFailureAt) return { elapsed: false, cooldownUntil: null };
  const lastFailureMs = new Date(lastFailureAt).getTime();
  // Defensive: ModelMetricSchema validates lastFailureAt as a datetime string
  // before it reaches here, but guard against an unparseable value anyway by
  // falling back to the same "never cools down" behavior as no lastFailureAt.
  if (Number.isNaN(lastFailureMs)) return { elapsed: false, cooldownUntil: null };
  const cooldownUntil = new Date(lastFailureMs + cooldownMs).toISOString();
  const elapsed = now.getTime() - lastFailureMs >= cooldownMs;
  return { elapsed, cooldownUntil };
}

export function evaluateBreaker(
  metric: ModelMetric | null,
  health: ExecutorHealth | undefined,
  config: CircuitBreakerConfig,
  now: Date,
): BreakerResult {
  if (health?.available === false) {
    return {
      state: 'open',
      reason: `provider unavailable: ${health.message || 'no reason given'}`,
    };
  }

  const rl = health?.rateLimit;
  const rateLimitApplies = !!rl?.resetAt && new Date(rl.resetAt).getTime() > now.getTime();
  if (rateLimitApplies && (rl.remaining === 0 || rl.remaining === undefined)) {
    return { state: 'open', reason: `rate-limited until ${rl.resetAt}` };
  }

  if (metric != null && metric.consecutiveFailures >= config.failureThreshold) {
    const { elapsed, cooldownUntil } = cooldownState(metric.lastFailureAt, config.cooldownMs, now);
    if (elapsed) {
      return {
        state: 'half-open',
        reason: `${metric.consecutiveFailures} consecutive failures; cooldown elapsed, probing`,
      };
    }
    return {
      state: 'open',
      reason: `${metric.consecutiveFailures} consecutive failures; cooldown until ${cooldownUntil ?? 'unknown'}`,
    };
  }

  if (
    metric != null &&
    metric.attempts >= config.latencyMinAttempts &&
    metric.totalDurationMs > 0 &&
    metric.totalDurationMs / metric.attempts > config.latencyCeilingMs
  ) {
    const avgMs = metric.totalDurationMs / metric.attempts;
    const baseReason = `average latency ${Math.round(avgMs)}ms exceeds ceiling ${config.latencyCeilingMs}ms`;
    const { elapsed } = cooldownState(metric.lastFailureAt, config.cooldownMs, now);
    if (elapsed) {
      return { state: 'half-open', reason: `${baseReason}; cooldown elapsed, probing` };
    }
    return { state: 'open', reason: baseReason };
  }

  return { state: 'closed' };
}
