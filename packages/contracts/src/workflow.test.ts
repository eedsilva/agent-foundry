import { describe, expect, it } from 'vitest';
import { DEFAULT_ROUTING_TABLE, WorkflowDefinitionSchema, WorkflowNodeSchema } from './workflow.js';

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
    expect(node.blocksOnFailure).toBe(false);
    expect(node.autofixScripts).toEqual([]);
    expect(node.optionalScripts).toEqual([]);
  });

  it('accepts an explicitly blocking verification', () => {
    const node = WorkflowNodeSchema.parse({ ...BASE_VERIFY, blocksOnFailure: true });
    if (node.type !== 'verify') throw new Error('expected verify');
    expect(node.blocksOnFailure).toBe(true);
  });

  it('carries the auto-fix pre-pass and the run-if-defined checks', () => {
    const node = WorkflowNodeSchema.parse({
      ...BASE_VERIFY,
      scripts: ['typecheck'],
      autofixScripts: ['format', 'lint:fix'],
      optionalScripts: ['lint', 'test'],
    });
    if (node.type !== 'verify') throw new Error('expected verify');
    expect(node.autofixScripts).toEqual(['format', 'lint:fix']);
    expect(node.optionalScripts).toEqual(['lint', 'test']);
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
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_VERIFY,
        browserTestPlanArtifact: 'browser-test.plan',
        scripts: [],
        includeGitDiffCheck: false,
        optionalScripts: ['test'],
      }),
    ).toThrow();
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_VERIFY,
        browserTestPlanArtifact: 'browser-test.plan',
        scripts: [],
        includeGitDiffCheck: false,
        autofixScripts: ['format'],
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

const BASE_QUALITY_LOOP = {
  id: 'quality',
  type: 'quality-loop' as const,
  title: 'Quality check',
  check: BASE_AGENT_STEP,
  repair: {
    ...BASE_AGENT_STEP,
    id: 'repair',
    role: 'fixer' as const,
    taskKind: 'repair' as const,
    title: 'Repair the work',
    outputArtifact: 'repair.report',
    mutatesWorkspace: true,
  },
  approval: { artifact: 'quality.report', path: 'approved', equals: true },
};

describe('quality-loop workflow node', () => {
  it('does not expose the ignored maxIterations budget', () => {
    const node = WorkflowNodeSchema.parse({ ...BASE_QUALITY_LOOP, maxIterations: 1 });
    if (node.type !== 'quality-loop') throw new Error('expected quality-loop');
    expect(node).not.toHaveProperty('maxIterations');
  });
});

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

  const BASE_VERIFY = {
    id: 'verify-task',
    type: 'verify' as const,
    title: "Run the task's deterministic checks",
    outputArtifact: 'verification.report',
    scripts: ['typecheck'],
  };
  const BASE_REPAIR = {
    id: 'repair-task',
    type: 'agent' as const,
    role: 'fixer' as const,
    taskKind: 'repair' as const,
    title: 'Repair the failing checks',
    instructions: 'Fix the failing commands.',
    inputArtifacts: ['verification.report'],
    outputArtifact: 'verification.fix',
    mutatesWorkspace: true,
    maxAttempts: 1,
  };

  it('carries the deterministic gate and its bounded repair', () => {
    const node = WorkflowNodeSchema.parse({
      ...BASE_NODE,
      verify: BASE_VERIFY,
      repair: BASE_REPAIR,
    });
    if (node.type !== 'for-each-task') throw new Error('expected for-each-task');
    expect(node.verify?.scripts).toEqual(['typecheck']);
    expect(node.repair?.maxAttempts).toBe(1);
  });

  it('rejects a gate without a repair, and a repair without a gate', () => {
    expect(() => WorkflowNodeSchema.parse({ ...BASE_NODE, verify: BASE_VERIFY })).toThrow(/repair/);
    expect(() => WorkflowNodeSchema.parse({ ...BASE_NODE, repair: BASE_REPAIR })).toThrow(/verify/);
  });

  it('rejects a repair step that cannot change the workspace', () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_NODE,
        verify: BASE_VERIFY,
        repair: { ...BASE_REPAIR, mutatesWorkspace: false },
      }),
    ).toThrow(/mutatesWorkspace/);
  });

  const BASE_BROWSER = {
    plan: {
      id: 'plan-task-browser-test',
      type: 'agent' as const,
      role: 'tester' as const,
      taskKind: 'verification' as const,
      title: "Turn the task's acceptance check into a browser plan",
      instructions: 'Produce a declarative browser test plan.',
      inputArtifacts: ['prd'],
      outputArtifact: 'browser-test.plan',
      mutatesWorkspace: false,
    },
    check: {
      id: 'assert-task',
      type: 'verify' as const,
      title: "Assert the task's acceptance check in a browser",
      outputArtifact: 'browser-verification.report',
      browserTestPlanArtifact: 'browser-test.plan',
      scripts: [],
      includeGitDiffCheck: false,
    },
  };

  it('carries the per-task browser assertion', () => {
    const node = WorkflowNodeSchema.parse({
      ...BASE_NODE,
      verify: BASE_VERIFY,
      repair: BASE_REPAIR,
      browser: BASE_BROWSER,
    });
    if (node.type !== 'for-each-task') throw new Error('expected for-each-task');
    expect(node.browser?.check.browserTestPlanArtifact).toBe('browser-test.plan');
  });

  it('rejects a browser assertion without the deterministic gate before it', () => {
    expect(() => WorkflowNodeSchema.parse({ ...BASE_NODE, browser: BASE_BROWSER })).toThrow(
      /deterministic gate/,
    );
    // And transitively without a repair: browser needs verify, verify needs
    // repair, so a browser assertion always has something to invoke on failure.
    expect(() =>
      WorkflowNodeSchema.parse({ ...BASE_NODE, verify: BASE_VERIFY, browser: BASE_BROWSER }),
    ).toThrow(/repair/);
  });

  it('rejects a browser check reading an artifact its plan step does not write', () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_NODE,
        verify: BASE_VERIFY,
        repair: BASE_REPAIR,
        browser: {
          ...BASE_BROWSER,
          check: { ...BASE_BROWSER.check, browserTestPlanArtifact: 'somewhere-else' },
        },
      }),
    ).toThrow(/writes/);
  });

  it('rejects a browser plan step that mutates the workspace', () => {
    expect(() =>
      WorkflowNodeSchema.parse({
        ...BASE_NODE,
        verify: BASE_VERIFY,
        repair: BASE_REPAIR,
        browser: { ...BASE_BROWSER, plan: { ...BASE_BROWSER.plan, mutatesWorkspace: true } },
      }),
    ).toThrow(/mutate/);
  });
});

describe('workflow routing table', () => {
  const BASE_WORKFLOW = {
    schemaVersion: '1' as const,
    id: 'routed',
    name: 'Routed workflow',
    description: 'Declares which executor runs each task kind',
    stack: 'nextjs',
    nodes: [BASE_AGENT_STEP],
  };

  it('is optional, and carries an ordered executor list per task kind', () => {
    expect(WorkflowDefinitionSchema.parse(BASE_WORKFLOW).routing).toBeUndefined();

    const workflow = WorkflowDefinitionSchema.parse({
      ...BASE_WORKFLOW,
      routing: [
        { taskKind: 'implementation', executors: ['claude', 'codex', 'agy'] },
        { taskKind: 'repair', executors: ['codex', 'claude'] },
      ],
    });
    expect(workflow.routing?.[0]).toEqual({
      taskKind: 'implementation',
      executors: ['claude', 'codex', 'agy'],
    });
  });

  it('rejects an empty executor list, a duplicated task kind, and a retired one', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...BASE_WORKFLOW,
        routing: [{ taskKind: 'implementation', executors: [] }],
      }),
    ).toThrow();
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...BASE_WORKFLOW,
        routing: [
          { taskKind: 'implementation', executors: ['claude'] },
          { taskKind: 'implementation', executors: ['codex'] },
        ],
      }),
    ).toThrow(/once/);
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...BASE_WORKFLOW,
        routing: [{ taskKind: 'architecture', executors: ['claude'] }],
      }),
    ).toThrow();
  });

  it('rejects the mock executor, which is a test double rather than a vendor', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({
        ...BASE_WORKFLOW,
        routing: [{ taskKind: 'implementation', executors: ['mock'] }],
      }),
    ).toThrow();
  });

  it('includes the hosted cheap provider as a later routing rung', () => {
    expect(DEFAULT_ROUTING_TABLE.every((entry) => entry.executors.includes('glm'))).toBe(true);
  });
});
