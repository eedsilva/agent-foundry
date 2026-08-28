import { describe, expect, it, vi } from 'vitest';
import {
  ValidationCampaignPreviewSchema,
  type AppEnvironment,
  type PreviewSession,
  type PreviewWorkspaceRef,
} from '@agent-foundry/contracts';
import { EnvironmentOperationError, type GeneratedProjectRuntime } from '@agent-foundry/domain';
import { authenticationError, makeHarness, makeStores, seedRun } from './testing/harness.js';
import { WorkerLoop } from './worker-loop.js';

const ENVIRONMENT: AppEnvironment = {
  projectId: 'id-0001',
  composeProjectName: 'foundry-id-0001',
  workdir: '/tmp/id-0001',
  network: 'foundry-id-0001',
  volumes: ['foundry-id-0001-db'],
  ports: { api: 54321 },
  endpoints: { api: 'http://127.0.0.1:54321' },
  health: { state: 'healthy', checkedAt: '2026-07-22T12:00:00.000Z' },
  createdAt: '2026-07-22T12:00:00.000Z',
  updatedAt: '2026-07-22T12:00:00.000Z',
};

describe('ProjectService.get', () => {
  it('exposes the generated workspace path without executing an editor command', async () => {
    const harness = makeHarness();
    await seedRun(harness);

    const detail = await harness.service.get('project-1');

    expect((detail as { workspacePath?: string }).workspacePath).toBe(
      harness.workspaces.workspacePath('project-1'),
    );
  });
});

describe('ProjectService.create', () => {
  it('persists the operator-selected canonical project directory before queueing', async () => {
    const harness = makeHarness();

    const project = await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });

    expect(project).toMatchObject({ projectDirectory: '/operator/projects/issue-radar' });
    expect(await harness.projects.get(project.id)).toMatchObject({
      projectDirectory: '/operator/projects/issue-radar',
    });
    expect(harness.workspaces.workspacePath(project.id)).toBe('/operator/projects/issue-radar');
    expect(harness.enqueued).toHaveLength(1);
  });

  it('marks the project and run failed when initial artifact persistence fails', async () => {
    const harness = makeHarness();
    vi.spyOn(harness.artifacts, 'put').mockRejectedValueOnce(
      new Error('artifact store unavailable'),
    );

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toThrow('artifact store unavailable');

    expect(await harness.projects.get('id-0001')).toMatchObject({
      status: 'failed',
      error: 'artifact store unavailable',
    });
    expect(await harness.runs.get('id-0002')).toMatchObject({
      status: 'failed',
      error: { name: 'ProjectInitializationError', message: 'artifact store unavailable' },
    });
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.workspaces.workspacePath('id-0001')).toBe('/operator/projects/issue-radar');
  });

  it('converges persisted project and run when the creation event fails in file mode', async () => {
    const harness = makeHarness();
    harness.events.onBeforeAppend = (event) => {
      if (event.type === 'project.created') throw new Error('event store unavailable');
    };

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toThrow('event store unavailable');

    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'failed' });
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'failed' });
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.executor.requests).toHaveLength(0);
    expect(harness.workspaces.projectDirectories.get('id-0001')).toBe(
      '/operator/projects/issue-radar',
    );
  });

  it('creates the missing failed run when file-mode run persistence fails once', async () => {
    const harness = makeHarness();
    const create = harness.runs.create.bind(harness.runs);
    vi.spyOn(harness.runs, 'create')
      .mockRejectedValueOnce(new Error('run store unavailable'))
      .mockImplementation(create);

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toThrow('run store unavailable');

    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'failed' });
    expect(await harness.runs.get('id-0002')).toMatchObject({
      status: 'failed',
      error: { message: 'run store unavailable' },
    });
    expect(harness.enqueued).toHaveLength(0);
  });

  it('retries initialization compensation when its first run update fails', async () => {
    const harness = makeHarness();
    vi.spyOn(harness.artifacts, 'put').mockRejectedValueOnce(
      new Error('artifact store unavailable'),
    );
    const update = vi
      .spyOn(harness.runs, 'update')
      .mockImplementationOnce(() => Promise.reject(new Error('run compensation unavailable')));

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toThrow('artifact store unavailable');

    expect(update).toHaveBeenCalledTimes(2);
    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'failed' });
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'failed' });
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.executor.requests).toHaveLength(0);
  });

  it('does not publish a job when recording queued state fails', async () => {
    const harness = makeHarness();
    const append = harness.events.append.bind(harness.events);
    vi.spyOn(harness.events, 'append').mockImplementation(async (event) => {
      if (event.type === 'project.queued') throw new Error('event store unavailable');
      return append(event);
    });

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toThrow('event store unavailable');

    expect(harness.enqueued).toHaveLength(0);
    expect(harness.executor.requests).toHaveLength(0);
    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'failed' });
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'failed' });
  });

  it('re-publishes a deterministic job for a queued run after restart', async () => {
    const harness = makeHarness();
    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    harness.enqueued.splice(0);

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toEqual([
      expect.objectContaining({ id: 'run-project-id-0002', runId: 'id-0002' }),
    ]);
  });

  it('keeps initialization failure terminal when job publication fails', async () => {
    const harness = makeHarness();
    harness.failNextEnqueue(new Error('queue unavailable'));

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toThrow('queue unavailable');

    expect(harness.enqueued).toHaveLength(0);
    expect(harness.executor.requests).toHaveLength(0);
    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'failed' });
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'failed' });

    await harness.service.recoverQueuedProjects();

    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'failed' });
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'failed' });
    expect(harness.enqueued).toHaveLength(0);
  });

  it('re-publishes a queued run despite a historical execution failure event', async () => {
    const harness = makeHarness();
    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    harness.enqueued.splice(0);
    await harness.events.append({
      id: 'normal-failure',
      projectId: 'id-0001',
      runId: 'id-0002',
      type: 'project.failed',
      createdAt: '2026-07-14T12:00:00.000Z',
      message: 'Normal execution failure.',
      data: {},
      dedupeKey: 'id-0002:project.failed',
    });

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toHaveLength(1);
    expect(await harness.events.list('id-0001')).toContainEqual(
      expect.objectContaining({ dedupeKey: 'id-0002:project.recovered_queued' }),
    );
  });

  it('exposes a pre-persistence rollback failure without deleting its reservation', async () => {
    const harness = makeHarness();
    vi.spyOn(harness.projects, 'create').mockRejectedValueOnce(
      new Error('project persistence failed'),
    );
    vi.spyOn(harness.workspaces, 'releaseProjectDirectory').mockRejectedValueOnce(
      new Error('reservation rollback failed'),
    );

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toMatchObject({
      message: 'project persistence failed',
      errors: [
        expect.objectContaining({ message: 'project persistence failed' }),
        expect.objectContaining({ message: 'reservation rollback failed' }),
      ],
    });

    expect(harness.workspaces.cleanups).toEqual([]);
    expect(harness.workspaces.workspacePath('id-0001')).toBe('/operator/projects/issue-radar');
  });

  it('keeps the durable reservation and converges to failed when workspace setup fails', async () => {
    const harness = makeHarness();
    vi.spyOn(harness.workspaces, 'initializeProject').mockRejectedValueOnce(
      new Error('workspace write failed'),
    );

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toThrow('workspace write failed');

    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'failed' });
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'failed' });
    expect(harness.workspaces.workspacePath('id-0001')).toBe('/operator/projects/issue-radar');
    expect(harness.workspaces.cleanups).toEqual([]);
  });

  it('does not retry a run whose project initialization failed', async () => {
    const harness = makeHarness();
    vi.spyOn(harness.workspaces, 'initializeProject').mockRejectedValueOnce(
      new Error('workspace write failed'),
    );
    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toThrow('workspace write failed');

    await expect(harness.service.retry('id-0001')).rejects.toThrow(/initialization failed/i);
    expect(harness.enqueued).toHaveLength(0);
  });

  it('does not retry a staged project after a crash persisted no run', async () => {
    const harness = makeHarness();
    const now = new Date().toISOString();
    await harness.projects.create({
      id: 'crashed-project',
      name: 'Issue Radar',
      workflowId: harness.workflow.id,
      policyId: 'default',
      status: 'failed',
      version: 1,
      createdAt: now,
      updatedAt: now,
      currentRunId: 'missing-run',
      projectDirectory: '/operator/projects/issue-radar',
      error: 'Project initialization was interrupted before queue publication.',
    });

    await expect(harness.service.retry('crashed-project')).rejects.toThrow(
      /initialization failed/i,
    );
    expect(harness.enqueued).toHaveLength(0);
  });

  it('stops before project creation when validation preflight is blocked', async () => {
    const campaign = ValidationCampaignPreviewSchema.parse({
      schemaVersion: '1',
      id: 'real-todo-v1',
      name: 'Test campaign',
      sourceRevision: 'a'.repeat(40),
      allowedModels: [
        { id: 'model-1', provider: 'codex', model: 'test-model' },
        { id: 'model-2', provider: 'codex', model: 'alt-model' },
      ],
      routes: [
        {
          taskKind: 'planning',
          selected: { id: 'model-1', provider: 'codex', model: 'test-model' },
          fallbacks: [],
        },
      ],
      limits: {
        attemptsPerAgentStep: 1,
        targetedRepairs: 1,
        activeTimeMinutes: 1,
        meteredCostUsd: 2,
      },
    });
    const harness = makeHarness({}, undefined, {
      validationCampaign: campaign,
      validationPreflight: async () => ({
        schemaVersion: '1',
        campaignId: campaign.id,
        sourceRevision: campaign.sourceRevision,
        dataDirectory: '/Users/edsilva/private-validation-data',
        executorMode: 'real',
        environmentId: 'blocked-preflight',
        startedAt: '2026-08-04T12:00:00.000Z',
        completedAt: '2026-08-04T12:00:01.000Z',
        status: 'environment-blocked',
        checks: [
          {
            boundary: 'docker',
            status: 'failed',
            durationMs: 1,
            errorCode: 'DOCKER_UNAVAILABLE',
          },
        ],
        generatedProjectCreated: false,
      }),
    });

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/fake/project',
      }),
    ).rejects.toThrow('Validation preflight environment-blocked at docker.');

    expect(await harness.projects.get('id-0001')).toBeNull();
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.workspaces.lastPrd).toBeUndefined();
  });

  it('stops before project creation when validation preflight is absent or mismatched', async () => {
    const campaign = ValidationCampaignPreviewSchema.parse({
      schemaVersion: '1',
      id: 'real-todo-v1',
      name: 'Test campaign',
      sourceRevision: 'a'.repeat(40),
      allowedModels: [
        { id: 'model-1', provider: 'codex', model: 'test-model' },
        { id: 'model-2', provider: 'codex', model: 'alt-model' },
      ],
      routes: [
        {
          taskKind: 'planning',
          selected: { id: 'model-1', provider: 'codex', model: 'test-model' },
          fallbacks: [],
        },
      ],
      limits: {
        attemptsPerAgentStep: 1,
        targetedRepairs: 1,
        activeTimeMinutes: 1,
        meteredCostUsd: 2,
      },
    });
    const harness = makeHarness({}, undefined, { validationCampaign: campaign });

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/fake/project',
      }),
    ).rejects.toThrow('Validation preflight is missing or does not match the selected campaign.');

    expect(await harness.projects.get('id-0001')).toBeNull();
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.workspaces.lastPrd).toBeUndefined();
  });

  it('persists the run preflight and queued state before exposing its queue job', async () => {
    const campaign = ValidationCampaignPreviewSchema.parse({
      schemaVersion: '1',
      id: 'real-todo-v1',
      name: 'Test campaign',
      sourceRevision: 'a'.repeat(40),
      allowedModels: [
        { id: 'model-1', provider: 'codex', model: 'test-model' },
        { id: 'model-2', provider: 'codex', model: 'alt-model' },
      ],
      routes: [
        {
          taskKind: 'planning',
          selected: { id: 'model-1', provider: 'codex', model: 'test-model' },
          fallbacks: [],
        },
      ],
      limits: {
        attemptsPerAgentStep: 1,
        targetedRepairs: 1,
        activeTimeMinutes: 1,
        meteredCostUsd: 2,
      },
    });
    const harness = makeHarness({}, undefined, {
      validationCampaign: campaign,
      validationPreflight: async () => ({
        schemaVersion: '1',
        campaignId: campaign.id,
        sourceRevision: campaign.sourceRevision,
        dataDirectory: '/Users/edsilva/private-validation-data',
        executorMode: 'real',
        environmentId: 'preflight-1',
        startedAt: '2026-08-04T12:00:00.000Z',
        completedAt: '2026-08-04T12:00:01.000Z',
        status: 'passed',
        checks: [{ boundary: 'source-revision', status: 'passed', durationMs: 1 }],
        generatedProjectCreated: false,
      }),
    });
    const enqueue = harness.queue.enqueue.bind(harness.queue);
    vi.spyOn(harness.queue, 'enqueue').mockImplementation(async (job, tx) => {
      expect(await harness.artifacts.getLatest('id-0001', 'validation-preflight')).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({ runId: 'id-0002' }),
        }),
      );
      expect(await harness.events.list('id-0001')).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'project.queued' })]),
      );
      return enqueue(job, tx);
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
  });

  it('defers generated-runtime initialization until a worker claims the durable project job', async () => {
    const stores = makeStores();
    const initialize = vi.fn(async ({ projectId }: { projectId: string }) => {
      expect(await stores.projects.get(projectId)).toMatchObject({ id: projectId });
      return ENVIRONMENT;
    });
    const unused = () => Promise.reject(new Error('unused test runtime operation'));
    const harness = makeHarness({}, stores, {
      generatedProjectRuntime: {
        initialize,
        start: unused,
        stop: unused,
        inspect: unused,
        listEnvironments: unused,
        previewMigration: unused,
        applyWorkspaceMigrations: unused,
        verifySchema: unused,
        backupMigration: unused,
        migrate: unused,
        seed: unused,
        health: unused,
        reset: unused,
        cleanup: unused,
        deployFunction: unused,
        listFunctionVersions: unused,
        rollbackFunction: unused,
        invokeFunction: unused,
      } satisfies GeneratedProjectRuntime,
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });

    expect(initialize).not.toHaveBeenCalled();
    expect(harness.enqueued).toEqual([
      expect.objectContaining({ type: 'run-project', projectId: 'id-0001', runId: 'id-0002' }),
    ]);

    harness.queueForWorker(harness.enqueued[0]!);
    const worker = new WorkerLoop(harness.queue, harness.orchestrator, {} as never, {
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
    });
    await worker.runOnce();

    // Provisioning names the candidate stack it creates, never the bare
    // project (#617): the run owns the environment and the ledger entry.
    expect(initialize).toHaveBeenCalledWith({
      projectId: 'id-0001',
      identity: {
        class: 'candidate',
        projectId: 'id-0001',
        environmentId: 'id-0002',
        runCandidateId: 'id-0002',
        projectVersionId: expect.any(String),
      },
    });
    expect((await harness.events.list('id-0001')).map((event) => event.type)).toEqual(
      expect.arrayContaining(['project.provisioning_started', 'project.provisioned']),
    );
  });

  it('persists provisioning diagnostics while exposing a concise project error', async () => {
    const stores = makeStores();
    const transcript = 'Starting database...\nerror running container: exit 1';
    const diagnostic = `${transcript}\n${transcript}\nCommand failed: ${transcript}`;
    const initialize = vi
      .fn()
      .mockRejectedValue(new EnvironmentOperationError('start', 1, diagnostic));
    const unused = () => Promise.reject(new Error('unused test runtime operation'));
    const harness = makeHarness({}, stores, {
      generatedProjectRuntime: {
        initialize,
        start: unused,
        stop: unused,
        inspect: unused,
        listEnvironments: unused,
        previewMigration: unused,
        applyWorkspaceMigrations: unused,
        verifySchema: unused,
        backupMigration: unused,
        migrate: unused,
        seed: unused,
        health: unused,
        reset: unused,
        cleanup: unused,
        deployFunction: unused,
        listFunctionVersions: unused,
        rollbackFunction: unused,
        invokeFunction: unused,
      } satisfies GeneratedProjectRuntime,
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    harness.queueForWorker(harness.enqueued[0]!);

    const worker = new WorkerLoop(harness.queue, harness.orchestrator, {} as never, {
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
    });
    await worker.runOnce();

    expect(await stores.projects.get('id-0001')).toMatchObject({
      status: 'failed',
      error: 'Project provisioning failed. Review the project event timeline for details.',
    });
    expect(await stores.runs.get('id-0002')).toMatchObject({
      status: 'failed',
      error: {
        code: 'PROJECT_PROVISIONING_FAILED',
        message:
          'Supabase start provisioning failed (exit code 1): Supabase start could not start a service. No service-specific stderr was reported; inspect the bounded logs for the failing service before retrying provisioning.',
      },
    });
    const events = await harness.events.list('id-0001');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'project.provisioning_started' }),
        expect.objectContaining({
          type: 'project.provisioning_failed',
          message: 'Project provisioning failed. Review the project event timeline for details.',
          data: {
            diagnostic: {
              schemaVersion: '1',
              phase: 'start',
              exitCode: 1,
              summary: 'Supabase start provisioning failed (exit code 1)',
              context:
                'Supabase start could not start a service. No service-specific stderr was reported; inspect the bounded logs for the failing service before retrying provisioning.',
              logs: transcript,
            },
          },
        }),
      ]),
    );
    expect(harness.nacked).toHaveLength(1);
  });

  it('removes every initialized project resource when project persistence fails', async () => {
    const transactionError = new Error('project transaction failed');
    const stores = makeStores();
    stores.projects.create = () => Promise.reject(transactionError);
    const harness = makeHarness({}, stores);

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'Build it',
        workflowId: harness.workflow.id,
        projectDirectory: '/fake/project',
      }),
    ).rejects.toBe(transactionError);

    expect(harness.workspaces.cleanups).toEqual(['id-0001']);
    expect(harness.workspaces.projectDirectories.has('id-0001')).toBe(false);
    expect(harness.enqueued).toEqual([]);
  });
});

describe('ProjectService.create workspace boot', () => {
  const NOW = '2026-07-22T12:00:00.000Z';
  const previewSession = (overrides: Partial<PreviewSession> = {}): PreviewSession => ({
    id: 'preview-1',
    workspaceRef: { projectId: 'id-0001', workspacePath: '/tmp/ws' },
    status: 'running',
    url: 'http://127.0.0.1/preview/preview-1/?token=t',
    version: 1,
    health: { state: 'healthy', checkedAt: NOW, consecutiveFailures: 0 },
    ttl: { seconds: 1_800 },
    restartCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
  const runWorker = async (harness: ReturnType<typeof makeHarness>) => {
    harness.queueForWorker(harness.enqueued[0]!);
    const worker = new WorkerLoop(harness.queue, harness.orchestrator, {} as never, {
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
    });
    await worker.runOnce();
  };

  it('installs and boots the scaffolded workspace into a preview during provisioning', async () => {
    const start = vi.fn(async (input: { workspaceRef: PreviewWorkspaceRef; runId?: string }) => ({
      session: previewSession({
        workspaceRef: input.workspaceRef,
        ...(input.runId ? { runId: input.runId } : {}),
        commandPlan: {
          packageManager: 'pnpm',
          install: { ok: true, command: 'pnpm', args: ['install', '--frozen-lockfile'] },
          build: { ok: true, command: 'pnpm', args: ['run', 'build'] },
          dev: { ok: true, command: 'pnpm', args: ['run', 'dev'] },
          versions: { node: 'v22.22.3', packageManager: '10.30.1' },
          detectedAt: NOW,
        },
      }),
      url: 'http://127.0.0.1/preview/preview-1/?token=t',
    }));
    const harness = makeHarness({}, makeStores(), {
      previews: { start, activeForProject: async () => undefined },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    await runWorker(harness);

    expect(start).toHaveBeenCalledWith({
      workspaceRef: {
        projectId: 'id-0001',
        environmentId: 'id-0002',
        workspacePath: harness.workspaces.workspacePath('id-0001'),
      },
      runId: 'id-0002',
    });
    expect(await harness.events.list('id-0001')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'project.provisioned',
          data: {
            previewSessionId: 'preview-1',
            install: {
              command: 'pnpm',
              args: ['install', '--frozen-lockfile'],
              versions: { node: 'v22.22.3', packageManager: '10.30.1' },
            },
            // Recorded so a resumed run reports the same environment and
            // source version without re-resolving a moved HEAD (#617).
            environment: {
              class: 'candidate',
              projectId: 'id-0001',
              environmentId: 'id-0002',
              runCandidateId: 'id-0002',
              projectVersionId: expect.any(String),
            },
          },
        }),
      ]),
    );
  });

  it('fails provisioning loudly when the workspace does not install or boot', async () => {
    const stderr = 'ERR_PNPM_NO_PKG_MANIFEST  No package.json found';
    const start = vi.fn(async () => ({
      session: previewSession({
        status: 'failed',
        completedAt: NOW,
        failureEvidence: { exitCode: 1, stdout: '', stderr },
        error: { name: 'PreviewInstallError', code: 'PREVIEW_INSTALL_FAILED', message: stderr },
      }),
      url: '',
    }));
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      previews: { start, activeForProject: async () => undefined },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    await runWorker(harness);

    expect(await stores.projects.get('id-0001')).toMatchObject({
      status: 'failed',
      error: 'Project provisioning failed. Review the project event timeline for details.',
    });
    expect(await stores.runs.get('id-0002')).toMatchObject({
      status: 'failed',
      error: {
        code: 'PROJECT_PROVISIONING_FAILED',
        message: `Preview start provisioning failed (exit code 1): ${stderr}`,
      },
    });
    expect(await harness.events.list('id-0001')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'project.provisioning_failed',
          data: {
            diagnostic: {
              schemaVersion: '1',
              phase: 'start',
              exitCode: 1,
              summary: 'Preview start provisioning failed (exit code 1)',
              context: stderr,
              logs: stderr,
            },
          },
        }),
      ]),
    );
  });

  it('fails provisioning loudly when the preview service itself throws', async () => {
    const stores = makeStores();
    const start = vi.fn(async () => {
      throw new Error('docker daemon unreachable');
    });
    const harness = makeHarness({}, stores, {
      previews: { start, activeForProject: async () => undefined },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    await runWorker(harness);

    expect(await stores.runs.get('id-0002')).toMatchObject({
      status: 'failed',
      error: {
        code: 'PROJECT_PROVISIONING_FAILED',
        message: 'Workspace provisioning failed: docker daemon unreachable',
      },
    });
    expect(await harness.events.list('id-0001')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'project.provisioning_failed',
          data: {
            diagnostic: {
              schemaVersion: '1',
              phase: 'workspace',
              summary: 'Workspace provisioning failed',
              context: 'docker daemon unreachable',
              logs: 'docker daemon unreachable',
            },
          },
        }),
      ]),
    );
  });

  it('redacts and bounds generic asynchronous provisioning diagnostics', async () => {
    const workdir = '/tmp/agent-foundry/project/environment';
    const start = vi.fn(async () => {
      throw new Error(`migration failed --workdir ${workdir}\n${'x'.repeat(10_000)}`);
    });
    const stores = makeStores();
    const harness = makeHarness({}, stores, {
      previews: { start, activeForProject: async () => undefined },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    await runWorker(harness);

    const event = (await harness.events.list('id-0001')).find(
      (candidate) => candidate.type === 'project.provisioning_failed',
    );
    expect(event?.data).toMatchObject({
      diagnostic: {
        context: 'migration failed --workdir [REDACTED]',
      },
    });
    const logs = (event?.data as { diagnostic: { logs: string } }).diagnostic.logs;
    expect(logs).not.toContain(workdir);
    expect(new TextEncoder().encode(logs).byteLength).toBeLessThanOrEqual(8 * 1024);
  });

  it('gives retry guidance when the provider returns only a generic failure', async () => {
    const start = vi.fn(async () => {
      throw new Error('Supabase command failed.');
    });
    const harness = makeHarness({}, makeStores(), {
      previews: { start, activeForProject: async () => undefined },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    await runWorker(harness);

    const event = (await harness.events.list('id-0001')).find(
      (candidate) => candidate.type === 'project.provisioning_failed',
    );
    expect(event?.data).toMatchObject({
      diagnostic: {
        context:
          'Workspace could not start a service. No service-specific stderr was reported; inspect the bounded logs for the failing service before retrying provisioning.',
      },
    });
  });

  it('boots the workspace only after the generated runtime has provisioned its environment', async () => {
    const initialize = vi.fn(async () => ENVIRONMENT);
    const unused = () => Promise.reject(new Error('unused test runtime operation'));
    const start = vi.fn(async (input: { workspaceRef: PreviewWorkspaceRef; runId?: string }) => ({
      session: previewSession({
        workspaceRef: input.workspaceRef,
        ...(input.runId ? { runId: input.runId } : {}),
      }),
      url: 'http://127.0.0.1/preview/preview-1/?token=t',
    }));
    const harness = makeHarness({}, makeStores(), {
      generatedProjectRuntime: {
        initialize,
        start: unused,
        stop: unused,
        inspect: unused,
        listEnvironments: unused,
        previewMigration: unused,
        applyWorkspaceMigrations: unused,
        verifySchema: unused,
        backupMigration: unused,
        migrate: unused,
        seed: unused,
        health: unused,
        reset: unused,
        cleanup: unused,
        deployFunction: unused,
        listFunctionVersions: unused,
        rollbackFunction: unused,
        invokeFunction: unused,
      } satisfies GeneratedProjectRuntime,
      previews: { start, activeForProject: async () => undefined },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    await runWorker(harness);

    // The scaffold's middleware reads the Supabase env that initialize()
    // writes; booting first would start the app without its credentials.
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(initialize.mock.invocationCallOrder[0]!).toBeLessThan(
      start.mock.invocationCallOrder[0]!,
    );
  });

  it('does not boot a second preview when the project already has a live session', async () => {
    const start = vi.fn();
    const harness = makeHarness({}, makeStores(), {
      previews: {
        start,
        activeForProject: async () =>
          previewSession({
            runId: 'id-0002',
            workspaceRef: {
              projectId: 'id-0001',
              environmentId: 'id-0002',
              workspacePath: '/tmp/ws',
            },
          }),
      },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    await runWorker(harness);

    expect(start).not.toHaveBeenCalled();
    expect(
      (await harness.events.list('id-0001')).some((event) => event.type === 'project.provisioned'),
    ).toBe(true);
  });

  it('boots the candidate preview when only a legacy project preview is live', async () => {
    const start = vi.fn(async (input: { workspaceRef: PreviewWorkspaceRef; runId?: string }) => ({
      session: previewSession({
        workspaceRef: input.workspaceRef,
        ...(input.runId ? { runId: input.runId } : {}),
      }),
      url: 'http://127.0.0.1/preview/preview-1/?token=t',
    }));
    const harness = makeHarness({}, makeStores(), {
      previews: {
        start,
        activeForProject: async (_projectId, environmentId) =>
          environmentId === undefined ? previewSession() : undefined,
      },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    await runWorker(harness);

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'id-0002',
        workspaceRef: expect.objectContaining({ environmentId: 'id-0002' }),
      }),
    );
  });

  it('retries a failed step without reprovisioning the generated runtime', async () => {
    let initialized: AppEnvironment | undefined;
    const initialize = vi.fn(
      async (input: { projectId: string; identity?: AppEnvironment['identity'] }) =>
        (initialized = { ...ENVIRONMENT, ...(input.identity ? { identity: input.identity } : {}) }),
    );
    const listEnvironments = vi.fn(async () => (initialized ? [initialized] : []));
    const unused = () => Promise.reject(new Error('unused test runtime operation'));
    const harness = makeHarness(
      // A plain executor failure is now ADR-0073's Technical Retry (#604): a
      // `fail-once` generic Error would auto-heal on the same-candidate
      // replay and never leave a failed step for `retryStep` to act on. An
      // auth failure stays outside Technical Retry (it's an environment
      // fault, not a provider/executor call failure), so it still fails the
      // step on the first attempt the way this test needs.
      { implement: { kind: 'fail-once', error: authenticationError } },
      makeStores(),
      {
        generatedProjectRuntime: {
          initialize,
          start: unused,
          stop: unused,
          inspect: unused,
          listEnvironments,
          previewMigration: unused,
          applyWorkspaceMigrations: unused,
          verifySchema: unused,
          backupMigration: unused,
          migrate: unused,
          seed: unused,
          health: unused,
          reset: unused,
          cleanup: unused,
          deployFunction: unused,
          listFunctionVersions: unused,
          rollbackFunction: unused,
          invokeFunction: unused,
        } satisfies GeneratedProjectRuntime,
      },
    );

    await harness.service.create({
      name: 'Retry project',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });
    const worker = new WorkerLoop(harness.queue, harness.orchestrator, {} as never, {
      workerId: 'worker-1',
      pollIntervalMs: 1_000,
    });
    harness.queueForWorker(harness.enqueued[0]!);
    await worker.runOnce();

    const failedImplement = (await harness.stepRuns.list('id-0002')).find(
      (step) => step.stepId === 'implement' && step.status === 'failed',
    );
    expect(failedImplement).toBeDefined();
    await harness.service.retryStep('id-0002', failedImplement!.id, { mode: 'preserve' });

    harness.queueForWorker(harness.enqueued[0]!);
    await worker.runOnce();

    // The retry verifies the persisted binding, then uses initialize's
    // idempotent recovery path; it must not ask for a different environment.
    expect(initialize).toHaveBeenCalledTimes(2);
    expect(initialize.mock.calls[1]).toEqual(initialize.mock.calls[0]);
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'completed' });
  });
});

describe('ProjectService.create scaffold application', () => {
  it('applies scaffold files for the workflow stack and records provenance', async () => {
    const stores = makeStores();
    stores.scaffoldFiles.value = [
      { path: 'lib/supabase/client.ts', content: 'export const marker = "scaffold";\n' },
      { path: 'middleware.ts', content: 'export const config = {};\n' },
    ];
    const harness = makeHarness({}, stores);

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });

    expect(harness.workspaces.lastScaffoldFiles).toEqual(stores.scaffoldFiles.value);

    const manifest = await harness.artifacts.getLatest('id-0001', 'scaffold-manifest');
    expect(manifest?.metadata.createdBy).toBe(`scaffold:${harness.workflow.stack}`);
    expect(manifest?.content).toEqual(['lib/supabase/client.ts', 'middleware.ts']);

    const events = await harness.events.list('id-0001');
    expect(events.some((event) => event.type === 'scaffold.applied')).toBe(true);
  });

  it('does not write a scaffold artifact or event when the stack has no scaffold files', async () => {
    const stores = makeStores();
    stores.scaffoldFiles.value = [];
    const harness = makeHarness({}, stores);

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/fake/project',
    });

    expect(harness.workspaces.lastScaffoldFiles).toEqual([]);
    expect(await harness.artifacts.getLatest('id-0001', 'scaffold-manifest')).toBeNull();
  });
});
