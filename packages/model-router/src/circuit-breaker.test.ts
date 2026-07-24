import { describe, expect, it } from 'vitest';
import type { ExecutorHealth, ModelMetric } from '@agent-foundry/contracts';
import {
  DEFAULT_BREAKER_CONFIG,
  evaluateBreaker,
  type CircuitBreakerConfig,
} from './circuit-breaker.js';

const NOW = new Date('2026-07-23T12:00:00.000Z');

function metric(overrides: Partial<ModelMetric> = {}): ModelMetric {
  return {
    modelId: 'm',
    taskKind: 'implementation',
    role: 'developer',
    taxonomyVersion: '1',
    category: 'implementation/general',
    attempts: 0,
    successes: 0,
    totalDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    consecutiveFailures: 0,
    qualityEvaluations: 0,
    qualityApprovals: 0,
    updatedAt: '2026-07-18T12:00:00.000Z',
    ...overrides,
  };
}

function health(overrides: Partial<ExecutorHealth> = {}): ExecutorHealth {
  return {
    provider: 'claude',
    available: true,
    message: '',
    ...overrides,
  };
}

const config: CircuitBreakerConfig = DEFAULT_BREAKER_CONFIG;

describe('evaluateBreaker', () => {
  it('both metric and health absent -> closed', () => {
    expect(evaluateBreaker(null, undefined, config, NOW)).toEqual({ state: 'closed' });
  });

  it('unavailable executor -> open, reason mentions the message', () => {
    const result = evaluateBreaker(
      null,
      health({ available: false, message: 'connection refused' }),
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toContain('connection refused');
  });

  it('unavailable executor with empty message -> open, generic fallback reason', () => {
    const result = evaluateBreaker(null, health({ available: false, message: '' }), config, NOW);
    expect(result.state).toBe('open');
    expect(result.reason).toMatch(/provider unavailable/);
  });

  it('rate-limited: future resetAt, remaining 0 -> open', () => {
    const result = evaluateBreaker(
      null,
      health({ rateLimit: { remaining: 0, resetAt: '2026-07-23T12:05:00.000Z' } }),
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toContain('rate-limited until 2026-07-23T12:05:00.000Z');
  });

  it('rate-limited: future resetAt, remaining undefined -> open', () => {
    const result = evaluateBreaker(
      null,
      health({ rateLimit: { resetAt: '2026-07-23T12:05:00.000Z' } }),
      config,
      NOW,
    );
    expect(result.state).toBe('open');
  });

  it('rate-limited: resetAt in the past -> not open on that ground, closed otherwise', () => {
    const result = evaluateBreaker(
      null,
      health({ rateLimit: { remaining: 0, resetAt: '2026-07-23T11:00:00.000Z' } }),
      config,
      NOW,
    );
    expect(result).toEqual({ state: 'closed' });
  });

  it('rate-limited: future resetAt but remaining > 0 -> not open on that ground', () => {
    const result = evaluateBreaker(
      null,
      health({ rateLimit: { remaining: 10, resetAt: '2026-07-23T12:05:00.000Z' } }),
      config,
      NOW,
    );
    expect(result).toEqual({ state: 'closed' });
  });

  it('consecutive failures at threshold, no lastFailureAt -> open', () => {
    const result = evaluateBreaker(metric({ consecutiveFailures: 5 }), undefined, config, NOW);
    expect(result.state).toBe('open');
    expect(result.reason).toContain('5 consecutive failures');
    expect(result.reason).toContain('unknown');
  });

  it('consecutive failures at threshold, malformed lastFailureAt -> open like no lastFailureAt, does not throw', () => {
    const result = evaluateBreaker(
      metric({ consecutiveFailures: 5, lastFailureAt: 'not-a-date' }),
      undefined,
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toContain('5 consecutive failures');
    expect(result.reason).toContain('unknown');
  });

  it('consecutive failures at threshold, lastFailureAt older than cooldownMs -> half-open', () => {
    const result = evaluateBreaker(
      metric({ consecutiveFailures: 5, lastFailureAt: '2026-07-23T11:58:00.000Z' }),
      undefined,
      config,
      NOW,
    );
    expect(result.state).toBe('half-open');
    expect(result.reason).toContain('cooldown elapsed, probing');
  });

  it('consecutive failures at threshold, lastFailureAt within cooldownMs -> open', () => {
    const result = evaluateBreaker(
      metric({ consecutiveFailures: 5, lastFailureAt: '2026-07-23T11:59:30.000Z' }),
      undefined,
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toContain('cooldown until 2026-07-23T12:00:30.000Z');
  });

  it('consecutive failures below threshold -> closed (all else equal)', () => {
    const result = evaluateBreaker(
      metric({ consecutiveFailures: 4, lastFailureAt: '2026-07-23T11:59:30.000Z' }),
      undefined,
      config,
      NOW,
    );
    expect(result).toEqual({ state: 'closed' });
  });

  it('latency: attempts below latencyMinAttempts -> not tripped even if average is huge', () => {
    const result = evaluateBreaker(
      metric({ attempts: 2, totalDurationMs: 2 * 20 * 60_000 }),
      undefined,
      config,
      NOW,
    );
    expect(result).toEqual({ state: 'closed' });
  });

  it('latency: average over ceiling, enough attempts, no lastFailureAt -> open', () => {
    const result = evaluateBreaker(
      metric({ attempts: 3, totalDurationMs: 3 * 20 * 60_000 }),
      undefined,
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toMatch(/average latency/);
  });

  it('latency: reason rounds a fractional average to a whole number of ms', () => {
    // totalDurationMs / attempts = 900001.333...ms, not evenly divisible.
    const result = evaluateBreaker(
      metric({ attempts: 3, totalDurationMs: 2_700_004 }),
      undefined,
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toContain('average latency 900001ms');
    expect(result.reason).not.toContain('.');
  });

  it('latency: average over ceiling, cooldown elapsed since lastFailureAt -> half-open', () => {
    const result = evaluateBreaker(
      metric({
        attempts: 3,
        totalDurationMs: 3 * 20 * 60_000,
        lastFailureAt: '2026-07-23T11:58:00.000Z',
      }),
      undefined,
      config,
      NOW,
    );
    expect(result.state).toBe('half-open');
    expect(result.reason).toContain('cooldown elapsed, probing');
  });

  it('latency: average over ceiling, lastFailureAt within cooldown -> open', () => {
    const result = evaluateBreaker(
      metric({
        attempts: 3,
        totalDurationMs: 3 * 20 * 60_000,
        lastFailureAt: '2026-07-23T11:59:30.000Z',
      }),
      undefined,
      config,
      NOW,
    );
    expect(result.state).toBe('open');
  });

  it('priority ordering: unavailable health wins over rate limit, failures, and latency', () => {
    const result = evaluateBreaker(
      metric({
        consecutiveFailures: 10,
        attempts: 5,
        totalDurationMs: 5 * 20 * 60_000,
      }),
      health({
        available: false,
        message: 'down for maintenance',
        rateLimit: { remaining: 0, resetAt: '2026-07-23T12:05:00.000Z' },
      }),
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toContain('down for maintenance');
  });

  it('priority ordering: rate limit wins over consecutive failures and latency', () => {
    const result = evaluateBreaker(
      metric({
        consecutiveFailures: 10,
        attempts: 5,
        totalDurationMs: 5 * 20 * 60_000,
      }),
      health({ rateLimit: { remaining: 0, resetAt: '2026-07-23T12:05:00.000Z' } }),
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toContain('rate-limited until');
  });

  it('priority ordering: consecutive failures win over latency', () => {
    const result = evaluateBreaker(
      metric({
        consecutiveFailures: 5,
        lastFailureAt: '2026-07-23T11:59:30.000Z',
        attempts: 5,
        totalDurationMs: 5 * 20 * 60_000,
      }),
      undefined,
      config,
      NOW,
    );
    expect(result.state).toBe('open');
    expect(result.reason).toContain('consecutive failures');
  });
});
