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
    expect(() => WorkflowNodeSchema.parse({ ...BASE_GATE, onReject: 'return-to-step' })).toThrow(
      /returnToStepId/,
    );
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

describe('verify workflow node', () => {
  const BASE_VERIFY = {
    id: 'verify',
    type: 'verify' as const,
    title: 'Verify the workspace',
    outputArtifact: 'verification.report',
  };

  it('retains workspace verification defaults', () => {
    const node = WorkflowNodeSchema.parse(BASE_VERIFY);
    if (node.type !== 'verify') throw new Error('expected verify');
    expect(node.scripts).toEqual(['typecheck', 'lint', 'test', 'build']);
    expect(node.includeGitDiffCheck).toBe(true);
    expect(node.browserTestPlanArtifact).toBeUndefined();
  });

  it('accepts browser verification only with workspace checks disabled', () => {
    const node = WorkflowNodeSchema.parse({
      ...BASE_VERIFY,
      title: 'Verify the browser journey',
      browserTestPlanArtifact: 'browser-test.plan',
      scripts: [],
      includeGitDiffCheck: false,
    });
    if (node.type !== 'verify') throw new Error('expected verify');
    expect(node.browserTestPlanArtifact).toBe('browser-test.plan');
    expect(node.scripts).toEqual([]);
    expect(node.includeGitDiffCheck).toBe(false);
  });

  it('rejects browser verification mixed with workspace verification', () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_VERIFY,
        browserTestPlanArtifact: 'browser-test.plan',
      }),
    ).toThrow();
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_VERIFY,
        browserTestPlanArtifact: 'browser-test.plan',
        scripts: [],
        includeGitDiffCheck: true,
      }),
    ).toThrow();
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_VERIFY,
        browserTestPlanArtifact: 'browser-test.plan',
        scripts: ['test'],
        includeGitDiffCheck: false,
      }),
    ).toThrow();
  });
});
