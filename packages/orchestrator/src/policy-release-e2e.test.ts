import { describe, expect, it } from 'vitest';
import {
  BrowserVerificationReportSchema,
  ProjectPolicySchema,
  WorkflowDefinitionSchema,
  type AgentArtifact,
  type AgentExecutionRequest,
  type BrowserVerificationReport,
  type PreviewSession,
  type ProjectPolicy,
  type VerificationReport,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import type { BrowserVerifier } from '@agent-foundry/domain';
import { BrowserVerificationCoordinator } from './browser-verification-coordinator.js';
import type { PreviewService } from './preview-service.js';
import { completeRun, makeHarness, seedRun } from './testing/harness.js';

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

const BROWSER_PLAN_ARTIFACT = 'critical-journey.contract';

const BROWSER_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'browser-release-e2e-v1',
  name: 'Browser release E2E fixture',
  description: 'Browser failure, repair, and exact-plan rerun coverage.',
  stack: 'node',
  nodes: [
    {
      id: 'browser-verification',
      type: 'quality-loop',
      title: 'Browser verification',
      maxIterations: 3,
      setup: {
        id: 'plan-browser-test',
        type: 'agent',
        role: 'tester',
        taskKind: 'verification',
        title: 'Plan browser verification',
        instructions: 'Define the exact browser journey.',
        outputArtifact: BROWSER_PLAN_ARTIFACT,
      },
      check: {
        id: 'verify-browser',
        type: 'verify',
        title: 'Verify browser',
        outputArtifact: 'browser-verification.report',
        browserTestPlanArtifact: BROWSER_PLAN_ARTIFACT,
        scripts: [],
        includeGitDiffCheck: false,
      },
      repair: {
        id: 'repair-browser',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair browser failures',
        instructions: 'Repair the exact failed browser journey.',
        inputArtifacts: [BROWSER_PLAN_ARTIFACT, 'browser-verification.report'],
        outputArtifact: 'browser-verification.fix',
        mutatesWorkspace: true,
      },
      approval: {
        artifact: 'browser-verification.report',
        path: 'approved',
        equals: true,
      },
    },
  ],
});

const BROWSER_PLAN = {
  schemaVersion: '1',
  status: 'completed',
  summary: 'Verify the CRUD journey.',
  data: {
    schemaVersion: '1',
    id: 'crud',
    title: 'CRUD journey',
    viewport: { width: 1280, height: 720 },
    steps: [
      {
        id: 'open-items',
        title: 'Open items',
        action: { kind: 'goto', path: '/items' },
        assertions: [{ kind: 'url', path: '/items' }],
      },
    ],
  },
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
} satisfies AgentArtifact;

function browserReportSteps(approved: boolean): BrowserVerificationReport['steps'] {
  return [
    {
      stepId: 'open-items',
      title: 'Open items',
      status: approved ? 'passed' : 'failed',
      durationMs: 1,
      ...(approved ? {} : { error: 'Browser verification failed.' }),
      observations: [],
    },
  ];
}

function browserCoordinator(verify: BrowserVerifier['verify']) {
  const stopped: string[] = [];
  const sessions = new Map<string, PreviewSession>();
  let sequence = 0;
  const previews = {
    start: ({ workspaceRef, runId }: Parameters<PreviewService['start']>[0]) => {
      sequence += 1;
      const now = '2026-07-17T12:00:00.000Z';
      const session: PreviewSession = {
        id: `preview-${sequence}`,
        ...(runId ? { runId } : {}),
        workspaceRef,
        status: 'running',
        version: 3,
        url: `http://127.0.0.1:4000/preview/preview-${sequence}/?token=secret`,
        process: { command: 'npm', args: ['run', 'dev'], port: 3000 + sequence },
        health: { state: 'healthy', checkedAt: now, consecutiveFailures: 0 },
        ttl: { seconds: 1800, expiresAt: '2026-07-17T12:30:00.000Z' },
        restartCount: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
      };
      sessions.set(session.id, session);
      return Promise.resolve({ session, url: session.url! });
    },
    stop: (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (!session) return Promise.reject(new Error(`Unknown preview ${sessionId}`));
      stopped.push(sessionId);
      return Promise.resolve({
        ...session,
        status: 'stopped' as const,
        updatedAt: '2026-07-17T12:00:01.000Z',
        completedAt: '2026-07-17T12:00:01.000Z',
      });
    },
  } satisfies Pick<PreviewService, 'start' | 'stop'>;
  const mockArtifacts = {
    putBlob: () =>
      Promise.resolve({
        projectId: 'project-1',
        name: 'test',
        revision: 1,
        contentType: 'application/octet-stream',
        createdAt: '2026-07-17T12:00:00.000Z',
        createdBy: 'tester',
        sha256: 'a'.repeat(64),
        storage: 'blob' as const,
        sizeBytes: 0,
      }),
  };
  const mockLimits = {
    maxScreenshotBytes: 10_000_000,
    maxTraceBytes: 50_000_000,
    maxVideoBytes: 100_000_000,
    retentionSeconds: 86400,
  };
  return {
    coordinator: new BrowserVerificationCoordinator(
      previews,
      { verify },
      mockArtifacts,
      mockLimits,
    ),
    get started() {
      return sequence;
    },
    stopped,
  };
}

function failingVerificationReport(): VerificationReport {
  return {
    schemaVersion: '1',
    approved: false,
    packageManager: 'npm',
    summary: 'policy-dependency-check failed',
    commands: [],
    createdAt: new Date().toISOString(),
  };
}

describe('policy-gated release blocks despite an approved review, and the emergency ceiling preserves resumable state (#18)', () => {
  it('blocks the release after the LLM reviewer approves when deterministic policy verification never passes, and the emergency ceiling preserves resumable state', async () => {
    const harness = makeHarness({}, undefined, {
      workflow: RELEASE_WORKFLOW,
      policy: POLICY,
      verification: failingVerificationReport,
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
    // No `verification` override: the harness default already returns an
    // approved report (testing/harness.ts), same as a policy-satisfying check.
    const harness = makeHarness({}, undefined, { workflow: RELEASE_WORKFLOW, policy: POLICY });
    await completeRun(harness);

    expect(harness.executor.started('repair-verification')).toBe(0);
    expect(harness.events.types().filter((type) => type === 'quality.approved')).toHaveLength(2);
  });
});

describe('browser verification orchestration (#32)', () => {
  it('repairs and reruns the exact plan, reuses only an exact completed attempt, and checkpoints only approval', async () => {
    const verifierInputs: Parameters<BrowserVerifier['verify']>[0][] = [];
    const stopped: string[] = [];
    const previewSessions = new Map<string, PreviewSession>();
    let previewSequence = 0;
    const previews = {
      start: ({ workspaceRef, runId }: Parameters<PreviewService['start']>[0]) => {
        previewSequence += 1;
        const sessionId = `preview-${previewSequence}`;
        const now = '2026-07-17T12:00:00.000Z';
        const session: PreviewSession = {
          id: sessionId,
          runId,
          workspaceRef,
          status: 'running',
          version: 3,
          url: `http://127.0.0.1:4000/preview/${sessionId}/?token=secret`,
          process: { command: 'npm', args: ['run', 'dev'], port: 3000 + previewSequence },
          health: { state: 'healthy', checkedAt: now, consecutiveFailures: 0 },
          ttl: { seconds: 1800, expiresAt: '2026-07-17T12:30:00.000Z' },
          restartCount: 0,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        };
        previewSessions.set(sessionId, session);
        return Promise.resolve({ session, url: session.url! });
      },
      stop: (sessionId: string) => {
        const session = previewSessions.get(sessionId);
        if (!session) return Promise.reject(new Error(`Unknown preview ${sessionId}`));
        stopped.push(sessionId);
        return Promise.resolve({
          ...session,
          status: 'stopped' as const,
          updatedAt: '2026-07-17T12:00:01.000Z',
          completedAt: '2026-07-17T12:00:01.000Z',
        });
      },
    } satisfies Pick<PreviewService, 'start' | 'stop'>;
    let addNewerPlan = (): Promise<void> => Promise.resolve();
    const browserVerifier: BrowserVerifier = {
      verify: async (input) => {
        verifierInputs.push(input);
        if (verifierInputs.length === 1) await addNewerPlan();
        const approved = verifierInputs.length > 1;
        const report = BrowserVerificationReportSchema.parse({
          schemaVersion: '1',
          approved,
          summary: approved ? 'Browser verification passed.' : 'Browser verification failed.',
          planArtifact: input.planArtifact,
          previewSession: {
            ...input.session,
            url: input.session.url?.replace(/\?.*$/, ''),
          },
          steps: browserReportSteps(approved),
        }) satisfies BrowserVerificationReport;
        return {
          report,
          evidence: { screenshots: [] },
        };
      },
    };
    const mockArtifacts = {
      putBlob: () =>
        Promise.resolve({
          projectId: 'project-1',
          name: 'test',
          revision: 1,
          contentType: 'application/octet-stream',
          createdAt: '2026-07-17T12:00:00.000Z',
          createdBy: 'tester',
          sha256: 'a'.repeat(64),
          storage: 'blob' as const,
          sizeBytes: 0,
        }),
    };
    const mockLimits = {
      maxScreenshotBytes: 10_000_000,
      maxTraceBytes: 50_000_000,
      maxVideoBytes: 100_000_000,
      retentionSeconds: 86400,
    };
    const browserVerification = new BrowserVerificationCoordinator(
      previews,
      browserVerifier,
      mockArtifacts,
      mockLimits,
    );
    let planRequestOutputSchema: AgentExecutionRequest['outputSchema'];
    const harness = makeHarness({}, undefined, {
      workflow: BROWSER_WORKFLOW,
      browserVerification,
      agentOutput: (request) => {
        if (request.stepId !== 'plan-browser-test') return undefined;
        planRequestOutputSchema = request.outputSchema;
        return BROWSER_PLAN;
      },
    });
    await seedRun(harness);
    let revisedPlan: Awaited<ReturnType<typeof harness.artifacts.put>> | undefined;
    addNewerPlan = async () => {
      revisedPlan = await harness.artifacts.put({
        projectId: 'project-1',
        name: BROWSER_PLAN_ARTIFACT,
        content: { ...BROWSER_PLAN, summary: 'Newer plan that must not replace the setup plan.' },
        createdBy: 'tester',
      });
    };

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    const [storedPlan] = harness.artifacts.named(BROWSER_PLAN_ARTIFACT);
    if (!storedPlan || !revisedPlan) throw new Error('Expected both browser plan revisions');
    const planReference = {
      name: storedPlan.metadata.name,
      revision: storedPlan.metadata.revision,
      sha256: storedPlan.metadata.sha256,
    };

    const browserStepRuns = harness.stepRuns.byStepId('run-1', 'verify-browser');
    const browserAttempts = (
      await Promise.all(
        browserStepRuns.map((stepRun) => harness.stepAttempts.list('run-1', stepRun.id)),
      )
    ).flat();
    expect(browserAttempts).toHaveLength(2);
    expect(
      browserAttempts.map((attempt) => ({
        model: attempt.model,
        inputArtifacts: attempt.inputArtifacts,
        previewSessionId: attempt.previewSessionId,
      })),
    ).toEqual([
      {
        model: 'browser-verifier',
        inputArtifacts: [planReference],
        previewSessionId: 'preview-1',
      },
      {
        model: 'browser-verifier',
        inputArtifacts: [planReference],
        previewSessionId: 'preview-2',
      },
    ]);
    expect(verifierInputs.map((input) => input.planArtifact)).toEqual([
      planReference,
      planReference,
    ]);
    expect(verifierInputs.map((input) => input.planContent)).toEqual([BROWSER_PLAN, BROWSER_PLAN]);
    expect(planRequestOutputSchema).toMatchObject({
      type: 'object',
      properties: {
        data: {
          type: 'object',
          required: ['schemaVersion', 'id', 'title', 'viewport', 'steps'],
          properties: {
            steps: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                required: ['id', 'title', 'action', 'assertions'],
              },
            },
          },
        },
      },
    });

    const reports = harness.artifacts.named('browser-verification.report');
    expect(reports).toHaveLength(2);
    expect(reports.map((report) => report.content)).toMatchObject([
      {
        approved: false,
        planArtifact: planReference,
        previewSession: { sessionId: 'preview-1' },
      },
      {
        approved: true,
        planArtifact: planReference,
        previewSession: { sessionId: 'preview-2' },
      },
    ]);
    const failedReportReference = {
      name: reports[0]!.metadata.name,
      revision: reports[0]!.metadata.revision,
      sha256: reports[0]!.metadata.sha256,
    };
    const [repairStepRun] = harness.stepRuns.byStepId('run-1', 'repair-browser');
    const [repairAttempt] = await harness.stepAttempts.list('run-1', repairStepRun!.id);
    expect(repairAttempt?.inputArtifacts).toEqual([planReference, failedReportReference]);
    expect(stopped).toEqual(['preview-1', 'preview-2']);
    expect(harness.workspaces.checkpoints).toEqual(['initial-head', 'sha-0001']);
    expect(harness.events.types().filter((type) => type === 'verification.completed')).toHaveLength(
      2,
    );

    const completed = await harness.runs.get('run-1');
    if (!completed) throw new Error('Expected completed run');
    const reusedBefore = harness.events.events.filter(
      (event) => event.type === 'step.reused',
    ).length;
    const replay = { ...completed, status: 'running' as const };
    delete replay.completedAt;
    await harness.runs.update(replay, completed.version);
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    expect(verifierInputs).toHaveLength(2);
    expect(
      harness.events.events
        .filter((event) => event.type === 'step.reused')
        .slice(reusedBefore)
        .map((event) => event.message),
    ).toEqual([
      expect.stringContaining('plan-browser-test reused'),
      expect.stringContaining('verify-browser reused browser-verification.report r1'),
      expect.stringContaining('repair-browser reused'),
      expect.stringContaining('verify-browser reused browser-verification.report r2'),
    ]);
    expect(harness.artifacts.named(BROWSER_PLAN_ARTIFACT).at(-1)?.metadata).toMatchObject({
      revision: revisedPlan.metadata.revision,
      sha256: revisedPlan.metadata.sha256,
    });
    expect(verifierInputs.every((input) => input.planArtifact.revision === 1)).toBe(true);
    expect(stopped).toEqual(['preview-1', 'preview-2']);
  });

  it('retains the preview session on a browser attempt when verification throws', async () => {
    const browser = browserCoordinator(() => Promise.reject(new Error('browser crashed')));
    const harness = makeHarness({}, undefined, {
      workflow: BROWSER_WORKFLOW,
      browserVerification: browser.coordinator,
      agentOutput: (request) => (request.stepId === 'plan-browser-test' ? BROWSER_PLAN : undefined),
    });
    await seedRun(harness);

    await expect(harness.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      'browser crashed',
    );

    const [stepRun] = harness.stepRuns.byStepId('run-1', 'verify-browser');
    const [attempt] = await harness.stepAttempts.list('run-1', stepRun!.id);
    expect(attempt).toMatchObject({
      status: 'failed',
      model: 'browser-verifier',
      previewSessionId: 'preview-1',
    });
    expect(browser.stopped).toEqual(['preview-1']);
  });

  it.each([
    [
      'first action is not goto',
      {
        ...BROWSER_PLAN,
        data: {
          ...BROWSER_PLAN.data,
          steps: [
            {
              ...BROWSER_PLAN.data.steps[0],
              action: { kind: 'click', locator: { by: 'text', text: 'Create' } },
            },
          ],
        },
      },
    ],
    [
      'step ids are duplicated',
      {
        ...BROWSER_PLAN,
        data: {
          ...BROWSER_PLAN.data,
          steps: [BROWSER_PLAN.data.steps[0], { ...BROWSER_PLAN.data.steps[0] }],
        },
      },
    ],
  ] as const)(
    'persists provider output where %s as a reproducible failed browser report',
    async (_case, invalidPlan) => {
      const browser = browserCoordinator(() => {
        throw new Error('runtime verifier must not receive an invalid plan');
      });
      const harness = makeHarness({}, undefined, {
        workflow: BROWSER_WORKFLOW,
        browserVerification: browser.coordinator,
        agentOutput: (request) =>
          request.stepId === 'plan-browser-test' ? invalidPlan : undefined,
      });
      await seedRun(harness);

      await expect(
        harness.orchestrator.runProject('project-1', undefined, 'run-1'),
      ).rejects.toThrow('consecutive-repairs emergency ceiling');

      const reports = harness.artifacts.named('browser-verification.report');
      expect(reports).toHaveLength(10);
      for (const report of reports) {
        expect(report.content).toMatchObject({
          approved: false,
          summary: 'Browser test plan validation failed.',
          planValidationError: expect.any(String),
          steps: [],
        });
      }
      expect(browser.started).toBe(10);
      expect(browser.stopped).toHaveLength(10);
    },
  );

  it.each(['report-artifact', 'attempt-success'] as const)(
    'does not advance the verified checkpoint when %s persistence fails',
    async (failure) => {
      const browser = browserCoordinator((input) => {
        const report = BrowserVerificationReportSchema.parse({
          schemaVersion: '1',
          approved: true,
          summary: 'Browser verification passed.',
          planArtifact: input.planArtifact,
          previewSession: {
            ...input.session,
            url: input.session.url?.replace(/\?.*$/, ''),
          },
          steps: browserReportSteps(true),
        });
        return Promise.resolve({
          report,
          evidence: { screenshots: [] },
        });
      });
      const harness = makeHarness({}, undefined, {
        workflow: BROWSER_WORKFLOW,
        browserVerification: browser.coordinator,
        agentOutput: (request) =>
          request.stepId === 'plan-browser-test' ? BROWSER_PLAN : undefined,
      });
      await seedRun(harness);
      if (failure === 'report-artifact') {
        harness.artifacts.onAfterPut = (name) => {
          if (name !== 'browser-verification.report') return;
          harness.artifacts.onAfterPut = undefined;
          throw new Error('report persistence failed');
        };
      } else {
        harness.stepAttempts.onBeforeUpdate = (attempt) => {
          if (attempt.model !== 'browser-verifier' || attempt.status !== 'succeeded') return;
          harness.stepAttempts.onBeforeUpdate = undefined;
          throw new Error('attempt persistence failed');
        };
      }

      await expect(
        harness.orchestrator.runProject('project-1', undefined, 'run-1'),
      ).rejects.toThrow(
        `${failure === 'report-artifact' ? 'report' : 'attempt'} persistence failed`,
      );

      expect(harness.workspaces.checkpoints).toEqual([]);
      expect((await harness.runs.get('run-1'))?.execution?.lastVerifiedCheckpoint).toBe(
        'initial-head',
      );
      expect(browser.stopped).toEqual(['preview-1']);
    },
  );

  it.each([
    { failure: 'checkpoint', firstApproved: true, replayApproved: false },
    { failure: 'event', firstApproved: false, replayApproved: true },
  ] as const)(
    'uses the persisted report after a $failure failure and an opposite replay result',
    async ({ failure, firstApproved, replayApproved }) => {
      const approvals = [firstApproved, replayApproved, true];
      let verifierCalls = 0;
      const browser = browserCoordinator((input) => {
        const approved = approvals[verifierCalls++]!;
        const report = BrowserVerificationReportSchema.parse({
          schemaVersion: '1',
          approved,
          summary: approved ? 'Persisted browser approval.' : 'Persisted browser rejection.',
          planArtifact: input.planArtifact,
          previewSession: {
            ...input.session,
            url: input.session.url?.replace(/\?.*$/, ''),
          },
          steps: browserReportSteps(approved),
        });
        return Promise.resolve({
          report,
          evidence: { screenshots: [] },
        });
      });
      const harness = makeHarness({}, undefined, {
        workflow: BROWSER_WORKFLOW,
        browserVerification: browser.coordinator,
        agentOutput: (request) =>
          request.stepId === 'plan-browser-test' ? BROWSER_PLAN : undefined,
      });
      await seedRun(harness);
      if (failure === 'checkpoint') {
        harness.workspaces.onBeforeCheckpoint = () => {
          harness.workspaces.onBeforeCheckpoint = undefined;
          throw new Error('checkpoint persistence failed');
        };
      } else {
        harness.events.onBeforeAppend = (event) => {
          if (event.type !== 'verification.completed') return;
          harness.events.onBeforeAppend = undefined;
          throw new Error('event persistence failed');
        };
      }

      await expect(
        harness.orchestrator.runProject('project-1', undefined, 'run-1'),
      ).rejects.toThrow(`${failure} persistence failed`);

      const failedRun = await harness.runs.get('run-1');
      if (!failedRun) throw new Error('Expected failed run');
      const { error: _error, completedAt: _completedAt, ...retryable } = failedRun;
      await harness.runs.update(
        { ...retryable, status: 'running', updatedAt: new Date().toISOString() },
        failedRun.version,
      );
      await harness.orchestrator.runProject('project-1', undefined, 'run-1');

      const reports = harness.artifacts.named('browser-verification.report');
      const verificationEvents = harness.events.events.filter(
        (event) => event.type === 'verification.completed',
      );
      expect(reports[0]?.content).toMatchObject({ approved: firstApproved });
      expect(verificationEvents[0]).toMatchObject({
        message: firstApproved ? 'Persisted browser approval.' : 'Persisted browser rejection.',
        data: { approved: firstApproved },
      });
      if (failure === 'checkpoint') {
        expect(reports).toHaveLength(1);
        expect(browser.started).toBe(1);
        expect(verifierCalls).toBe(1);
        expect(harness.executor.started('repair-browser')).toBe(0);
        expect(harness.workspaces.checkpoints).toEqual(['initial-head']);
      } else {
        expect(reports.map((report) => (report.content as { approved: boolean }).approved)).toEqual(
          [false, true],
        );
        expect(harness.executor.started('repair-browser')).toBe(1);
      }
    },
  );

  it.each([
    [
      'plan revision',
      (report: BrowserVerificationReport) => ({
        ...report,
        planArtifact: { ...report.planArtifact, revision: 999 },
      }),
    ],
    [
      'preview session',
      (report: BrowserVerificationReport) => ({
        ...report,
        previewSession: { ...report.previewSession, sessionId: 'forged-preview' },
      }),
    ],
    [
      'step sequence',
      (report: BrowserVerificationReport) => ({
        ...report,
        steps: [{ ...report.steps[0]!, stepId: 'forged-step' }],
      }),
    ],
  ] as const)(
    'rejects an adversarial persisted approval with a different %s',
    async (_case, mutate) => {
      const browser = browserCoordinator((input) => {
        const report = BrowserVerificationReportSchema.parse({
          schemaVersion: '1',
          approved: true,
          summary: 'Persisted browser approval.',
          planArtifact: input.planArtifact,
          previewSession: {
            ...input.session,
            url: input.session.url?.replace(/\?.*$/, ''),
          },
          steps: browserReportSteps(true),
        });
        return Promise.resolve({
          report,
          evidence: { screenshots: [] },
        });
      });
      const harness = makeHarness({}, undefined, {
        workflow: BROWSER_WORKFLOW,
        browserVerification: browser.coordinator,
        agentOutput: (request) =>
          request.stepId === 'plan-browser-test' ? BROWSER_PLAN : undefined,
      });
      await seedRun(harness);
      harness.workspaces.onBeforeCheckpoint = () => {
        harness.workspaces.onBeforeCheckpoint = undefined;
        throw new Error('checkpoint persistence failed');
      };

      await expect(
        harness.orchestrator.runProject('project-1', undefined, 'run-1'),
      ).rejects.toThrow('checkpoint persistence failed');
      const [stored] = harness.artifacts.named('browser-verification.report');
      if (!stored) throw new Error('Expected persisted browser report');
      stored.content = mutate(stored.content as BrowserVerificationReport);
      const failedRun = await harness.runs.get('run-1');
      if (!failedRun) throw new Error('Expected failed run');
      const { error: _error, completedAt: _completedAt, ...retryable } = failedRun;
      await harness.runs.update(
        { ...retryable, status: 'running', updatedAt: new Date().toISOString() },
        failedRun.version,
      );

      await expect(
        harness.orchestrator.runProject('project-1', undefined, 'run-1'),
      ).rejects.toThrow(/browser verification report/i);
      expect(harness.workspaces.checkpoints).toEqual([]);
    },
  );
});
