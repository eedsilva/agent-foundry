import {
  CURRENT_TASK_TAXONOMY_VERSION,
  type AgentStep,
  type ProjectPolicy,
  type StoredArtifact,
  type TaskCategory,
  type TaskFeature,
  type TaskProfile,
} from '@agent-foundry/contracts';
import type { HarnessSelection } from '@agent-foundry/domain';
import { estimateTokens, stableJson } from '@agent-foundry/domain';

const DEFAULTS: Record<
  AgentStep['taskKind'],
  Pick<TaskProfile, 'complexity' | 'risk' | 'priorities' | 'preferredTags'>
> = {
  planning: {
    complexity: 4,
    risk: 3,
    priorities: { quality: 0.55, speed: 0.1, cost: 0.1, reliability: 0.25 },
    preferredTags: ['planning', 'reasoning', 'structured-output'],
  },
  'plan-review': {
    complexity: 4,
    risk: 4,
    priorities: { quality: 0.58, speed: 0.07, cost: 0.05, reliability: 0.3 },
    preferredTags: ['review', 'reasoning', 'structured-output'],
  },
  architecture: {
    complexity: 5,
    risk: 5,
    priorities: { quality: 0.65, speed: 0.05, cost: 0.05, reliability: 0.25 },
    preferredTags: ['architecture', 'reasoning', 'long-context'],
  },
  'architecture-review': {
    complexity: 5,
    risk: 5,
    priorities: { quality: 0.65, speed: 0.04, cost: 0.03, reliability: 0.28 },
    preferredTags: ['review', 'architecture', 'reasoning'],
  },
  implementation: {
    complexity: 5,
    risk: 4,
    priorities: { quality: 0.58, speed: 0.12, cost: 0.06, reliability: 0.24 },
    preferredTags: ['coding', 'tool-use', 'workspace-write'],
  },
  'code-review': {
    complexity: 4,
    risk: 5,
    priorities: { quality: 0.62, speed: 0.06, cost: 0.04, reliability: 0.28 },
    preferredTags: ['review', 'coding', 'reasoning'],
  },
  repair: {
    complexity: 4,
    risk: 4,
    priorities: { quality: 0.55, speed: 0.14, cost: 0.06, reliability: 0.25 },
    preferredTags: ['repair', 'coding', 'tool-use'],
  },
  verification: {
    complexity: 3,
    risk: 4,
    priorities: { quality: 0.45, speed: 0.15, cost: 0.08, reliability: 0.32 },
    preferredTags: ['testing', 'review', 'tool-use'],
  },
};

const FEATURE_RULES: ReadonlyArray<readonly [TaskFeature, RegExp]> = [
  ['database', /\b(database|postgres(?:ql)?|sql|supabase|migration|schema)\b/i],
  ['frontend', /\b(frontend|ui|ux|react|next(?:\.js)?|css|component|browser)\b/i],
  ['backend', /\b(backend|server|endpoint|fastify|service)\b/i],
  ['integration', /\b(integration|webhook|provider|external api)\b/i],
  ['tests', /\b(test|tests|testing|spec|vitest|playwright|e2e)\b/i],
];

export function buildTaskProfile(input: {
  step: AgentStep;
  harness: HarnessSelection;
  artifacts: StoredArtifact[];
  policy?: ProjectPolicy | undefined;
}): TaskProfile {
  const defaults = DEFAULTS[input.step.taskKind];
  const contextText = [
    input.step.instructions,
    input.harness.combined,
    ...input.artifacts.map((artifact) => stableJson(artifact.content)),
  ].join('\n');
  const classificationText = [contextText, ...input.step.harnessTags].join('\n');
  const features = FEATURE_RULES.filter(([, pattern]) => pattern.test(classificationText)).map(
    ([feature]) => feature,
  );
  const customPriorities = input.step.profile.priorities ?? {};

  return {
    role: input.step.role,
    taskKind: input.step.taskKind,
    taxonomyVersion: CURRENT_TASK_TAXONOMY_VERSION,
    category: input.step.profile.category ?? classifyTaskCategory(input.step.taskKind, features),
    features,
    complexity: input.step.profile.complexity ?? defaults.complexity,
    risk: input.step.profile.risk ?? defaults.risk,
    estimatedContextTokens: estimateTokens(contextText) + 2_000,
    estimatedOutputTokens: estimatedOutputTokens(input.step.taskKind),
    mutatesWorkspace: input.step.mutatesWorkspace,
    priorities: {
      quality: customPriorities.quality ?? defaults.priorities.quality,
      speed: customPriorities.speed ?? defaults.priorities.speed,
      cost: customPriorities.cost ?? defaults.priorities.cost,
      reliability: customPriorities.reliability ?? defaults.priorities.reliability,
    },
    ...(input.step.profile.allowedProviders
      ? { allowedProviders: input.step.profile.allowedProviders }
      : {}),
    ...(input.policy?.allowedProviders
      ? {
          policy: {
            id: input.policy.id,
            version: input.policy.version,
            allowedProviders: input.policy.allowedProviders,
          },
        }
      : {}),
    preferredTags: [
      ...new Set([
        ...defaults.preferredTags,
        ...(input.step.profile.preferredTags ?? []),
        ...input.step.harnessTags,
      ]),
    ],
  };
}

function classifyTaskCategory(
  taskKind: AgentStep['taskKind'],
  features: TaskFeature[],
): TaskCategory {
  switch (taskKind) {
    case 'planning':
      return 'planning';
    case 'plan-review':
      return 'review/plan';
    case 'architecture':
      return 'architecture';
    case 'architecture-review':
      return 'review/architecture';
    case 'code-review':
      return 'review/code';
    case 'verification':
      return 'verification/tests';
    case 'implementation':
    case 'repair':
      return `${taskKind}/${features[0] ?? 'general'}` as TaskCategory;
  }
}

function estimatedOutputTokens(taskKind: AgentStep['taskKind']): number {
  switch (taskKind) {
    case 'planning':
    case 'architecture':
      return 8_000;
    case 'implementation':
      return 12_000;
    case 'repair':
      return 8_000;
    case 'plan-review':
    case 'architecture-review':
    case 'code-review':
    case 'verification':
      return 5_000;
  }
}
