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

const BASE_AGENT_STEP = {
  id: 'plan',
  type: 'agent' as const,
  role: 'planner' as const,
  taskKind: 'planning' as const,
  title: 'Plan',
  instructions: 'Plan the work.',
  outputArtifact: 'plan.current',
};

describe('agent step outputContract', () => {
  it('is optional and accepts task-graph', () => {
    const bare = WorkflowNodeSchema.parse(BASE_AGENT_STEP);
    if (bare.type !== 'agent') throw new Error('expected agent step');
    expect(bare.outputContract).toBeUndefined();

    const declared = WorkflowNodeSchema.parse({ ...BASE_AGENT_STEP, outputContract: 'task-graph' });
    if (declared.type !== 'agent') throw new Error('expected agent step');
    expect(declared.outputContract).toBe('task-graph');
  });

  it('rejects unknown contract names', () => {
    expect(() =>
      WorkflowNodeSchema.parse({ ...BASE_AGENT_STEP, outputContract: 'browser-plan' }),
    ).toThrow();
  });
});

describe('for-each-task workflow node', () => {
  const BASE_IMPLEMENT = {
    id: 'implement',
    type: 'agent' as const,
    role: 'developer' as const,
    taskKind: 'implementation' as const,
    title: 'Implement one planned task',
    instructions: 'Implement the task.',
    inputArtifacts: ['prd', 'plan.current'],
    outputArtifact: 'implementation.report',
    mutatesWorkspace: true,
  };
  const BASE_NODE = {
    id: 'task-execution',
    type: 'for-each-task' as const,
    title: 'Implement the approved task graph',
    taskGraphArtifact: 'plan.current',
    implement: BASE_IMPLEMENT,
  };

  it('carries the implement step and its attempt bound', () => {
    const node = WorkflowNodeSchema.parse({
      ...BASE_NODE,
      implement: { ...BASE_IMPLEMENT, maxAttempts: 3 },
    });
    if (node.type !== 'for-each-task') throw new Error('expected for-each-task');
    expect(node.taskGraphArtifact).toBe('plan.current');
    expect(node.implement.id).toBe('implement');
    expect(node.implement.maxAttempts).toBe(3);
  });

  it('rejects an implement step that does not mutate the workspace', () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_NODE,
        implement: { ...BASE_IMPLEMENT, mutatesWorkspace: false },
      }),
    ).toThrow(/mutatesWorkspace/);
  });

  it('rejects unknown fields', () => {
    expect(() => WorkflowNodeSchema.parse({ ...BASE_NODE, maxIterations: 3 })).toThrow();
  });
});
