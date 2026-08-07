import { describe, expect, it } from 'vitest';
import type { StepAttempt } from '@agent-foundry/contracts';
import { summarizeValidationUsage, validationStepKey } from './validation-budget.js';

function attempt(
  id: string,
  usage?: StepAttempt['usage'],
  provider: StepAttempt['provider'] = 'codex',
): StepAttempt {
  return {
    id,
    runId: 'run-1',
    stepRunId: `step-${id}`,
    sequence: 1,
    executorKind: 'agent',
    provider,
    model: 'some-model',
    modelId: 'some-model-id',
    status: 'succeeded',
    version: 1,
    createdAt: '2026-08-03T12:00:00.000Z',
    updatedAt: '2026-08-03T12:00:00.000Z',
    startedAt: '2026-08-03T12:00:00.000Z',
    usage,
    context: {
      projectId: 'project-1',
      workflowId: 'workflow-1',
      nodeId: 'node-1',
      stepId: 'step-1',
    },
    inputArtifacts: [],
    outputArtifacts: [],
  };
}

describe('validation campaign budget accounting', () => {
  it('counts attempts per step and subscription quota per provider', () => {
    const summary = summarizeValidationUsage([
      attempt('one', { quotaUnits: 2 }),
      attempt('two', { quotaUnits: 3 }),
      attempt('no-usage'),
      attempt('claude', { quotaUnits: 4 }, 'claude'),
    ]);

    expect(summary).toMatchObject({
      subscriptionQuotaUnits: 9,
      subscriptionQuotaUnitsByProvider: { codex: 5, claude: 4 },
    });
    expect(summary.attemptsByStep[validationStepKey('node-1', 'step-1')]).toBe(4);
  });

  it('ignores attempts without quota metadata instead of inventing usage', () => {
    const summary = summarizeValidationUsage([attempt('no-usage'), attempt('cost-only', {})]);

    expect(summary.subscriptionQuotaUnits).toBe(0);
    expect(summary.subscriptionQuotaUnitsByProvider).toEqual({});
    expect(summary.attemptsByStep[validationStepKey('node-1', 'step-1')]).toBe(2);
  });
});
