import { describe, expect, it } from 'vitest';
import {
  ProjectPolicySchema,
  WorkflowDefinitionSchema,
  type ProjectPolicy,
  type VerificationReport,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import { makeHarness, seedRun } from './testing/harness.js';

// Issue #18 (v03-policy-e2e): a bare `type: verify` node is advisory only
// (workflow-orchestrator.ts advances the checkpoint on approval and does
// nothing otherwise) — it never blocks a run. A `quality-loop` wrapping
// `verify` is the only mechanism that can turn "never approved" into a
// blocked run, and its repair loop is unbounded except for the emergency
// ceiling (10 consecutive completed repairs). This fixture chains an
// LLM-reviewer-approved quality-loop into a policy-gated verify quality-loop
// that can never approve, so criteria 3 (policy blocks release despite
// approval) and 4 (budget/ceiling preserves resumable state) are one scenario.
const RELEASE_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'policy-release-e2e-v1',
  name: 'Policy release E2E fixture',
  description:
    'LLM-approved implementation followed by a policy-gated deterministic verification loop.',
  stack: 'node',
  nodes: [
    {
      id: 'implement',
      type: 'agent',
      role: 'developer',
      taskKind: 'implementation',
      title: 'Implement',
      instructions: 'Implement the feature.',
      outputArtifact: 'implementation',
      mutatesWorkspace: true,
    },
    {
      id: 'code-review-gate',
      type: 'quality-loop',
      title: 'LLM code review',
      check: {
        id: 'review',
        type: 'agent',
        role: 'code-reviewer',
        taskKind: 'code-review',
        title: 'Review',
        instructions: 'Review the implementation.',
        inputArtifacts: ['implementation'],
        outputArtifact: 'code.review',
      },
      repair: {
        id: 'repair-review',
        type: 'agent',
        role: 'developer',
        taskKind: 'repair',
        title: 'Repair from review',
        instructions: 'Address review feedback.',
        inputArtifacts: ['implementation', 'code.review'],
        outputArtifact: 'implementation',
      },
      // The harness's default mock agent output always has status: 'completed'
      // (testing/harness.ts ControllableExecutor#result) — this is the LLM
      // reviewer's approval, with no extra fixture scaffolding required.
      approval: { artifact: 'code.review', path: 'status', equals: 'completed' },
    },
    {
      id: 'release-verify',
      type: 'quality-loop',
      title: 'Deterministic release verification',
      check: {
        id: 'verify',
        type: 'verify',
        title: 'Verify',
        outputArtifact: 'verification.report',
      },
      repair: {
        id: 'repair-verification',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair verification failures',
        instructions: 'Fix verification failures.',
        inputArtifacts: ['implementation', 'verification.report'],
        outputArtifact: 'implementation',
      },
      approval: { artifact: 'verification.report', path: 'approved', equals: true },
    },
  ],
});

// id must stay 'default': testing/harness.ts's InMemoryPolicies.get rejects
// any policyId that doesn't match the injected policy's own id, and seedRun
// always creates the project with policyId: 'default'.
const POLICY: ProjectPolicy = ProjectPolicySchema.parse({
  schemaVersion: '1',
  id: 'default',
  version: 1,
  forbiddenDependencies: ['left-pad'],
});

function verificationReport(approved: boolean): VerificationReport {
  return {
    schemaVersion: '1',
    approved,
    packageManager: 'npm',
    summary: approved
      ? 'All configured deterministic checks passed.'
      : '1 configured check(s) failed: policy-dependency-check',
    commands: approved
      ? []
      : [
          {
            name: 'policy-dependency-check',
            command: 'policy',
            args: [],
            exitCode: 1,
            durationMs: 0,
            stdout: '',
            stderr: `Forbidden dependencies declared: left-pad (policy ${POLICY.id}@v${POLICY.version}).`,
            skipped: false,
          },
        ],
    createdAt: new Date().toISOString(),
  };
}

describe('policy-gated release blocks despite an approved review, and the emergency ceiling preserves resumable state (#18)', () => {
  it('blocks the release after the LLM reviewer approves when deterministic policy verification never passes, and the emergency ceiling preserves resumable state', async () => {
    const harness = makeHarness({}, undefined, {
      workflow: RELEASE_WORKFLOW,
      policy: POLICY,
      verification: () => verificationReport(false),
    });
    await seedRun(harness);

    await expect(
      harness.orchestrator.runProject('project-1', undefined, 'run-1'),
    ).rejects.toMatchObject({ name: 'EmergencyCeilingError', reason: 'consecutive-repairs' });

    // The LLM reviewer approved the implementation exactly once and was never re-run.
    const reviews = harness.artifacts.named('code.review');
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.content).toMatchObject({ status: 'completed' });
    expect(harness.events.types().filter((type) => type === 'quality.approved')).toHaveLength(1);

    // The release verification quality-loop looped until the ceiling, never approving.
    expect(harness.executor.started('repair-verification')).toBe(10);
    expect(
      harness.events.types().filter((type) => type === 'quality.repair_requested'),
    ).toHaveLength(10);

    const run = await harness.runs.get('run-1');
    expect(run).toMatchObject({
      status: 'failed',
      policy: { id: 'default', version: 1 },
      error: { name: 'EmergencyCeilingError', code: 'EMERGENCY_CEILING' },
      execution: {
        consecutiveRepairs: 10,
        lastVerifiedCheckpoint: 'initial-head',
        ceiling: { draftBranch: 'draft/run-1' },
      },
    });
    expect((await harness.projects.get('project-1'))?.status).toBe('failed');
    expect(harness.workspaces.drafts).toEqual(['draft/run-1']);
    expect(harness.workspaces.current).toBe('initial-head');
    expect(harness.verifierInputs.at(-1)?.policy).toEqual(POLICY);
  });

  it('completes normally when deterministic verification satisfies the same policy (control case)', async () => {
    const harness = makeHarness({}, undefined, {
      workflow: RELEASE_WORKFLOW,
      policy: POLICY,
      verification: () => verificationReport(true),
    });
    await seedRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    expect(harness.executor.started('repair-verification')).toBe(0);
    expect(harness.events.types().filter((type) => type === 'quality.approved')).toHaveLength(2);
  });
});
