import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  RouteDecisionSchema,
  SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA,
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  UI_QUALITY_RUBRIC_V1,
  WorkflowDefinitionSchema,
  type AgentExecutionRequest,
  type AgentExecutionResult,
  type AgentArtifact,
  type ArtifactReference,
  type ExecutableStep,
  type ExecutorHealth,
  type Project,
  type StoredArtifact,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import {
  EmergencyCeilingError,
  MigrationApprovalRequiredError,
  SystemClock,
  type Clock,
  type ExecutorRegistry,
  type HarnessRepository,
  type JobQueue,
  type MetricsRepository,
  type ModelRouter,
  type SecretStore,
  type SystemPromptRepository,
  type VerificationService,
  type WorkflowRepository,
} from '@agent-foundry/domain';
import {
  DEFAULT_POLICY,
  FakeSecretStore,
  FakeWorkspaces,
  InMemoryApprovalDecisions,
  InMemoryApprovalRequests,
  InMemoryArtifacts,
  InMemoryEvents,
  InMemoryPolicies,
  InMemoryProjects,
  InMemoryRuns,
  InMemoryStepAttempts,
  InMemoryStepEvents,
  InMemoryStepRuns,
  MODELS,
  SequentialIds,
  ControllableExecutor,
  makeHarness,
  makeStores,
  seedRun as seedHarnessRun,
  type HasExecuteStep,
} from './testing/harness.js';
import type { ProjectVersionService } from './project-version-service.js';
import { WorkflowOrchestrator } from './workflow-orchestrator.js';

/** One non-mutating step, one mutating step: enough to exercise the recording hook. */
const WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'version-hook-v1',
  name: 'Version hook fixture',
  description: 'A planning step and a mutating implementation step.',
  stack: 'node',
  nodes: [
    {
      id: 'plan',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan',
      instructions: 'Plan the work.',
      outputArtifact: 'plan',
    },
    {
      id: 'implement',
      type: 'agent',
      role: 'developer',
      taskKind: 'implementation',
      title: 'Implement',
      instructions: 'Implement the plan.',
      inputArtifacts: ['plan'],
      outputArtifact: 'implementation',
      mutatesWorkspace: true,
      maxAttempts: 1,
    },
  ],
});

/** One mutating step with no input artifacts, so `executeStep` can be called directly (#520). */
const WORKTREE_PLUMBING_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'worktree-plumbing-v1',
  name: 'Worktree plumbing fixture',
  description: 'A single mutating step, called directly to prove worktree threading (#520).',
  stack: 'node',
  nodes: [
    {
      id: 'implement',
      type: 'agent',
      role: 'developer',
      taskKind: 'implementation',
      title: 'Implement',
      instructions: 'Implement the plan.',
      outputArtifact: 'implementation',
      mutatesWorkspace: true,
      maxAttempts: 1,
    },
  ],
});

const BROWSER_EVIDENCE_REPAIR_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'browser-evidence-repair-v1',
  name: 'Browser evidence repair fixture',
  description: 'Runs one repair step against a failed browser report.',
  stack: 'node',
  nodes: [
    {
      id: 'repair-browser',
      type: 'agent',
      role: 'fixer',
      taskKind: 'repair',
      title: 'Repair browser failure',
      instructions: 'Repair the failed browser step.',
      inputArtifacts: ['browser-verification.report'],
      outputArtifact: 'browser-verification.fix',
      mutatesWorkspace: true,
      maxAttempts: 1,
    },
  ],
});

function makeOrchestrator(
  versions?: ProjectVersionService,
  executorHealth?: ExecutorHealth[],
  secretStore?: SecretStore,
  opts?: {
    workflow?: WorkflowDefinition;
    output?: (request: AgentExecutionRequest) => AgentExecutionResult['output'];
    routeFallback?: boolean;
  },
) {
  const workflow = opts?.workflow ?? WORKFLOW;
  const power = { on: true };
  const clock = new SystemClock();
  const ids = new SequentialIds();
  const projects = new InMemoryProjects(power);
  const runs = new InMemoryRuns(power);
  const stepRuns = new InMemoryStepRuns(power);
  const stepAttempts = new InMemoryStepAttempts(power);
  const approvalRequests = new InMemoryApprovalRequests(power);
  const approvalDecisions = new InMemoryApprovalDecisions(power);
  const artifacts = new InMemoryArtifacts(power);
  const events = new InMemoryEvents(power);
  const stepEvents = new InMemoryStepEvents();
  const workspaces = new FakeWorkspaces(power);
  const executor = new ControllableExecutor({}, workspaces, opts?.output);

  const workflows: WorkflowRepository = {
    get: () => Promise.resolve(workflow),
    list: () => Promise.resolve([workflow]),
  };
  const harnessRepo: HarnessRepository = {
    select: () => Promise.resolve({ version: '1', files: [], combined: '' }),
    scaffoldFiles: () => Promise.resolve([]),
    version: () => Promise.resolve('1'),
  };
  const route = vi.fn<ModelRouter['route']>((profile) =>
    Promise.resolve(
      RouteDecisionSchema.parse({
        routeId: 'route-1',
        createdAt: new Date().toISOString(),
        profile,
        selected: {
          model: MODELS[0],
          score: {
            capability: 0.5,
            context: 0.5,
            speed: 0.5,
            cost: 0.5,
            reliability: 0.5,
            historical: 0.5,
            tagAffinity: 0,
            estimatedCostUsd: null,
            total: 3,
          },
        },
        fallbacks: opts?.routeFallback
          ? [
              {
                model: MODELS[1],
                score: {
                  capability: 0.5,
                  context: 0.5,
                  speed: 0.5,
                  cost: 0.5,
                  reliability: 0.5,
                  historical: 0.5,
                  tagAffinity: 0,
                  estimatedCostUsd: null,
                  total: 2,
                },
              },
            ]
          : [],
        rejected: [],
      }),
    ),
  );
  const router: ModelRouter = {
    route,
    catalog: () => Promise.resolve(MODELS),
  };
  const metrics: MetricsRepository = {
    get: () => Promise.resolve(null),
    list: () => Promise.resolve([]),
    record: () => Promise.resolve(),
    recordQuality: () => Promise.resolve(),
  };
  const verifier: VerificationService = {
    verify: () => Promise.reject(new Error('verify is not used by this fixture')),
  };
  const queue: JobQueue = {
    enqueue: () => Promise.resolve(),
    claim: () => Promise.resolve(null),
    heartbeat: (job) => Promise.resolve(job),
    ack: () => Promise.resolve(),
    nack: () => Promise.resolve(),
    reapExpired: () => Promise.resolve([]),
  };
  const executors: Pick<ExecutorRegistry, 'health' | 'get'> | undefined = executorHealth
    ? {
        health: () => Promise.resolve(executorHealth),
        get: () => {
          throw new Error('No executor registry is wired for this test.');
        },
      }
    : undefined;

  const orchestrator = new WorkflowOrchestrator(
    projects,
    runs,
    stepRuns,
    stepAttempts,
    approvalRequests,
    approvalDecisions,
    queue,
    artifacts,
    events,
    stepEvents,
    workflows,
    new InMemoryPolicies(DEFAULT_POLICY),
    harnessRepo,
    router,
    metrics,
    executor,
    verifier,
    workspaces,
    clock,
    ids,
    { agentTimeoutMs: 60_000, cancelPollIntervalMs: 10 },
    undefined,
    versions,
    undefined,
    undefined,
    executors,
    secretStore,
  );

  return {
    projects,
    runs,
    stepRuns,
    stepAttempts,
    artifacts,
    events,
    workspaces,
    clock,
    orchestrator,
    route,
    executor,
  };
}

async function seedRun(
  stores: ReturnType<typeof makeOrchestrator>,
  workflowId = WORKFLOW.id,
): Promise<void> {
  const now = stores.clock.now().toISOString();
  await stores.projects.create({
    id: 'project-1',
    name: 'Version hook fixture',
    workflowId,
    policyId: 'default',
    status: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
    currentRunId: 'run-1',
  });
  await stores.runs.create({
    id: 'run-1',
    projectId: 'project-1',
    workflowId,
    status: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

describe('ProjectVersion recording hook (#40)', () => {
  it('passes live provider health to every workflow route decision', async () => {
    const health: ExecutorHealth = {
      provider: 'codex',
      available: true,
      message: 'ok',
      rateLimit: { remaining: 1 },
    };
    const stores = makeOrchestrator(undefined, [health]);
    await seedRun(stores);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(stores.route).toHaveBeenCalledWith(expect.anything(), undefined, {
      providerHealth: new Map([['codex', health]]),
      // The fixture declares no table of its own, so the engine's table answers
      // and the constraint records that it did (#326).
      routing: { source: 'default', executors: ['claude', 'codex'] },
    });
  });

  it('records exactly one ProjectVersion after the mutating step commits, and none for the non-mutating step', async () => {
    const recordFromStep = vi.fn(
      async (_input: Parameters<ProjectVersionService['recordFromStep']>[0]) =>
        ({}) as Awaited<ReturnType<ProjectVersionService['recordFromStep']>>,
    );
    const versions = { recordFromStep } as unknown as ProjectVersionService;
    const stores = makeOrchestrator(versions);
    await seedRun(stores);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    expect(recordFromStep).toHaveBeenCalledTimes(1);
    const [input] = recordFromStep.mock.calls[0]!;
    expect(input).toMatchObject({ projectId: 'project-1', runId: 'run-1' });
    expect(typeof input.commit).toBe('string');
    expect(input.commit.length).toBeGreaterThan(0);
    const implementStepRun = (await stores.stepRuns.list('run-1')).find(
      (step) => step.stepId === 'implement',
    );
    expect(input.stepRunId).toBe(implementStepRun?.id);
  });

  it('does not record anything when no ProjectVersionService is injected', async () => {
    const stores = makeOrchestrator(undefined);
    await seedRun(stores);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    expect(stores.workspaces.commits).toHaveLength(1);
  });

  it('populates ExecutionRequest.secrets with declared names only, never values', async () => {
    const secretStore = new FakeSecretStore({ STRIPE_SECRET_KEY: 'sk-should-never-appear' });
    const stores = makeOrchestrator(undefined, undefined, secretStore);
    const project = {
      id: 'project-1',
      name: 'Test',
      workflowId: WORKFLOW.id,
      policyId: 'default',
      version: 1,
    } as Project;
    await stores.projects.create(project);

    await stores.orchestrator.runProject(project.id);

    const submitted = stores.executor.submittedExecutionRequests.at(-1);
    expect(submitted?.secrets).toEqual([{ name: 'STRIPE_SECRET_KEY', ref: 'STRIPE_SECRET_KEY' }]);
    expect(JSON.stringify(submitted)).not.toContain('sk-should-never-appear');
  });
});

describe('browser repair evidence materialization (#357)', () => {
  it('writes a failed-step screenshot into the repair attempt context', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: BROWSER_EVIDENCE_REPAIR_WORKFLOW,
    });
    await seedRun(stores, BROWSER_EVIDENCE_REPAIR_WORKFLOW.id);
    const screenshotBytes = Buffer.from('failed-step-screenshot');
    const screenshot = await stores.artifacts.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1-open-root',
        contentType: 'image/png',
        createdBy: 'browser-verification',
        maxBytes: 1_000_000,
        runId: 'run-1',
      },
      Readable.from(screenshotBytes),
    );
    await stores.artifacts.put({
      projectId: 'project-1',
      name: 'browser-verification.report',
      createdBy: 'browser-verification',
      runId: 'run-1',
      content: {
        schemaVersion: '1',
        approved: false,
        summary: 'The first browser step failed.',
        planArtifact: { name: 'browser-test.plan', revision: 1, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          url: 'http://127.0.0.1:4000/',
          evidence: {
            screenshots: [
              {
                name: screenshot.name,
                revision: screenshot.revision,
                sha256: screenshot.sha256,
                stepId: 'open-root',
                url: 'http://127.0.0.1:4000/',
                viewport: { width: 1280, height: 720 },
              },
            ],
          },
        },
        steps: [
          {
            stepId: 'open-root',
            title: 'Open root',
            status: 'failed',
            durationMs: 1,
            observations: [],
            error: 'Expected dashboard, received sign-in.',
          },
        ],
      },
    });

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect(stores.workspaces.lastRunInputFiles).toEqual([
      { path: 'browser-evidence/open-root.png', content: screenshotBytes },
    ]);
    expect(stores.workspaces.lastRequestMarkdown).toContain(
      'inputs/browser-evidence/open-root.png',
    );
  });

  /**
   * `materializeBrowserEvidence` is private; these three cases call it
   * directly (bypassing `runProject`) so a judge-only gate (#477) doesn't
   * need a full workflow run to exercise. The `it` above stays as an
   * end-to-end check that the files really reach the repair attempt.
   */
  interface HasMaterializeBrowserEvidence {
    materializeBrowserEvidence(
      projectId: string,
      inputArtifacts: StoredArtifact[],
    ): Promise<{
      inputFiles: Array<{ path: string; content: Uint8Array }>;
      browserEvidenceStepIds: string[];
    }>;
  }
  function materializeBrowserEvidence(
    stores: ReturnType<typeof makeOrchestrator>,
    projectId: string,
    inputArtifacts: StoredArtifact[],
  ) {
    return (
      stores.orchestrator as unknown as HasMaterializeBrowserEvidence
    ).materializeBrowserEvidence(projectId, inputArtifacts);
  }

  it('includes screenshots the UI-quality judge reviewed, even when every step passed (#477)', async () => {
    const stores = makeOrchestrator();
    const screenshotA = await stores.artifacts.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1-open-root',
        contentType: 'image/png',
        createdBy: 'browser-verification',
        maxBytes: 1_000_000,
        runId: 'run-1',
      },
      Readable.from(Buffer.from('open-root-screenshot')),
    );
    const screenshotB = await stores.artifacts.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1-second-step',
        contentType: 'image/png',
        createdBy: 'browser-verification',
        maxBytes: 1_000_000,
        runId: 'run-1',
      },
      Readable.from(Buffer.from('second-step-screenshot')),
    );
    const report = await stores.artifacts.put({
      projectId: 'project-1',
      name: 'browser-verification.report',
      createdBy: 'browser-verification',
      runId: 'run-1',
      content: {
        schemaVersion: '1',
        // Task 2's gateOnUiQuality flips this false even though every
        // functional step below passed — the judge's score gated it.
        approved: false,
        summary: 'UI-quality gate failed: overall score 0.40 is below the configured minimum 0.70.',
        planArtifact: { name: 'browser-test.plan', revision: 1, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          url: 'http://127.0.0.1:4000/',
          evidence: {
            screenshots: [
              {
                name: screenshotA.name,
                revision: screenshotA.revision,
                sha256: screenshotA.sha256,
                stepId: 'open-root',
                url: 'http://127.0.0.1:4000/',
                viewport: { width: 1280, height: 720 },
              },
              {
                name: screenshotB.name,
                revision: screenshotB.revision,
                sha256: screenshotB.sha256,
                stepId: 'second-step',
                url: 'http://127.0.0.1:4000/second',
                viewport: { width: 1280, height: 720 },
              },
            ],
          },
        },
        steps: [
          {
            stepId: 'open-root',
            title: 'Open root',
            status: 'passed',
            durationMs: 1,
            observations: [],
          },
          {
            stepId: 'second-step',
            title: 'Second step',
            status: 'passed',
            durationMs: 1,
            observations: [],
          },
        ],
        uiQuality: {
          rubricVersion: '1',
          judgeModel: 'claude-test',
          overallScore: 0.4,
          criteria: [{ criterionId: 'layout', score: 0.4, finding: 'Cramped spacing.' }],
          screenshotsReviewed: [
            { name: screenshotA.name, revision: screenshotA.revision, sha256: screenshotA.sha256 },
            { name: screenshotB.name, revision: screenshotB.revision, sha256: screenshotB.sha256 },
          ],
        },
      },
    });

    const result = await materializeBrowserEvidence(stores, 'project-1', [report]);

    expect(result.inputFiles.map((file) => file.path).sort()).toEqual([
      'browser-evidence/open-root.png',
      'browser-evidence/second-step.png',
    ]);
    expect(result.browserEvidenceStepIds.sort()).toEqual(['open-root', 'second-step']);
  });

  it("keeps returning exactly the failed step's screenshot when uiQuality is absent (regression guard)", async () => {
    const stores = makeOrchestrator();
    const failedShot = await stores.artifacts.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1-open-root',
        contentType: 'image/png',
        createdBy: 'browser-verification',
        maxBytes: 1_000_000,
        runId: 'run-1',
      },
      Readable.from(Buffer.from('open-root-screenshot')),
    );
    const passedShot = await stores.artifacts.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1-second-step',
        contentType: 'image/png',
        createdBy: 'browser-verification',
        maxBytes: 1_000_000,
        runId: 'run-1',
      },
      Readable.from(Buffer.from('second-step-screenshot')),
    );
    const report = await stores.artifacts.put({
      projectId: 'project-1',
      name: 'browser-verification.report',
      createdBy: 'browser-verification',
      runId: 'run-1',
      content: {
        schemaVersion: '1',
        approved: false,
        summary: 'The first browser step failed.',
        planArtifact: { name: 'browser-test.plan', revision: 1, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          url: 'http://127.0.0.1:4000/',
          evidence: {
            screenshots: [
              {
                name: failedShot.name,
                revision: failedShot.revision,
                sha256: failedShot.sha256,
                stepId: 'open-root',
                url: 'http://127.0.0.1:4000/',
                viewport: { width: 1280, height: 720 },
              },
              {
                name: passedShot.name,
                revision: passedShot.revision,
                sha256: passedShot.sha256,
                stepId: 'second-step',
                url: 'http://127.0.0.1:4000/second',
                viewport: { width: 1280, height: 720 },
              },
            ],
          },
        },
        steps: [
          {
            stepId: 'open-root',
            title: 'Open root',
            status: 'failed',
            durationMs: 1,
            observations: [],
            error: 'Expected dashboard, received sign-in.',
          },
          {
            stepId: 'second-step',
            title: 'Second step',
            status: 'passed',
            durationMs: 1,
            observations: [],
          },
        ],
      },
    });

    const result = await materializeBrowserEvidence(stores, 'project-1', [report]);

    expect(result.inputFiles).toEqual([
      { path: 'browser-evidence/open-root.png', content: Buffer.from('open-root-screenshot') },
    ]);
    expect(result.browserEvidenceStepIds).toEqual(['open-root']);
  });

  it('writes a screenshot once when it is both a failed step and judge-reviewed (dedup)', async () => {
    const stores = makeOrchestrator();
    const shot = await stores.artifacts.putBlob(
      {
        projectId: 'project-1',
        name: 'browser-screenshot-preview-1-open-root',
        contentType: 'image/png',
        createdBy: 'browser-verification',
        maxBytes: 1_000_000,
        runId: 'run-1',
      },
      Readable.from(Buffer.from('open-root-screenshot')),
    );
    const report = await stores.artifacts.put({
      projectId: 'project-1',
      name: 'browser-verification.report',
      createdBy: 'browser-verification',
      runId: 'run-1',
      content: {
        schemaVersion: '1',
        approved: false,
        summary: 'The first browser step failed and scored poorly.',
        planArtifact: { name: 'browser-test.plan', revision: 1, sha256: 'a'.repeat(64) },
        previewSession: {
          sessionId: 'preview-1',
          status: 'running',
          url: 'http://127.0.0.1:4000/',
          evidence: {
            screenshots: [
              {
                name: shot.name,
                revision: shot.revision,
                sha256: shot.sha256,
                stepId: 'open-root',
                url: 'http://127.0.0.1:4000/',
                viewport: { width: 1280, height: 720 },
              },
            ],
          },
        },
        steps: [
          {
            stepId: 'open-root',
            title: 'Open root',
            status: 'failed',
            durationMs: 1,
            observations: [],
            error: 'Expected dashboard, received sign-in.',
          },
        ],
        uiQuality: {
          rubricVersion: '1',
          judgeModel: 'claude-test',
          overallScore: 0.2,
          criteria: [{ criterionId: 'layout', score: 0.2 }],
          screenshotsReviewed: [{ name: shot.name, revision: shot.revision, sha256: shot.sha256 }],
        },
      },
    });

    const result = await materializeBrowserEvidence(stores, 'project-1', [report]);

    expect(result.inputFiles).toEqual([
      { path: 'browser-evidence/open-root.png', content: Buffer.from('open-root-screenshot') },
    ]);
    expect(result.browserEvidenceStepIds).toEqual(['open-root']);
  });
});

const TASK_GRAPH_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'task-graph-v1',
  name: 'Task graph fixture',
  description: 'A single planning step constrained to emit a task graph.',
  stack: 'node',
  nodes: [
    {
      id: 'plan',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan',
      instructions: 'Plan the work.',
      outputArtifact: 'plan.current',
      outputContract: 'task-graph',
      maxAttempts: 1,
    },
  ],
});

const VALID_GRAPH = {
  schemaVersion: '1',
  goal: 'Ship it',
  tasks: [
    {
      id: 'T1',
      title: 'Do the thing',
      dependsOn: [],
      deliverables: ['src/index.ts'],
      acceptanceCheck: 'The thing works',
    },
  ],
};

const GENERATED_GRAPH = {
  ...VALID_GRAPH,
  modules: [{ id: 'crud:work', acceptanceChannel: 'deterministic-only' as const }],
  tasks: VALID_GRAPH.tasks.map((task) => ({
    ...task,
    acceptanceMode: 'deterministic-only' as const,
    module: 'crud:work',
  })),
};

const BROWSER_GRAPH = {
  ...VALID_GRAPH,
  modules: [{ id: 'crud:work', acceptanceChannel: 'browser-visible' as const }],
  tasks: VALID_GRAPH.tasks.map((task) => ({
    ...task,
    acceptanceMode: 'browser-visible' as const,
    module: 'crud:work',
  })),
};

const TASK_BROWSER_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'task-browser-retry-v1',
  name: 'Task browser retry fixture',
  description: 'Keeps a verified implementation when browser setup fails.',
  stack: 'node',
  nodes: [
    {
      id: 'plan',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan',
      instructions: 'Plan one task.',
      outputArtifact: 'plan.current',
      outputContract: 'task-graph',
    },
    {
      id: 'task-execution',
      type: 'for-each-task',
      title: 'Implement tasks',
      taskGraphArtifact: 'plan.current',
      implement: {
        id: 'implement',
        type: 'agent',
        role: 'developer',
        taskKind: 'implementation',
        title: 'Implement task',
        instructions: 'Implement the task.',
        inputArtifacts: ['plan.current'],
        outputArtifact: 'implementation.report',
        mutatesWorkspace: true,
      },
      verify: {
        id: 'verify-task',
        type: 'verify',
        title: 'Verify task',
        outputArtifact: 'verification.report',
        scripts: [],
      },
      repair: {
        id: 'repair-task',
        type: 'agent',
        role: 'fixer',
        taskKind: 'repair',
        title: 'Repair task',
        instructions: 'Repair the task.',
        inputArtifacts: ['verification.report'],
        outputArtifact: 'verification.fix',
        mutatesWorkspace: true,
      },
      browser: {
        plan: {
          id: 'plan-task-browser-test',
          type: 'agent',
          role: 'tester',
          taskKind: 'verification',
          title: 'Plan browser test',
          instructions: 'Plan the browser test.',
          inputArtifacts: ['plan.current'],
          outputArtifact: 'browser-test.plan',
        },
        check: {
          id: 'assert-task',
          type: 'verify',
          title: 'Assert task',
          outputArtifact: 'browser-verification.report',
          browserTestPlanArtifact: 'browser-test.plan',
          scripts: [],
          includeGitDiffCheck: false,
        },
      },
    },
  ],
});

const VALID_BROWSER_PLAN: AgentArtifact = {
  schemaVersion: '1',
  status: 'completed',
  summary: 'Open the task page.',
  data: {
    schemaVersion: '1',
    id: 'open-task',
    title: 'Open task',
    viewport: { width: 1280, height: 720 },
    steps: [
      {
        id: 'open-task',
        title: 'Open task',
        action: { kind: 'goto', path: '/' },
        assertions: [{ kind: 'url', path: '/' }],
      },
    ],
  },
  decisions: [],
  assumptions: [],
  risks: [],
  nextActions: [],
};

describe('task-graph output contract (#321)', () => {
  it('requests the task-graph JSON schema and stores a conforming plan', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: TASK_GRAPH_WORKFLOW,
      output: () => ({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned.',
        data: GENERATED_GRAPH,
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      }),
    });
    await seedRun(stores, TASK_GRAPH_WORKFLOW.id);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    expect(stores.executor.requests[0]?.outputSchema?.$id).toBe(
      TASK_GRAPH_ARTIFACT_JSON_SCHEMA.$id,
    );
    const artifact = await stores.artifacts.getLatest('project-1', 'plan.current');
    expect(artifact?.content).toMatchObject({ data: { tasks: [{ id: 'T1' }] } });
  });

  it('consumes one attempt on a non-conforming output and recovers on the fallback candidate', async () => {
    let calls = 0;
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: TASK_GRAPH_WORKFLOW,
      routeFallback: true,
      output: () => ({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned.',
        // First attempt: prose. Second attempt: a conforming graph.
        data: ++calls === 1 ? { note: 'prose' } : GENERATED_GRAPH,
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      }),
    });
    await seedRun(stores, TASK_GRAPH_WORKFLOW.id);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    const stepRun = (await stores.stepRuns.list('run-1')).find((step) => step.stepId === 'plan');
    if (!stepRun) throw new Error('Expected a persisted plan step');
    const attempts = await stores.stepAttempts.list('run-1', stepRun.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded']);
    const artifact = await stores.artifacts.getLatest('project-1', 'plan.current');
    expect(artifact?.metadata.revision).toBe(1);
    expect(artifact?.content).toMatchObject({ data: { tasks: [{ id: 'T1' }] } });
  });

  it('fails the step instead of passing prose through as plan.current', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: TASK_GRAPH_WORKFLOW,
      // Default ControllableExecutor output: data is {}. Prose, not a graph.
    });
    await seedRun(stores, TASK_GRAPH_WORKFLOW.id);

    await expect(stores.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /must emit a task graph/,
    );
    expect((await stores.runs.get('run-1'))?.status).toBe('failed');
    expect(await stores.artifacts.getLatest('project-1', 'plan.current')).toBeNull();
  });
});

const SCHEMA_PLAN_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'schema-plan-v1',
  name: 'Schema plan fixture',
  description: 'A single planning step constrained to emit a schema plan.',
  stack: 'node',
  nodes: [
    {
      id: 'plan-schema',
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: 'Plan schema',
      instructions: 'Plan the data model.',
      outputArtifact: 'schema.current',
      outputContract: 'schema-plan',
      maxAttempts: 1,
    },
  ],
});

const VALID_SCHEMA_PLAN = {
  schemaVersion: '1',
  tables: [
    {
      name: 'items',
      columns: [{ name: 'id', type: 'uuid', nullable: false }],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
      },
    },
  ],
};

describe('schema-plan output contract (#480)', () => {
  it('requests the schema-plan JSON schema and stores a conforming plan', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: SCHEMA_PLAN_WORKFLOW,
      output: () => ({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned the schema.',
        data: VALID_SCHEMA_PLAN,
        decisions: [],
        assumptions: [],
        risks: [],
        nextActions: [],
      }),
    });
    await seedRun(stores, SCHEMA_PLAN_WORKFLOW.id);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    expect(stores.executor.requests[0]?.outputSchema?.$id).toBe(
      SCHEMA_PLAN_ARTIFACT_JSON_SCHEMA.$id,
    );
    const artifact = await stores.artifacts.getLatest('project-1', 'schema.current');
    expect(artifact?.content).toMatchObject({ data: { tables: [{ name: 'items' }] } });
  });

  it('fails the step instead of passing prose through as schema.current', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: SCHEMA_PLAN_WORKFLOW,
      // Default ControllableExecutor output: data is {}. Prose, not a schema plan.
    });
    await seedRun(stores, SCHEMA_PLAN_WORKFLOW.id);

    await expect(stores.orchestrator.runProject('project-1', undefined, 'run-1')).rejects.toThrow(
      /must emit a schema plan/,
    );
    expect((await stores.runs.get('run-1'))?.status).toBe('failed');
    expect(await stores.artifacts.getLatest('project-1', 'schema.current')).toBeNull();
  });
});

describe('structured-output repair observability (#563)', () => {
  /** Single-step fixture, so "exactly one repair event" is unambiguous. */
  const workflow = WORKTREE_PLUMBING_WORKFLOW;

  it('emits one agent.output_repaired event naming the repair, alongside agent.completed', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, { workflow });
    stores.executor.outputRepairs = ['schema-version-defaulted'];
    await seedRun(stores, workflow.id);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    const repaired = stores.events.events.filter((event) => event.type === 'agent.output_repaired');
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.message).toContain('schema-version-defaulted');
    expect(repaired[0]?.nodeId).toBe('implement');
    expect(repaired[0]?.data).toMatchObject({ repairs: ['schema-version-defaulted'] });
    expect(stores.events.events.some((event) => event.type === 'agent.completed')).toBe(true);
  });

  it('emits no agent.output_repaired event when the executor repaired nothing', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, { workflow });
    await seedRun(stores, workflow.id);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await stores.runs.get('run-1'))?.status).toBe('completed');
    expect(stores.events.events.some((event) => event.type === 'agent.output_repaired')).toBe(
      false,
    );
  });

  it('records the output-validation evidence in the successful attempt run record', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, { workflow });
    stores.executor.outputRepairs = ['schema-version-defaulted'];
    await seedRun(stores, workflow.id);

    await stores.orchestrator.runProject('project-1', undefined, 'run-1');

    const [stepRun] = await stores.stepRuns.list('run-1');
    if (!stepRun) throw new Error('Expected a persisted step run');
    const [attempt] = await stores.stepAttempts.list('run-1', stepRun.id);
    if (!attempt) throw new Error('Expected a persisted attempt');
    const [record] = stores.artifacts.named(`run-${attempt.id}`);
    expect(record?.content).toMatchObject({
      outputValidation: {
        contract: 'agent-artifact',
        repairs: ['schema-version-defaulted'],
      },
    });
  });
});

/** now() advances every call, so two steps in one run always land on distinct
 * migration timestamps — a real clock ticking within one test run cannot. */
class IncrementingClock implements Clock {
  private current: number;
  constructor(start: Date) {
    this.current = start.getTime();
  }
  now(): Date {
    const value = new Date(this.current);
    this.current += 1500;
    return value;
  }
}

/** Stuck on one instant, to force two steps into the same migration filename
 * — reproduces two schema-plan steps landing in the same clock second. */
class FrozenClock implements Clock {
  constructor(private readonly instant: Date) {}
  now(): Date {
    return this.instant;
  }
}

/** The planning step is read-only, exactly like web-app-v1's `schema` node:
 * the orchestrator, not the agent, writes and commits the migration, and only
 * once the operator has approved the plan. */
function schemaPlanNodes(suffix: string, extra: Record<string, unknown> = {}) {
  return [
    {
      id: `plan-schema${suffix}`,
      type: 'agent',
      role: 'planner',
      taskKind: 'planning',
      title: `Plan schema${suffix}`,
      instructions: 'Plan the data model.',
      outputArtifact: `schema.current${suffix}`,
      outputContract: 'schema-plan',
      mutatesWorkspace: false,
      maxAttempts: 1,
      ...extra,
    },
    {
      id: `schema-approval${suffix}`,
      type: 'approval-gate',
      title: `Operator schema approval${suffix}`,
      artifact: `schema.current${suffix}`,
      outputArtifact: `schema.approval${suffix}`,
      actions: ['approve', 'reject'],
      onReject: 'end',
    },
  ];
}

const SCHEMA_PLAN_GATED_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'schema-plan-migration-v1',
  name: 'Schema plan migration fixture',
  description: 'One read-only schema-plan step behind an operator approval gate.',
  stack: 'node',
  nodes: schemaPlanNodes(''),
});

const SCHEMA_PLAN_TWO_GATE_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'schema-plan-migration-repeat-v1',
  name: 'Schema plan migration repeat fixture',
  description: 'Two read-only schema-plan steps, each behind its own approval gate.',
  stack: 'node',
  nodes: [
    ...schemaPlanNodes('-1'),
    ...schemaPlanNodes('-2', { inputArtifacts: ['schema.current-1'] }),
  ],
});

/** Runs the project, approving every gate it parks at, until it terminates. */
async function runApprovingGates(
  harness: ReturnType<typeof makeHarness>,
  runId = 'run-1',
): Promise<void> {
  await harness.orchestrator.runProject('project-1', undefined, runId);
  for (;;) {
    const pending = (await harness.service.listApprovals(runId)).find((entry) => !entry.decision);
    if (!pending) return;
    await harness.service.decideApproval(runId, pending.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    await harness.orchestrator.runProject('project-1', undefined, runId);
  }
}

const REVISED_SCHEMA_PLAN = {
  schemaVersion: '1',
  tables: [
    {
      name: 'items',
      columns: [
        { name: 'id', type: 'uuid', nullable: false },
        { name: 'title', type: 'text', nullable: false },
      ],
      constraints: [{ type: 'primary-key', columns: ['id'] }],
      indexes: [],
      rls: {
        enabled: true,
        policies: [{ name: 'authenticated_all', command: 'all', using: 'true' }],
      },
    },
  ],
};

function schemaPlanOutput(data: unknown): AgentExecutionResult['output'] {
  return {
    schemaVersion: '1',
    status: 'completed',
    summary: 'Planned the schema.',
    data,
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  };
}

describe('schema-plan migration write (#481)', () => {
  async function migrationNames(workspace: string): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    return (await readdir(join(workspace, 'supabase', 'migrations')))
      .filter((name) => name.endsWith('_schema_plan.sql'))
      .sort();
  }

  it('writes and commits the migration only once the operator approves the plan', async () => {
    const { mkdtemp, access, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workspace = await mkdtemp(join(tmpdir(), 'wf-481-schema-plan-'));

    const harness = makeHarness({}, undefined, {
      workflow: SCHEMA_PLAN_GATED_WORKFLOW,
      agentOutput: () => schemaPlanOutput(VALID_SCHEMA_PLAN),
    });
    harness.workspaces.workspacePath = () => workspace;
    const commit = vi.spyOn(harness.workspaces, 'commit');
    await seedHarnessRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    // Parked on the gate: the planning step is read-only, so nothing may exist
    // on disk yet — not even the directory.
    expect((await harness.runs.get('run-1'))?.status).toBe('awaiting_approval');
    await expect(access(join(workspace, 'supabase', 'migrations'))).rejects.toThrow();

    const [pending] = await harness.service.listApprovals('run-1');
    await harness.service.decideApproval('run-1', pending!.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    const files = await migrationNames(workspace);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_schema_plan\.sql$/);
    const content = await readFile(join(workspace, 'supabase', 'migrations', files[0]!), 'utf8');
    expect(content).toContain('create table if not exists public.items');
    expect(content).toContain('alter table public.items enable row level security;');
    // The orchestrator owns the commit, since no mutating step does.
    expect(commit).toHaveBeenCalledWith('project-1', expect.stringContaining(files[0]!));
  });

  it('writes nothing when the operator rejects the schema plan', async () => {
    const { mkdtemp, access } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workspace = await mkdtemp(join(tmpdir(), 'wf-481-schema-plan-rejected-'));

    const harness = makeHarness({}, undefined, {
      workflow: SCHEMA_PLAN_GATED_WORKFLOW,
      agentOutput: () => schemaPlanOutput(VALID_SCHEMA_PLAN),
    });
    harness.workspaces.workspacePath = () => workspace;
    await seedHarnessRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');
    const [pending] = await harness.service.listApprovals('run-1');
    await harness.service.decideApproval('run-1', pending!.request.id, {
      action: 'reject',
      decidedBy: 'ed',
      note: 'wrong data model',
    });
    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('rejected');
    // Rejected DDL must not survive in the workspace: a later run would apply
    // it, and verifySchema tolerates extra tables by design.
    await expect(access(join(workspace, 'supabase', 'migrations'))).rejects.toThrow();
  });

  it('writes no second file when a repeated schema-plan step emits identical SQL', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workspace = await mkdtemp(join(tmpdir(), 'wf-481-schema-plan-repeat-'));

    const stores = makeStores(new IncrementingClock(new Date('2026-08-12T00:00:00.000Z')));
    const harness = makeHarness({}, stores, {
      workflow: SCHEMA_PLAN_TWO_GATE_WORKFLOW,
      agentOutput: () => schemaPlanOutput(VALID_SCHEMA_PLAN),
    });
    harness.workspaces.workspacePath = () => workspace;
    await seedHarnessRun(harness);

    await runApprovingGates(harness);

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    expect(await migrationNames(workspace)).toHaveLength(1);
  });

  it('writes a second file and leaves the first untouched when the schema plan changes', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workspace = await mkdtemp(join(tmpdir(), 'wf-481-schema-plan-change-'));

    const stores = makeStores(new IncrementingClock(new Date('2026-08-12T00:00:00.000Z')));
    const harness = makeHarness({}, stores, {
      workflow: SCHEMA_PLAN_TWO_GATE_WORKFLOW,
      agentOutput: (request) =>
        schemaPlanOutput(
          request.stepId === 'plan-schema-2' ? REVISED_SCHEMA_PLAN : VALID_SCHEMA_PLAN,
        ),
    });
    harness.workspaces.workspacePath = () => workspace;
    await seedHarnessRun(harness);

    await runApprovingGates(harness);

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    const migrationsDir = join(workspace, 'supabase', 'migrations');
    const files = await migrationNames(workspace);
    expect(files).toHaveLength(2);
    const firstContent = await readFile(join(migrationsDir, files[0]!), 'utf8');
    const secondContent = await readFile(join(migrationsDir, files[1]!), 'utf8');
    expect(firstContent).not.toBe(secondContent);
    expect(firstContent).toContain('create table if not exists public.items ( id uuid not null,');
    expect(secondContent).toContain('title text not null');
  });

  it('fails loudly instead of clobbering a prior migration on a same-second timestamp collision', async () => {
    const { mkdtemp, readFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workspace = await mkdtemp(join(tmpdir(), 'wf-481-schema-plan-collision-'));

    const stores = makeStores(new FrozenClock(new Date('2026-08-12T00:00:00.000Z')));
    const harness = makeHarness({}, stores, {
      workflow: SCHEMA_PLAN_TWO_GATE_WORKFLOW,
      agentOutput: (request) =>
        schemaPlanOutput(
          request.stepId === 'plan-schema-2' ? REVISED_SCHEMA_PLAN : VALID_SCHEMA_PLAN,
        ),
    });
    harness.workspaces.workspacePath = () => workspace;
    await seedHarnessRun(harness);

    await expect(runApprovingGates(harness)).rejects.toThrow(
      /already exists with different content/,
    );

    const files = await migrationNames(workspace);
    expect(files).toHaveLength(1);
    const content = await readFile(join(workspace, 'supabase', 'migrations', files[0]!), 'utf8');
    expect(content).toContain('create table if not exists public.items ( id uuid not null,');
    expect(content).not.toContain('title text not null');
  });
});

const SYSTEM_PROMPT_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  schemaVersion: '1',
  id: 'system-prompt-wiring-v1',
  name: 'System prompt wiring fixture',
  description: 'A developer step (has a system-prompt template) then a fixer step (does not).',
  stack: 'node',
  nodes: [
    {
      id: 'implement',
      type: 'agent',
      role: 'developer',
      taskKind: 'implementation',
      title: 'Implement',
      instructions: 'Implement the plan.',
      outputArtifact: 'implementation',
    },
    {
      id: 'repair',
      type: 'agent',
      role: 'fixer',
      taskKind: 'repair',
      title: 'Repair',
      instructions: 'Repair the failure.',
      inputArtifacts: ['implementation'],
      outputArtifact: 'implementation.fix',
    },
  ],
});

describe('per-role system-prompt wiring (#483)', () => {
  it('sets systemPrompt for a role with a template, and leaves it unset for a role without one', async () => {
    const systemPrompts: SystemPromptRepository = {
      select: async (role) =>
        role === 'developer'
          ? { version: 'system-prompts-1', content: '# System prompt: Developer' }
          : undefined,
      version: async () => 'system-prompts-1',
    };
    const harness = makeHarness({}, undefined, {
      workflow: SYSTEM_PROMPT_WORKFLOW,
      systemPrompts,
    });
    await seedHarnessRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    const developerRequest = harness.executor.requests.find((req) => req.stepId === 'implement');
    const fixerRequest = harness.executor.requests.find((req) => req.stepId === 'repair');
    expect(developerRequest?.systemPrompt).toBe('# System prompt: Developer');
    expect(fixerRequest?.systemPrompt).toBeUndefined();
  });

  it('leaves systemPrompt unset for every step when no SystemPromptRepository is injected', async () => {
    const harness = makeHarness({}, undefined, { workflow: SYSTEM_PROMPT_WORKFLOW });
    await seedHarnessRun(harness);

    await harness.orchestrator.runProject('project-1', undefined, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    expect(harness.executor.requests.every((req) => req.systemPrompt === undefined)).toBe(true);
  });
});

describe('generated database sync before browser verification (#429)', () => {
  it('applies pending workspace migrations to the project runtime before the browser walks the app', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workspace = await mkdtemp(join(tmpdir(), 'wf-429-migrations-'));
    await mkdir(join(workspace, 'supabase', 'migrations'), { recursive: true });
    await writeFile(
      join(workspace, 'supabase', 'migrations', '0001_create_todos.sql'),
      'create table todos ();',
    );

    const applyWorkspaceMigrations = vi.fn(async () => ({}) as never);
    const verify = vi.fn(
      async (
        input: { plan: { metadata: { name: string; revision: number; sha256: string } } },
        _signal: AbortSignal,
        onSessionStarted?: (sessionId: string) => Promise<void>,
      ) => {
        await onSessionStarted?.('preview-429');
        return {
          schemaVersion: '1' as const,
          approved: true,
          summary: 'browser approved',
          planArtifact: {
            name: input.plan.metadata.name,
            revision: input.plan.metadata.revision,
            sha256: input.plan.metadata.sha256,
          },
          previewSession: {
            sessionId: 'preview-429',
            status: 'running' as const,
            evidence: { screenshots: [] },
          },
          steps: [
            {
              stepId: 'open-task',
              title: 'Open task',
              status: 'passed' as const,
              durationMs: 5,
              observations: [],
            },
          ],
        };
      },
    );
    const harness = makeHarness({}, undefined, {
      workflow: TASK_BROWSER_WORKFLOW,
      browserVerification: { verify } as never,
      generatedProjectRuntime: {
        applyWorkspaceMigrations,
        initialize: vi.fn(async () => ({}) as never),
        health: vi.fn(async () => ({ health: { state: 'healthy' } }) as never),
      } as never,
      agentOutput: (request) => {
        if (request.stepId === 'plan') {
          return {
            schemaVersion: '1',
            status: 'completed',
            summary: 'Planned.',
            data: BROWSER_GRAPH,
            decisions: [],
            assumptions: [],
            risks: [],
            nextActions: [],
          };
        }
        if (request.stepId === 'plan-task-browser-test.T1') return VALID_BROWSER_PLAN;
        return undefined;
      },
    });
    harness.workspaces.workspacePath = () => workspace;
    await seedHarnessRun(harness);

    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');

    // Addressed by the run's own environment, never the bare project (#617).
    expect(applyWorkspaceMigrations).toHaveBeenCalledWith({
      projectId: 'project-1',
      environmentId: 'run-1',
      workspaceMigrationsDir: join(workspace, 'supabase', 'migrations'),
    });
    expect(applyWorkspaceMigrations.mock.invocationCallOrder[0]!).toBeLessThan(
      verify.mock.invocationCallOrder[0]!,
    );
  });
});

/** Whatever else an environment operation takes, it takes an address. */
type EnvironmentAddress = { projectId: string; environmentId?: string };

describe('destructive-migration approval gate (#535)', () => {
  function browserVerifyFixture() {
    return vi.fn(
      async (
        input: { plan: { metadata: { name: string; revision: number; sha256: string } } },
        _signal: AbortSignal,
        onSessionStarted?: (sessionId: string) => Promise<void>,
      ) => {
        await onSessionStarted?.('preview-535');
        return {
          schemaVersion: '1' as const,
          approved: true,
          summary: 'browser approved',
          planArtifact: {
            name: input.plan.metadata.name,
            revision: input.plan.metadata.revision,
            sha256: input.plan.metadata.sha256,
          },
          previewSession: {
            sessionId: 'preview-535',
            status: 'running' as const,
            evidence: { screenshots: [] },
          },
          steps: [
            {
              stepId: 'open-task',
              title: 'Open task',
              status: 'passed' as const,
              durationMs: 5,
              observations: [],
            },
          ],
        };
      },
    );
  }

  function agentOutputFixture() {
    return (request: AgentExecutionRequest) => {
      if (request.stepId === 'plan') {
        return {
          schemaVersion: '1' as const,
          status: 'completed' as const,
          summary: 'Planned.',
          data: BROWSER_GRAPH,
          decisions: [],
          assumptions: [],
          risks: [],
          nextActions: [],
        };
      }
      if (request.stepId === 'plan-task-browser-test.T1') return VALID_BROWSER_PLAN;
      return undefined;
    };
  }

  async function destructiveHarness() {
    const { createHash } = await import('node:crypto');
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workspace = await mkdtemp(join(tmpdir(), 'wf-535-migrations-'));
    await mkdir(join(workspace, 'supabase', 'migrations'), { recursive: true });
    await writeFile(
      join(workspace, 'supabase', 'migrations', '0001_drop_obsolete.sql'),
      'DROP TABLE obsolete;',
    );
    const destructive = [
      {
        migrationPath: 'supabase/migrations/0001_drop_obsolete.sql',
        checksum: createHash('sha256').update('DROP TABLE obsolete;').digest('hex'),
        destructiveStatements: ['DROP TABLE obsolete'],
      },
    ];

    // applyWorkspaceMigrations copies pending files into the runtime's
    // private workdir before ever failing (packages/platform's real
    // behavior) — so a real destructive batch can never be applied by
    // calling applyWorkspaceMigrations a second time with the resolved
    // approval: nothing is "fresh" left to copy and it silently no-ops.
    // This mock throws unconditionally, the same way the real one always
    // fails on a first, unapproved call, so a fix that re-calls
    // applyWorkspaceMigrations instead of migrate() on retry is caught here.
    const applyWorkspaceMigrations = vi.fn(async (_input: EnvironmentAddress) => {
      throw new MigrationApprovalRequiredError(destructive);
    });
    const migrate = vi.fn(async (_input: EnvironmentAddress) => ({}) as never);
    const initialize = vi.fn(async (_input: { identity?: unknown }) => ({}) as never);
    const backupMigration = vi.fn(async (_input: EnvironmentAddress) => ({
      path: '.foundry/migration-backups/backup.sql',
      checksum: 'b'.repeat(64),
      schemaChecksum: 'c'.repeat(64),
      dataChecksum: 'd'.repeat(64),
      createdAt: '2026-08-13T00:00:00.000Z',
      manifestId: 'manifest-1',
    }));

    const harness = makeHarness({}, undefined, {
      workflow: TASK_BROWSER_WORKFLOW,
      browserVerification: { verify: browserVerifyFixture() } as never,
      generatedProjectRuntime: {
        applyWorkspaceMigrations,
        migrate,
        backupMigration,
        initialize,
        health: vi.fn(async () => ({ health: { state: 'healthy' } }) as never),
      } as never,
      agentOutput: agentOutputFixture(),
    });
    harness.workspaces.workspacePath = () => workspace;
    await seedHarnessRun(harness);
    return { harness, applyWorkspaceMigrations, migrate, backupMigration, initialize, destructive };
  }

  it('parks the run at an approval gate naming the file and statement instead of failing the run', async () => {
    const { harness, applyWorkspaceMigrations } = await destructiveHarness();

    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('awaiting_approval');
    expect(applyWorkspaceMigrations).toHaveBeenCalledTimes(1);
    const [pending] = await harness.service.listApprovals('run-1');
    expect(pending?.decision).toBeNull();
    expect(pending?.request.nodeId).toMatch(/\.migration-approval$/);
    const requested = harness.events.events.find(
      (event) => event.type === 'run.approval_requested',
    );
    expect(requested?.message).toContain('0001_drop_obsolete.sql');
    expect(requested?.message).toContain('DROP TABLE obsolete');
    expect(requested?.message).toMatch(/entire pending migration batch/);
  });

  it('applies the batch with a fresh backup once the operator approves, without re-copying already-staged files', async () => {
    const { harness, applyWorkspaceMigrations, migrate, backupMigration, destructive } =
      await destructiveHarness();

    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');
    const [pending] = await harness.service.listApprovals('run-1');
    await harness.service.decideApproval('run-1', pending!.request.id, {
      action: 'approve',
      decidedBy: 'ed',
    });
    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    expect(backupMigration).toHaveBeenCalledTimes(1);
    expect(backupMigration).toHaveBeenCalledWith({
      projectId: 'project-1',
      environmentId: 'run-1',
      backupPath: expect.stringContaining('.foundry/migration-backups/'),
    });
    // Once per run attempt (park, then replay) — applyWorkspaceMigrations is
    // never retried with the resolved approval attached: that retry would
    // find the destructive file already staged from the first (failed)
    // attempt and silently no-op instead of applying it. Applying happens
    // by calling migrate() directly with the approval instead.
    expect(applyWorkspaceMigrations).toHaveBeenCalledTimes(2);
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate).toHaveBeenCalledWith({
      projectId: 'project-1',
      environmentId: 'run-1',
      migrationPath: destructive[0]!.migrationPath,
      approval: {
        migrationChecksum: destructive[0]!.checksum,
        backup: {
          path: '.foundry/migration-backups/backup.sql',
          checksum: 'b'.repeat(64),
          schemaChecksum: 'c'.repeat(64),
          dataChecksum: 'd'.repeat(64),
          createdAt: '2026-08-13T00:00:00.000Z',
          manifestId: 'manifest-1',
        },
      },
    });
  });

  it('ends the run rejected, with no migration applied, when the operator rejects', async () => {
    const { harness, applyWorkspaceMigrations, migrate, backupMigration } =
      await destructiveHarness();

    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');
    const [pending] = await harness.service.listApprovals('run-1');
    await harness.service.decideApproval('run-1', pending!.request.id, {
      action: 'reject',
      decidedBy: 'ed',
      note: 'not safe to drop obsolete yet',
    });
    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('rejected');
    expect(backupMigration).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
    // Once when first detected, once on replay after the decision — both
    // times through applyWorkspaceMigrations, since resolveMigrationApproval
    // throws ApprovalRejectedError before ever reaching migrate().
    expect(applyWorkspaceMigrations).toHaveBeenCalledTimes(2);
    const rejected = harness.events.events.find((event) => event.type === 'run.rejected');
    expect(rejected?.message).toContain('not safe to drop obsolete yet');
  });

  /**
   * The caller matrix the #617 contract asks for, stated as an invariant
   * rather than a list: whatever the run asks of the generated runtime, it
   * asks of its own environment. A new caller added later without an
   * environment fails here even though no assertion names it.
   */
  it('leaves no generated-runtime call addressed by the bare project (#617)', async () => {
    const { harness, applyWorkspaceMigrations, migrate, backupMigration, initialize } =
      await destructiveHarness();

    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');
    const [pending] = await harness.service.listApprovals('run-1');
    await harness.service.decideApproval('run-1', pending!.request.id, {
      action: 'approve',
      decidedBy: 'ed',
      note: 'obsolete is unused',
    });
    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');

    // initialize names the environment through the identity it creates;
    // every later operation addresses that same environment by id.
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize.mock.calls[0]![0]).toMatchObject({
      identity: { class: 'candidate', environmentId: 'run-1', runCandidateId: 'run-1' },
    });
    const addressed: EnvironmentAddress[] = [
      ...applyWorkspaceMigrations.mock.calls,
      ...migrate.mock.calls,
      ...backupMigration.mock.calls,
    ].map(([input]) => input);
    expect(addressed.length).toBeGreaterThan(0);
    for (const input of addressed) {
      expect(input.projectId).toBe('project-1');
      expect(input.environmentId).toBe('run-1');
    }
  });
});

/** TASK_BROWSER_WORKFLOW plus the blocking full-suite gate web-app-v1 ends on. */
const DETERMINISTIC_FULL_SUITE_WORKFLOW: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  ...TASK_BROWSER_WORKFLOW,
  id: 'task-deterministic-full-suite-v1',
  nodes: [
    ...TASK_BROWSER_WORKFLOW.nodes,
    {
      id: 'full-suite-verification',
      type: 'verify',
      title: 'Run the full repository verification suite',
      outputArtifact: 'verification.report',
      scripts: [],
      blocksOnFailure: true,
    },
  ],
});

describe('schema drift verification before browser check (#481)', () => {
  function schemaPlanArtifactContent(plan: unknown) {
    return {
      schemaVersion: '1' as const,
      status: 'completed' as const,
      summary: 'Planned the schema.',
      data: plan,
      decisions: [],
      assumptions: [],
      risks: [],
      nextActions: [],
    };
  }

  async function harnessWithBrowserWorkflow(
    verifySchema: ReturnType<typeof vi.fn>,
    workflow: WorkflowDefinition = TASK_BROWSER_WORKFLOW,
    graph: unknown = BROWSER_GRAPH,
  ) {
    const harness = makeHarness({}, undefined, {
      workflow,
      browserVerification: {
        verify: async (
          input: { plan: { metadata: { name: string; revision: number; sha256: string } } },
          _signal: AbortSignal,
          onSessionStarted?: (sessionId: string) => Promise<void>,
        ) => {
          await onSessionStarted?.('preview-481');
          return {
            schemaVersion: '1' as const,
            approved: true,
            summary: 'browser approved',
            planArtifact: {
              name: input.plan.metadata.name,
              revision: input.plan.metadata.revision,
              sha256: input.plan.metadata.sha256,
            },
            previewSession: {
              sessionId: 'preview-481',
              status: 'running' as const,
              evidence: { screenshots: [] },
            },
            steps: [
              {
                stepId: 'open-task',
                title: 'Open task',
                status: 'passed' as const,
                durationMs: 5,
                observations: [],
              },
            ],
          };
        },
      } as never,
      generatedProjectRuntime: {
        applyWorkspaceMigrations: vi.fn(async () => ({}) as never),
        verifySchema,
        initialize: vi.fn(async () => ({}) as never),
        health: vi.fn(async () => ({ health: { state: 'healthy' } }) as never),
      } as never,
      agentOutput: (request) => {
        if (request.stepId === 'plan') {
          return {
            schemaVersion: '1',
            status: 'completed',
            summary: 'Planned.',
            data: graph,
            decisions: [],
            assumptions: [],
            risks: [],
            nextActions: [],
          };
        }
        if (request.stepId === 'plan-task-browser-test.T1') return VALID_BROWSER_PLAN;
        return undefined;
      },
    });
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const workspace = await mkdtemp(join(tmpdir(), 'wf-481-schema-verify-'));
    await mkdir(join(workspace, 'supabase', 'migrations'), { recursive: true });
    harness.workspaces.workspacePath = () => workspace;
    await seedHarnessRun(harness);
    return harness;
  }

  it('fails the step with an ExecutionError naming every drift the verification found', async () => {
    const verifySchema = vi.fn(async () => ({
      missingTables: ['items'],
      missingColumns: ['orders.total'],
      mismatchedColumns: ['orders.qty is text not null, plan requires integer not null'],
      tablesWithoutRls: ['legacy'],
      missingPolicies: ['orders.orders_owner'],
    }));
    const harness = await harnessWithBrowserWorkflow(verifySchema);
    await harness.artifacts.put({
      projectId: 'project-1',
      name: 'schema.current',
      createdBy: 'test',
      runId: 'run-1',
      content: schemaPlanArtifactContent(VALID_SCHEMA_PLAN),
    });

    await expect(
      harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1'),
    ).rejects.toThrow(
      /items[\s\S]*orders\.total[\s\S]*orders\.qty[\s\S]*legacy[\s\S]*orders_owner/,
    );

    expect((await harness.runs.get('run-1'))?.status).toBe('failed');
    expect(verifySchema).toHaveBeenCalledWith({
      projectId: 'project-1',
      environmentId: 'run-1',
      tables: VALID_SCHEMA_PLAN.tables,
    });
  });

  it('does not fail the step when verifySchema reports a clean database', async () => {
    const verifySchema = vi.fn(async () => ({
      missingTables: [],
      missingColumns: [],
      mismatchedColumns: [],
      tablesWithoutRls: [],
      missingPolicies: [],
    }));
    const harness = await harnessWithBrowserWorkflow(verifySchema);
    await harness.artifacts.put({
      projectId: 'project-1',
      name: 'schema.current',
      createdBy: 'test',
      runId: 'run-1',
      content: schemaPlanArtifactContent(VALID_SCHEMA_PLAN),
    });

    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    expect(verifySchema).toHaveBeenCalledTimes(1);
  });

  it('skips verification silently when no schema.current artifact exists', async () => {
    const verifySchema = vi.fn(async () => ({
      missingTables: ['should-not-be-checked'],
      missingColumns: [],
      mismatchedColumns: [],
      tablesWithoutRls: [],
      missingPolicies: [],
    }));
    const harness = await harnessWithBrowserWorkflow(verifySchema);

    await harness.orchestrator.runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1');

    expect((await harness.runs.get('run-1'))?.status).toBe('completed');
    expect(verifySchema).not.toHaveBeenCalled();
  });

  it('still runs before the blocking full-suite gate when no task is browser-visible', async () => {
    const verifySchema = vi.fn(async () => ({
      missingTables: ['items'],
      missingColumns: [],
      mismatchedColumns: [],
      tablesWithoutRls: [],
      missingPolicies: [],
    }));
    const harness = await harnessWithBrowserWorkflow(
      verifySchema,
      DETERMINISTIC_FULL_SUITE_WORKFLOW,
      GENERATED_GRAPH,
    );
    await harness.artifacts.put({
      projectId: 'project-1',
      name: 'schema.current',
      createdBy: 'test',
      runId: 'run-1',
      content: schemaPlanArtifactContent(VALID_SCHEMA_PLAN),
    });

    // Every task is deterministic-only, so task-graph-runner skips the browser
    // step and its sync entirely; without the full-suite backstop the drift
    // check would silently never run.
    await expect(
      harness.orchestrator.runProject('project-1', DETERMINISTIC_FULL_SUITE_WORKFLOW.id, 'run-1'),
    ).rejects.toThrow(/does not match the approved schema plan/);
    const stepIds = (await harness.stepRuns.list('run-1')).map((step) => step.stepId);
    expect(stepIds).not.toContain('assert-task.T1');
    expect(verifySchema).toHaveBeenCalledTimes(1);
  });
});

describe('advisory UI-quality judge (#475)', () => {
  const SCREENSHOT_NAME = 'browser-screenshot-preview-475-open-task';

  /**
   * Runs the browser-verification workflow once. `judge` decides only whether
   * `policy.uiQualityJudge` is configured, so the two variants differ in
   * nothing else — that is what makes the approved/repair comparison below
   * meaningful.
   */
  async function runBrowserWorkflow(options: {
    judge: boolean;
    approved: boolean;
    judgeFails?: boolean;
    /** Overrides every criterion's score (and overallScore) uniformly. */
    judgeScore?: number;
    /** Promotes the judge to a blocking gate (#477) at this threshold. */
    minOverallScore?: number;
  }) {
    const judgeRequests: AgentExecutionRequest[] = [];
    const judgeSawScreenshot: boolean[] = [];
    /** Filled in below, before the run; the verify fake reads it at call time. */
    const screenshots: ArtifactReference[] = [];

    const judgeExecutor = {
      execute: async (request: AgentExecutionRequest): Promise<AgentExecutionResult> => {
        const { access } = await import('node:fs/promises');
        const { join } = await import('node:path');
        judgeRequests.push(request);
        if (options.judgeFails) throw new Error('judge exploded');
        judgeSawScreenshot.push(
          await access(join(request.cwd, '0-open-task.png')).then(
            () => true,
            () => false,
          ),
        );
        return {
          runId: request.runId,
          provider: request.provider,
          model: request.model,
          executedModel: 'judge-model-v9',
          exitCode: 0,
          durationMs: 3,
          stdout: '',
          stderr: '',
          output: {
            schemaVersion: '1',
            status: 'completed',
            summary: 'Judged the screenshots.',
            data:
              options.judgeScore !== undefined
                ? {
                    overallScore: options.judgeScore,
                    criteria: UI_QUALITY_RUBRIC_V1.criteria.map((criterion) => ({
                      criterionId: criterion.id,
                      score: options.judgeScore!,
                    })),
                  }
                : {
                    overallScore: 0.42,
                    criteria: [
                      {
                        criterionId: 'layout-coherence',
                        score: 0.4,
                        finding:
                          'Header overlaps the nav on http://preview.test/?token=s3cret-value',
                      },
                      { criterionId: 'navigation', score: 0.9 },
                    ],
                  },
            decisions: [],
            assumptions: [],
            risks: [],
            nextActions: [],
          },
        };
      },
    };

    const verify = vi.fn(
      async (
        input: { plan: { metadata: { name: string; revision: number; sha256: string } } },
        _signal: AbortSignal,
        onSessionStarted?: (sessionId: string) => Promise<void>,
      ) => {
        await onSessionStarted?.('preview-475');
        return {
          schemaVersion: '1' as const,
          approved: options.approved,
          summary: options.approved ? 'browser approved' : 'browser rejected',
          planArtifact: {
            name: input.plan.metadata.name,
            revision: input.plan.metadata.revision,
            sha256: input.plan.metadata.sha256,
          },
          previewSession: {
            sessionId: 'preview-475',
            status: 'running' as const,
            evidence: {
              screenshots: screenshots.map((shot) => ({
                ...shot,
                stepId: 'open-task',
                url: 'http://preview.test/',
                viewport: { width: 1280, height: 720 },
              })),
            },
          },
          steps: [
            {
              stepId: 'open-task',
              title: 'Open task',
              status: options.approved ? ('passed' as const) : ('failed' as const),
              durationMs: 5,
              ...(options.approved ? {} : { error: 'Assertion failed.' }),
              observations: [],
            },
          ],
        };
      },
    );

    const harness = makeHarness({}, undefined, {
      workflow: TASK_BROWSER_WORKFLOW,
      browserVerification: { verify } as never,
      ...(options.judge
        ? {
            policy: {
              ...DEFAULT_POLICY,
              uiQualityJudge: {
                provider: 'claude' as const,
                model: 'judge-model',
                ...(options.minOverallScore === undefined
                  ? {}
                  : { minOverallScore: options.minOverallScore }),
              },
            },
            judgeExecutor,
          }
        : {}),
      agentOutput: (request) => {
        if (request.stepId === 'plan') {
          return {
            schemaVersion: '1',
            status: 'completed',
            summary: 'Planned.',
            data: BROWSER_GRAPH,
            decisions: [],
            assumptions: [],
            risks: [],
            nextActions: [],
          };
        }
        if (request.stepId === 'plan-task-browser-test.T1') return VALID_BROWSER_PLAN;
        return undefined;
      },
    });
    const blob = await harness.artifacts.putBlob(
      {
        projectId: 'project-1',
        name: SCREENSHOT_NAME,
        contentType: 'image/png',
        createdBy: 'browser-verifier',
        maxBytes: 1_000_000,
      },
      Readable.from(Buffer.from('not-really-a-png')),
    );
    screenshots.push({
      name: blob.name,
      revision: blob.revision,
      sha256: blob.sha256,
      sizeBytes: blob.sizeBytes ?? 0,
    });
    await seedHarnessRun(harness);

    const runError = await harness.orchestrator
      .runProject('project-1', TASK_BROWSER_WORKFLOW.id, 'run-1')
      .then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );

    const report = await harness.artifacts.getLatest('project-1', 'browser-verification.report');
    const run = await harness.runs.get('run-1');
    const stepRuns = await harness.stepRuns.list('run-1');
    const steps = await Promise.all(
      stepRuns.map(async (step) => {
        const attempts = await harness.stepAttempts.list('run-1', step.id);
        return `${step.stepId}:${step.status}:${attempts.map((a) => a.status).join(',')}`;
      }),
    );
    return {
      judgeRequests,
      judgeSawScreenshot,
      report: report?.content as Record<string, unknown> | undefined,
      /** Everything the judge must not be able to move. */
      outcome: {
        runError,
        runStatus: run?.status,
        approved: (report?.content as { approved?: boolean } | undefined)?.approved,
        steps: steps.sort(),
      },
      /** Repair/ceiling bookkeeping the judge score must never touch. */
      execution: run?.execution,
      eventTypes: (await harness.events.list('project-1')).map((event) => event.type),
    };
  }

  it('annotates the persisted report with the judge scores', async () => {
    const result = await runBrowserWorkflow({ judge: true, approved: true });

    expect(result.judgeRequests).toHaveLength(1);
    expect(result.judgeSawScreenshot).toEqual([true]);
    const request = result.judgeRequests[0]!;
    expect(request.role).toBe('tester');
    expect(request.taskKind).toBe('verification');
    expect(request.provider).toBe('claude');
    expect(request.model).toBe('judge-model');
    expect(request.mutatesWorkspace).toBe(false);
    // Bounded well below the full agent timeout so a slow judge cannot burn
    // the run's active-time ceiling budget.
    expect(request.timeoutMs).toBe(60_000);
    // The screenshots travel as files under `cwd`, not as inputArtifacts.
    expect(request.inputArtifacts).toBeUndefined();
    expect(request.prompt).toContain('layout-coherence');
    expect(request.prompt).toContain('0-open-task.png');

    expect(result.report?.uiQuality).toEqual({
      rubricVersion: '1',
      judgeModel: 'judge-model-v9',
      overallScore: 0.42,
      criteria: [
        {
          criterionId: 'layout-coherence',
          score: 0.4,
          finding: 'Header overlaps the nav on http://preview.test/?token=[REDACTED]',
        },
        { criterionId: 'navigation', score: 0.9 },
      ],
      screenshotsReviewed: [
        {
          name: SCREENSHOT_NAME,
          revision: 1,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          sizeBytes: 16,
        },
      ],
    });
  });

  it('never runs the judge for a project without a uiQualityJudge policy', async () => {
    const result = await runBrowserWorkflow({ judge: false, approved: true });

    expect(result.judgeRequests).toHaveLength(0);
    expect(result.report?.uiQuality).toBeUndefined();
  });

  it.each([true, false])(
    'leaves approved/repair routing identical with and without the judge (approved=%s)',
    async (approved) => {
      const withJudge = await runBrowserWorkflow({ judge: true, approved });
      const withoutJudge = await runBrowserWorkflow({ judge: false, approved });

      expect(withJudge.outcome.approved).toBe(approved);
      expect(withJudge.outcome).toEqual(withoutJudge.outcome);
      // The only difference between the two runs is the advisory annotation.
      expect(withJudge.report?.uiQuality).toBeDefined();
      expect(withoutJudge.report?.uiQuality).toBeUndefined();
    },
  );

  it('persists the report unannotated when the judge executor fails', async () => {
    const result = await runBrowserWorkflow({ judge: true, approved: true, judgeFails: true });
    const withoutJudge = await runBrowserWorkflow({ judge: false, approved: true });

    expect(result.judgeRequests).toHaveLength(1);
    expect(result.report?.uiQuality).toBeUndefined();
    expect(result.outcome).toEqual(withoutJudge.outcome);
  });

  it('a worst-possible judge score does not drive repair routing or the emergency ceiling', async () => {
    // Isolates the judge score as the sole variable: the underlying browser
    // verification is cleanly approved, and only the judge's opinion is as
    // bad as it can get (score 0 on every criterion). Regression target:
    // nothing downstream of `judgeUiQuality` may read the score to decide
    // `resetConsecutiveRepairs`/`recordCompletedRepair`, trip `reachCeiling`,
    // or fire `quality.repair_requested` — those are driven purely by
    // `report.approved`, which the judge never rewrites (#475).
    const result = await runBrowserWorkflow({ judge: true, approved: true, judgeScore: 0 });
    const withoutJudge = await runBrowserWorkflow({ judge: false, approved: true });

    // Sanity: the worst-case judge fixture actually happened.
    expect(result.judgeRequests).toHaveLength(1);
    expect(result.report?.uiQuality).toMatchObject({
      overallScore: 0,
      criteria: UI_QUALITY_RUBRIC_V1.criteria.map((criterion) => ({
        criterionId: criterion.id,
        score: 0,
      })),
    });

    // The approve/repair outcome, run status, and step/attempt fingerprint
    // are byte-identical to a run where the judge never ran at all.
    expect(result.outcome).toEqual(withoutJudge.outcome);
    expect(result.outcome.approved).toBe(true);

    // resetConsecutiveRepairs (not recordCompletedRepair) is what ran: no
    // consecutive-repair count was ever incremented by the low score.
    expect(result.execution?.consecutiveRepairs ?? 0).toBe(0);
    expect(result.execution?.countedRepairStepRunIds ?? []).toEqual([]);
    // No reachCeiling trigger fired as a result of the judge score.
    expect(result.execution?.ceiling).toBeUndefined();
    // Only quality.approved fired; the score never produced a
    // quality.repair_requested event.
    expect(result.eventTypes).not.toContain('quality.repair_requested');
    expect(result.eventTypes).toContain('quality.approved');
    expect(result.eventTypes).toEqual(withoutJudge.eventTypes);
  });

  it('flips approved to false when a configured minOverallScore is above the judge score (#477)', async () => {
    const result = await runBrowserWorkflow({
      judge: true,
      approved: true,
      judgeScore: 0.4,
      minOverallScore: 0.8,
    });

    expect(result.report?.approved).toBe(false);
    expect(result.outcome.approved).toBe(false);
  });
});

describe('worktree-label threading (#520 task 4)', () => {
  it('a step given a worktree label checkpoints and commits inside the worktree, not the primary checkout', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: WORKTREE_PLUMBING_WORKFLOW,
    });
    await seedRun(stores, WORKTREE_PLUMBING_WORKFLOW.id);
    const project = await stores.projects.get('project-1');
    const step = WORKTREE_PLUMBING_WORKFLOW.nodes[0] as ExecutableStep;

    const checkpointSpy = vi.spyOn(stores.workspaces, 'checkpoint');
    const commitSpy = vi.spyOn(stores.workspaces, 'commit');
    const writeRunContextSpy = vi.spyOn(stores.workspaces, 'writeRunContext');

    const artifact = await (stores.orchestrator as unknown as HasExecuteStep).executeStep(
      project!,
      WORKTREE_PLUMBING_WORKFLOW,
      step,
      'run-1',
      'implement',
      new AbortController().signal,
      undefined,
      [],
      undefined,
      'task-a',
    );

    expect(artifact.metadata.name).toBe('implementation');
    // The step's own checkpoint/rollback bracketing and its commit after the
    // agent runs must all carry the worktree label through to
    // WorkspaceManager, never silently falling back to the primary checkout.
    expect(checkpointSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of checkpointSpy.mock.calls) expect(call[2]).toBe('task-a');
    expect(commitSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of commitSpy.mock.calls) expect(call[2]).toBe('task-a');
    // The prompt-rendered workspace path and the run-context write (which
    // the agent's cwd resolves relative to) must target the same worktree.
    // Asserted on the rendered prompt rather than on a workspacePath() spy:
    // writeRunContext calls workspacePath internally, so a "was called with"
    // assertion would pass even if the prompt's own call lost the label.
    expect(stores.workspaces.lastRequestMarkdown).toContain(
      '- Workspace: /fake/project-1/worktrees/task-a',
    );
    expect(writeRunContextSpy.mock.calls[0]?.[1]).toBe('task-a');
    // The wire snapshot is the single field that actually puts the executor's
    // cwd in the worktree; everything above is bookkeeping around it.
    expect(stores.executor.submittedExecutionRequests.at(-1)?.workspace.worktree).toBe('task-a');
  });

  it('omits the worktree label entirely when the caller passes none, reproducing today’s behaviour', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: WORKTREE_PLUMBING_WORKFLOW,
    });
    await seedRun(stores, WORKTREE_PLUMBING_WORKFLOW.id);
    const project = await stores.projects.get('project-1');
    const step = WORKTREE_PLUMBING_WORKFLOW.nodes[0] as ExecutableStep;

    const checkpointSpy = vi.spyOn(stores.workspaces, 'checkpoint');
    const commitSpy = vi.spyOn(stores.workspaces, 'commit');

    await (stores.orchestrator as unknown as HasExecuteStep).executeStep(
      project!,
      WORKTREE_PLUMBING_WORKFLOW,
      step,
      'run-1',
      'implement',
      new AbortController().signal,
    );

    expect(checkpointSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of checkpointSpy.mock.calls) expect(call[2]).toBeUndefined();
    expect(commitSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of commitSpy.mock.calls) expect(call[2]).toBeUndefined();
  });

  it('refuses a blocking verify gate inside a worktree instead of checking the wrong database', async () => {
    // `syncGeneratedDatabase` applies the *workspace's* pending migrations to
    // the one shared generated database and checks it against the approved
    // schema plan — both run-level, both reading the primary checkout with no
    // worktree. Running it for a worktree-scoped gate verifies a database that
    // never saw the task's own migration; threading the worktree in would push
    // one task's unmerged migration onto every sibling. Neither is acceptable
    // silently (#520 final review, Minor 5).
    const workflow = WorkflowDefinitionSchema.parse({
      schemaVersion: '1',
      id: 'blocking-verify-v1',
      name: 'Blocking verify fixture',
      description: 'One blocking deterministic gate, called directly with a worktree label.',
      stack: 'node',
      nodes: [
        {
          id: 'full-suite',
          type: 'verify',
          title: 'Full suite',
          outputArtifact: 'verification.report',
          blocksOnFailure: true,
        },
      ],
    });
    const stores = makeOrchestrator(undefined, undefined, undefined, { workflow });
    await seedRun(stores, workflow.id);
    const project = await stores.projects.get('project-1');
    const step = workflow.nodes[0] as ExecutableStep;

    await expect(
      (stores.orchestrator as unknown as HasExecuteStep).executeStep(
        project!,
        workflow,
        step,
        'run-1',
        'full-suite',
        new AbortController().signal,
        undefined,
        [],
        undefined,
        'task-a',
      ),
    ).rejects.toThrow('blocksOnFailure');

    // The same gate on the primary checkout gets past the guard and on to the
    // verifier — this fixture has none, which is exactly how far it must get.
    await expect(
      (stores.orchestrator as unknown as HasExecuteStep).executeStep(
        project!,
        workflow,
        step,
        'run-1',
        'full-suite',
        new AbortController().signal,
      ),
    ).rejects.toThrow('verify is not used by this fixture');
  });

  it('rolls the worktree back, not the primary checkout, when every candidate fails', async () => {
    const harness = makeHarness(
      { implement: { kind: 'fail-always', error: () => new Error('agent exploded') } },
      undefined,
      { workflow: WORKTREE_PLUMBING_WORKFLOW },
    );
    await seedHarnessRun(harness);
    const project = await harness.projects.get('project-1');
    const step = harness.workflow.nodes[0] as ExecutableStep;

    await expect(
      (harness.orchestrator as unknown as HasExecuteStep).executeStep(
        project!,
        harness.workflow,
        step,
        'run-1',
        'implement',
        new AbortController().signal,
        undefined,
        [],
        undefined,
        'task-a',
      ),
      // `fail-always` is ADR-0073's Technical Retry (#604): one same-candidate
      // replay before this converges to the technical-retry-exhausted
      // ceiling, rather than the bare `agent exploded` throw a plain
      // candidate-ladder exhaustion would have produced.
    ).rejects.toBeInstanceOf(EmergencyCeilingError);

    // The step's failure rollback undoes work that only exists in the
    // worktree; aimed at the primary checkout it would reset unrelated state.
    expect(harness.workspaces.rollbacks.length).toBeGreaterThan(0);
    for (const worktree of harness.workspaces.rollbackWorktrees) expect(worktree).toBe('task-a');
  });
});
