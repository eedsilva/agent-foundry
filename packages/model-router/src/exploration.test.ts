import { describe, expect, it } from 'vitest';
import type { RankedModel, TaskProfile } from '@agent-foundry/contracts';
import { chooseExploration, effectiveEpsilon, type ExplorationPolicy } from './exploration.js';

function profile(overrides: Partial<TaskProfile> = {}): TaskProfile {
  return {
    role: 'developer',
    taskKind: 'implementation',
    taxonomyVersion: '2',
    category: 'implementation/frontend',
    features: [],
    complexity: 2,
    risk: 1,
    estimatedContextTokens: 1000,
    estimatedOutputTokens: 500,
    mutatesWorkspace: false,
    toolPolicy: 'read-only',
    priorities: { quality: 0.5, speed: 0.2, cost: 0.2, reliability: 0.1 },
    preferredTags: [],
    ...overrides,
  };
}

// chooseExploration only reads ranked.length, never inspects element contents.
function ranked(length: number): RankedModel[] {
  return Array.from({ length }, () => ({}) as RankedModel);
}

function neverCallRandom(): number {
  throw new Error('random() must not be called');
}

describe('effectiveEpsilon', () => {
  it('is 0 when risk >= 4 (exactly 4), even with a high baseRate and matching override', () => {
    const policy: ExplorationPolicy = {
      baseRate: 0.9,
      perTaskKind: { implementation: 0.9 },
    };
    expect(effectiveEpsilon(policy, profile({ risk: 4 }))).toBe(0);
  });

  it('is 0 when risk >= 4 (risk 5), even with a high baseRate and matching override', () => {
    const policy: ExplorationPolicy = {
      baseRate: 0.9,
      perTaskKind: { implementation: 0.9 },
    };
    expect(effectiveEpsilon(policy, profile({ risk: 5 }))).toBe(0);
  });

  it('is 0 when mutatesWorkspace is true', () => {
    const policy: ExplorationPolicy = { baseRate: 0.9 };
    expect(effectiveEpsilon(policy, profile({ mutatesWorkspace: true, risk: 1 }))).toBe(0);
  });

  it('is 0 when toolPolicy is workspace-write', () => {
    const policy: ExplorationPolicy = { baseRate: 0.9 };
    expect(effectiveEpsilon(policy, profile({ toolPolicy: 'workspace-write', risk: 1 }))).toBe(0);
  });

  it('returns baseRate when non-sensitive and no perTaskKind override', () => {
    const policy: ExplorationPolicy = { baseRate: 0.2 };
    expect(effectiveEpsilon(policy, profile())).toBe(0.2);
  });

  it('returns the perTaskKind override for the matching task kind', () => {
    const policy: ExplorationPolicy = {
      baseRate: 0.2,
      perTaskKind: { implementation: 0.5 },
    };
    expect(effectiveEpsilon(policy, profile({ taskKind: 'implementation' }))).toBe(0.5);
  });

  it('falls back to baseRate when perTaskKind has only other task kinds', () => {
    const policy: ExplorationPolicy = {
      baseRate: 0.2,
      perTaskKind: { 'code-review': 0.8, planning: 0.7 },
    };
    expect(effectiveEpsilon(policy, profile({ taskKind: 'implementation' }))).toBe(0.2);
  });

  it('clamps baseRate above 1 down to 1', () => {
    const policy: ExplorationPolicy = { baseRate: 1.5 };
    expect(effectiveEpsilon(policy, profile())).toBe(1);
  });

  it('clamps baseRate below 0 up to 0', () => {
    const policy: ExplorationPolicy = { baseRate: -0.2 };
    expect(effectiveEpsilon(policy, profile())).toBe(0);
  });
});

describe('chooseExploration', () => {
  it('returns index 0 when ranked.length === 1, regardless of epsilon/random', () => {
    const result = chooseExploration(ranked(1), 0.9, () => 0);
    expect(result).toEqual({
      index: 0,
      reason: 'only one candidate, nothing to explore',
    });
  });

  it('returns index 0 when ranked.length === 0, and does not throw', () => {
    const result = chooseExploration(ranked(0), 0.9, () => 0);
    expect(result).toEqual({
      index: 0,
      reason: 'only one candidate, nothing to explore',
    });
  });

  it('returns index 0 and never calls random when epsilon === 0', () => {
    const result = chooseExploration(ranked(3), 0, neverCallRandom);
    expect(result).toEqual({
      index: 0,
      reason: 'exploration disabled (epsilon=0)',
    });
  });

  it('is greedy (index 0) when the random roll is >= epsilon', () => {
    const result = chooseExploration(ranked(3), 0.2, () => 0.2);
    expect(result.index).toBe(0);
    expect(result.reason).toBe('greedy: exploration roll 0.200 >= epsilon 0.200');
  });

  it('explores and lands on the exact expected index: last candidate', () => {
    // ranked.length = 3 -> non-top indices [1, 2]. Second roll picks index 2.
    let call = 0;
    const rolls: readonly [number, number] = [0.05, 0.999];
    const random = () => rolls[call++]!;
    const result = chooseExploration(ranked(3), 0.2, random);
    expect(result.index).toBe(2);
    expect(result.reason).toBe('explored: index 2 of 3 candidates, roll 0.050 < epsilon 0.200');
  });

  it('explores and lands on the exact expected index: first non-top candidate', () => {
    // Second roll near 0 -> 1 + floor(0 * 2) = 1.
    let call = 0;
    const rolls: readonly [number, number] = [0.05, 0.0001];
    const random = () => rolls[call++]!;
    const result = chooseExploration(ranked(3), 0.2, random);
    expect(result.index).toBe(1);
    expect(result.reason).toBe('explored: index 1 of 3 candidates, roll 0.050 < epsilon 0.200');
  });

  it('is deterministic: random always 0 with epsilon > 0 always explores and picks index 1', () => {
    const result = chooseExploration(ranked(4), 0.5, () => 0);
    expect(result.index).toBe(1);
  });
});
