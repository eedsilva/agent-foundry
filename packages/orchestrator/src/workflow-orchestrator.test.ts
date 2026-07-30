import { describe, expect, it, vi } from 'vitest';
import {
  RouteDecisionSchema,
  TASK_GRAPH_ARTIFACT_JSON_SCHEMA,
  WorkflowDefinitionSchema,
  type AgentExecutionRequest,
  type AgentExecutionResult,
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
  const executors: Pick<ExecutorRegistry, 'health'> | undefined = executorHealth
    ? { health: () => Promise.resolve(executorHealth) }
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
      routing: { source: 'default', executors: ['claude', 'glm', 'codex', 'agy'] },
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

describe('task-graph output contract (#321)', () => {
  it('requests the task-graph JSON schema and stores a conforming plan', async () => {
    const stores = makeOrchestrator(undefined, undefined, undefined, {
      workflow: TASK_GRAPH_WORKFLOW,
      output: () => ({
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned.',
        data: VALID_GRAPH,
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
        data: ++calls === 1 ? { note: 'prose' } : VALID_GRAPH,
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
