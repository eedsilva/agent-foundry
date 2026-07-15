import { describe, expect, it } from 'vitest';
import { WorkflowNodeSchema } from './workflow.js';

const BASE_GATE = {
  id: 'review-gate',
  type: 'approval-gate' as const,
  title: 'Human review',
  artifact: 'plan',
  outputArtifact: 'plan-approval',
};

describe('approval-gate workflow node', () => {
  it('parses with default actions and no-op timeout', () => {
    const node = WorkflowNodeSchema.parse(BASE_GATE);
    if (node.type !== 'approval-gate') throw new Error('expected approval-gate');
    expect(node.actions).toEqual(['approve', 'reject']);
    expect(node.onReject).toBe('end');
    expect(node.timeout).toEqual({ policy: 'none' });
  });

  it('requires returnToStepId when onReject is return-to-step', () => {
    expect(() =>
      WorkflowNodeSchema.parse({ ...BASE_GATE, onReject: 'return-to-step' }),
    ).toThrow(/returnToStepId/);
  });

  it('requires returnToStepId and repairArtifact when request-changes is allowed', () => {
    expect(() =>
      WorkflowNodeSchema.parse({ ...BASE_GATE, actions: ['approve', 'request-changes'] }),
    ).toThrow(/repairArtifact/);

    const node = WorkflowNodeSchema.parse({
      ...BASE_GATE,
      actions: ['approve', 'request-changes'],
      onReject: 'return-to-step',
      returnToStepId: 'implement',
      repairArtifact: 'repair-notes',
    });
    if (node.type !== 'approval-gate') throw new Error('expected approval-gate');
    expect(node.returnToStepId).toBe('implement');
    expect(node.repairArtifact).toBe('repair-notes');
  });

  it('requires afterMs when a timeout policy is set', () => {
    expect(() =>
      WorkflowNodeSchema.parse({ ...BASE_GATE, timeout: { policy: 'auto-approve' } }),
    ).toThrow(/afterMs/);

    const node = WorkflowNodeSchema.parse({
      ...BASE_GATE,
      timeout: { policy: 'auto-reject', afterMs: 3_600_000 },
    });
    if (node.type !== 'approval-gate') throw new Error('expected approval-gate');
    expect(node.timeout).toEqual({ policy: 'auto-reject', afterMs: 3_600_000 });
  });
});
