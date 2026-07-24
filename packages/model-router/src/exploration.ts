import type { RankedModel, TaskKind, TaskProfile } from '@agent-foundry/contracts';

/** Epsilon-greedy exploration policy. */
export interface ExplorationPolicy {
  /** Default exploration probability in [0, 1] when no per-task-kind override applies. */
  baseRate: number;
  /** Optional per-task-kind override of the exploration probability. */
  perTaskKind?: Partial<Record<TaskKind, number>>;
}

/** Result of an exploration decision. */
export interface ExplorationChoice {
  /** Index into the ranked array that should be selected. */
  index: number;
  /** Human-readable explanation of the decision. */
  reason: string;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * A task profile is sensitive (must never auto-explore) when any of:
 * risk >= 4, mutatesWorkspace is true, or toolPolicy is 'workspace-write'.
 * This is a locked product decision, not policy-configurable.
 */
function isSensitive(profile: TaskProfile): boolean {
  return (
    profile.risk >= 4 ||
    profile.mutatesWorkspace === true ||
    profile.toolPolicy === 'workspace-write'
  );
}

/**
 * Resolves the exploration probability for a task, applying the sensitivity
 * rule first (unconditionally, regardless of policy config) and clamping the
 * result to [0, 1].
 */
export function effectiveEpsilon(policy: ExplorationPolicy, profile: TaskProfile): number {
  if (isSensitive(profile)) {
    return 0;
  }
  const epsilon = policy.perTaskKind?.[profile.taskKind] ?? policy.baseRate;
  return clamp01(epsilon);
}

/**
 * Decides whether to explore an alternative candidate instead of the top
 * ranked one. `random` is injected so callers get deterministic tests; the
 * global Math.random is never called directly.
 */
export function chooseExploration(
  ranked: RankedModel[],
  epsilon: number,
  random: () => number,
): ExplorationChoice {
  if (ranked.length <= 1) {
    return { index: 0, reason: 'only one candidate, nothing to explore' };
  }
  if (epsilon <= 0) {
    return { index: 0, reason: 'exploration disabled (epsilon=0)' };
  }

  const roll = random();
  if (roll >= epsilon) {
    return {
      index: 0,
      reason: `greedy: exploration roll ${roll.toFixed(3)} >= epsilon ${epsilon.toFixed(3)}`,
    };
  }

  const nonTopCount = ranked.length - 1;
  const index = Math.min(1 + Math.floor(random() * nonTopCount), ranked.length - 1);
  return {
    index,
    reason: `explored: index ${index} of ${ranked.length} candidates, roll ${roll.toFixed(3)} < epsilon ${epsilon.toFixed(3)}`,
  };
}
