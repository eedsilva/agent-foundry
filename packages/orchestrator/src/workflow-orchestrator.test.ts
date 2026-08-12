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
  type ExecutorHealth,
  type Project,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import {
  SystemClock,
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
  seedRun as seedHarnessRun,
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
  tasks: VALID_GRAPH.tasks.map((task) => ({ ...task, acceptanceMode: 'deterministic-only' })),
};

const BROWSER_GRAPH = {
  ...VALID_GRAPH,
  tasks: VALID_GRAPH.tasks.map((task) => ({ ...task, acceptanceMode: 'browser-visible' })),
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

    expect(applyWorkspaceMigrations).toHaveBeenCalledWith({
      projectId: 'project-1',
      workspaceMigrationsDir: join(workspace, 'supabase', 'migrations'),
    });
    expect(applyWorkspaceMigrations.mock.invocationCallOrder[0]!).toBeLessThan(
      verify.mock.invocationCallOrder[0]!,
    );
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
              uiQualityJudge: { provider: 'claude' as const, model: 'judge-model' },
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
});
