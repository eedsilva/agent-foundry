import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  ValidationCampaignPreviewSchema,
  WorkflowDefinitionSchema,
  type AppEnvironment,
  type ExecutableStep,
  type ForEachTaskStep,
  type PreviewSession,
  type PreviewWorkspaceRef,
  type WorkflowDefinition,
} from '@agent-foundry/contracts';
import {
  EnvironmentOperationError,
  StandardPrdRejectedError,
  prdIdentity,
  type GeneratedProjectRuntime,
} from '@agent-foundry/domain';
import { VALID_STANDARD_PRD } from './testing/standard-prd-fixture.js';
import { InProcessProjectMutationLock } from './project-service.js';
import {
  approveCurrentPrd,
  authenticationError,
  makeHarness,
  makeStores,
  seedRun,
  type HasExecuteStep,
} from './testing/harness.js';
import type { TaskGraphRunner } from './task-graph-runner.js';
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

describe('ProjectService.retry', () => {
  it('is a no-op while the current run is still queued', async () => {
    const harness = makeHarness();
    const created = await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    await approveCurrentPrd(harness, created.id);

    const retried = await harness.service.retry(created.id);

    expect(retried.currentRunId).toBe(created.currentRunId);
    expect(harness.enqueued).toHaveLength(1);
  });
});

describe('ProjectService.create', () => {
  it('rejects an oversized PRD before reserving a directory or queueing work', async () => {
    const harness = makeHarness();

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'x'.repeat(60_000),
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toMatchObject({
      name: StandardPrdRejectedError.name,
      issues: expect.arrayContaining([
        {
          code: 'max-length',
          path: 'document',
          message: 'PRD must not exceed 50,000 characters.',
        },
      ]),
    });
    expect(await harness.projects.list()).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });

  it('rejects a non-Standard PRD on a nextjs workflow before side effects', async () => {
    const base = makeHarness();
    const harness = makeHarness({}, undefined, { workflow: { ...base.workflow, stack: 'nextjs' } });

    await expect(
      harness.service.create({
        name: 'Issue Radar',
        prd: 'x'.repeat(200),
        workflowId: harness.workflow.id,
        projectDirectory: '/operator/projects/issue-radar',
      }),
    ).rejects.toMatchObject({
      name: StandardPrdRejectedError.name,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'missing-or-duplicate-field', path: 'title' }),
      ]),
    });
    expect(await harness.projects.list()).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });

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
    await approveCurrentPrd(harness, project.id);
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
    const project = await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    const append = harness.events.append.bind(harness.events);
    vi.spyOn(harness.events, 'append').mockImplementation(async (event) => {
      if (event.type === 'project.queued') throw new Error('event store unavailable');
      return append(event);
    });

    await expect(approveCurrentPrd(harness, project.id)).rejects.toThrow('event store unavailable');

    expect(harness.enqueued).toHaveLength(0);
    expect(harness.executor.requests).toHaveLength(0);
    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'awaiting_approval' });
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'awaiting_approval' });
  });

  it('re-publishes a deterministic job for a queued run after restart', async () => {
    const harness = makeHarness();
    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    await approveCurrentPrd(harness, 'id-0001');
    harness.enqueued.splice(0);

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toEqual([
      expect.objectContaining({ id: 'run-project-id-0002', runId: 'id-0002' }),
    ]);
  });

  it('recovers queue publication after the approval enqueue fails in file mode', async () => {
    const harness = makeHarness();
    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    harness.failNextEnqueue(new Error('queue unavailable'));

    await expect(approveCurrentPrd(harness, 'id-0001')).rejects.toThrow('queue unavailable');

    // File mode persists the approved queued state before the queue write, so
    // restart recovery re-publishes the deterministic job (#602 keeps the
    // pre-approval recovery contract intact).
    expect(harness.enqueued).toHaveLength(0);
    expect(harness.executor.requests).toHaveLength(0);
    expect(await harness.projects.get('id-0001')).toMatchObject({ status: 'queued' });
    expect(await harness.runs.get('id-0002')).toMatchObject({ status: 'queued' });

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toEqual([
      expect.objectContaining({ id: 'run-project-id-0002', runId: 'id-0002' }),
    ]);
  });

  it('re-publishes a queued run despite a historical execution failure event', async () => {
    const harness = makeHarness();
    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');

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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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
    await approveCurrentPrd(harness, 'id-0001');
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

describe('PRD approval gate (#602)', () => {
  const actor = { kind: 'user' as const, id: 'operator' };
  const input = (harness: ReturnType<typeof makeHarness>) => ({
    name: 'Issue Radar',
    prd: 'Build it',
    workflowId: harness.workflow.id,
    projectDirectory: '/operator/projects/issue-radar',
  });

  function standardPrd(fr: string): string {
    return VALID_STANDARD_PRD.replace(
      '- **FR-001**: The owner can create a task. `capability:user-owned-crud`',
      `- **FR-001**: ${fr}`,
    );
  }

  it('creates the project awaiting approval without queueing', async () => {
    const harness = makeHarness();

    const project = await harness.service.create(input(harness));

    expect(harness.enqueued).toEqual([]);
    expect(project.status).toBe('awaiting_approval');
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('awaiting_approval');
    expect((await harness.artifacts.getLatest(project.id, 'prd'))?.metadata.revision).toBe(1);
  });

  it('queues exactly once when the operator approves the exact revision identity', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    const identity = prdIdentity('Build it');

    const approved = await harness.service.approvePrd(project.id, { identity, actor });

    expect(approved.run.status).toBe('queued');
    expect(approved.project.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);
    expect((await harness.artifacts.getLatest(project.id, 'prd-approval'))?.content).toMatchObject({
      identity,
    });
    expect(harness.events.types()).toContain('prd.approved');

    const replay = await harness.service.approvePrd(project.id, { identity, actor });
    expect(replay.run.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);
  });

  it('refuses approval before persistence when stored PRD markdown becomes structured content', async () => {
    const harness = makeHarness();
    const project = await harness.service.create({
      ...input(harness),
      prd: '[object Object]',
    });
    harness.artifacts.named('prd')[0]!.content = {};

    await expect(
      harness.service.approvePrd(project.id, {
        identity: prdIdentity('[object Object]'),
        actor,
      }),
    ).rejects.toThrow(/text content/i);

    expect(await harness.artifacts.getLatest(project.id, 'prd-approval')).toBeNull();
    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('awaiting_approval');
  });

  it('refuses approval before persistence when stored PRD text no longer matches its digest', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    harness.artifacts.named('prd')[0]!.content = 'Tampered before approval';

    await expect(
      harness.service.approvePrd(project.id, {
        identity: prdIdentity('Tampered before approval'),
        actor,
      }),
    ).rejects.toThrow(/digest/i);

    expect(await harness.artifacts.getLatest(project.id, 'prd-approval')).toBeNull();
    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('awaiting_approval');
  });

  it('rejects an approval that references a stale or foreign hash', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));

    await expect(
      harness.service.approvePrd(project.id, { identity: prdIdentity('something else'), actor }),
    ).rejects.toMatchObject({ name: 'PrdApprovalConflictError' });
    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('awaiting_approval');
  });

  it('invalidates the pending approval when the PRD changes and keeps the queue empty', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    const original = prdIdentity('Build it');

    const revised = await harness.service.revisePrd(project.id, { prd: 'Build it differently' });

    expect(revised.revision).toBe(2);
    expect(revised.identity).toBe(prdIdentity('Build it differently'));
    const lineage = (await harness.events.list(project.id)).find(
      (event) => event.type === 'prd.revised',
    );
    expect(lineage?.data).toMatchObject({ identity: revised.identity, parentIdentity: original });

    await expect(
      harness.service.approvePrd(project.id, { identity: original, actor }),
    ).rejects.toMatchObject({ name: 'PrdApprovalConflictError' });
    expect(harness.enqueued).toEqual([]);

    await harness.service.approvePrd(project.id, { identity: revised.identity, actor });
    expect(harness.enqueued).toHaveLength(1);
  });

  it('treats resubmission of identical content as the same revision', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));

    const first = await harness.service.revisePrd(project.id, { prd: 'Build it differently' });
    const second = await harness.service.revisePrd(project.id, { prd: 'Build it differently' });

    expect(second.revision).toBe(first.revision);
    expect((await harness.artifacts.getLatest(project.id, 'prd'))?.metadata.revision).toBe(2);
    const revisedEvents = (await harness.events.list(project.id)).filter(
      (event) => event.type === 'prd.revised',
    );
    expect(revisedEvents).toHaveLength(1);
  });

  it('keeps lineage events distinct when a later revision repeats an older content hash', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));

    await harness.service.revisePrd(project.id, { prd: 'Build B' });
    await harness.service.revisePrd(project.id, { prd: 'Build it' });
    await harness.service.revisePrd(project.id, { prd: 'Build B' });

    const revisedEvents = (await harness.events.list(project.id)).filter(
      (event) => event.type === 'prd.revised',
    );
    expect(revisedEvents.map((event) => event.data.revision)).toEqual([2, 3, 4]);
  });

  it('blocks revision once the run is queued', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await harness.service.approvePrd(project.id, { identity: prdIdentity('Build it'), actor });

    await expect(harness.service.revisePrd(project.id, { prd: 'Too late' })).rejects.toMatchObject({
      name: 'ValidationError',
    });
    expect((await harness.artifacts.getLatest(project.id, 'prd'))?.metadata.revision).toBe(1);
  });

  it('fails early when a nextjs PRD declares an unsupported capability', async () => {
    const base = makeHarness();
    const harness = makeHarness({}, undefined, { workflow: { ...base.workflow, stack: 'nextjs' } });

    await expect(
      harness.service.create({
        ...input(harness),
        prd: standardPrd('The owner uploads an attachment. `capability:file-upload`'),
      }),
    ).rejects.toMatchObject({
      name: 'ApplicationEnvelopeRejectedError',
      rejections: [expect.objectContaining({ capability: 'file-upload', requirementId: 'FR-001' })],
    });
    expect(await harness.projects.list()).toEqual([]);
    expect(harness.enqueued).toEqual([]);
  });

  it('turns an unknown capability into a persisted Blocking Question that blocks approval', async () => {
    const base = makeHarness();
    const harness = makeHarness({}, undefined, { workflow: { ...base.workflow, stack: 'nextjs' } });

    const project = await harness.service.create({
      ...input(harness),
      prd: standardPrd('The owner syncs via quantum link. `capability:quantum-sync`'),
    });

    const questions = (await harness.events.list(project.id)).find(
      (event) => event.type === 'prd.blocking_questions',
    );
    expect(questions?.data).toMatchObject({
      questions: [expect.objectContaining({ capability: 'quantum-sync' })],
    });

    const stored = await harness.artifacts.getLatest(project.id, 'prd');
    await expect(
      harness.service.approvePrd(project.id, {
        identity: prdIdentity(String(stored?.content)),
        actor,
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(harness.enqueued).toEqual([]);
  });

  it('lets a fully supported nextjs PRD through the whole gate', async () => {
    const base = makeHarness();
    const harness = makeHarness({}, undefined, { workflow: { ...base.workflow, stack: 'nextjs' } });

    const project = await harness.service.create({
      ...input(harness),
      prd: standardPrd('The owner can create a task. `capability:user-owned-crud`'),
    });
    const stored = await harness.artifacts.getLatest(project.id, 'prd');

    await harness.service.approvePrd(project.id, {
      identity: prdIdentity(String(stored?.content)),
      actor,
    });
    expect(harness.enqueued).toHaveLength(1);
  });

  it('blocks a nextjs PRD whose FR, BR, or NFR item declares no capability', async () => {
    const base = makeHarness();
    for (const [line, replacement] of [
      [
        '- **FR-001**: The owner can create a task. `capability:user-owned-crud`',
        '- **FR-001**: The owner can create a task.',
      ],
      [
        '- **BR-001**: A task belongs to exactly one owner. `capability:ownership`',
        '- **BR-001**: A task belongs to exactly one owner.',
      ],
      [
        '- **NFR-001**: The task list is keyboard accessible. `capability:interface-language`',
        '- **NFR-001**: The task list is keyboard accessible.',
      ],
    ] as const) {
      const harness = makeHarness({}, undefined, {
        workflow: { ...base.workflow, stack: 'nextjs' },
      });
      const project = await harness.service.create({
        ...input(harness),
        prd: VALID_STANDARD_PRD.replace(line, replacement),
      });
      const stored = await harness.artifacts.getLatest(project.id, 'prd');
      await expect(
        harness.service.approvePrd(project.id, {
          identity: prdIdentity(String(stored?.content)),
          actor,
        }),
      ).rejects.toMatchObject({ name: 'ValidationError' });
      expect(harness.enqueued).toEqual([]);
      const questions = (await harness.events.list(project.id)).find(
        (event) => event.type === 'prd.blocking_questions',
      );
      expect(questions?.data).toMatchObject({
        questions: [expect.objectContaining({ code: 'unclassified-requirement' })],
      });
    }
  });

  it('turns a capability marker with invalid case into a Blocking Question instead of dropping it', async () => {
    const base = makeHarness();
    const harness = makeHarness({}, undefined, { workflow: { ...base.workflow, stack: 'nextjs' } });

    const project = await harness.service.create({
      ...input(harness),
      prd: standardPrd('The owner uploads an attachment. `capability:File-Upload`'),
    });

    const events = await harness.events.list(project.id);
    const questions = events.find((event) => event.type === 'prd.blocking_questions');
    expect(questions?.data).toMatchObject({
      questions: [
        expect.objectContaining({
          code: 'invalid-capability-syntax',
          requirementId: 'FR-001',
          capability: 'File-Upload',
        }),
      ],
    });
    const stored = await harness.artifacts.getLatest(project.id, 'prd');
    await expect(
      harness.service.approvePrd(project.id, {
        identity: prdIdentity(String(stored?.content)),
        actor,
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(harness.enqueued).toEqual([]);
  });

  it('rejects a requirement mixing a supported and an unsupported capability', async () => {
    const base = makeHarness();
    const harness = makeHarness({}, undefined, { workflow: { ...base.workflow, stack: 'nextjs' } });

    await expect(
      harness.service.create({
        ...input(harness),
        prd: standardPrd(
          'The owner attaches a file to a task. `capability:user-owned-crud` `capability:file-upload`',
        ),
      }),
    ).rejects.toMatchObject({ name: 'ApplicationEnvelopeRejectedError' });
  });

  it('pins the approved revision on the run and persists a diff on revision', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));

    const revised = await harness.service.revisePrd(project.id, { prd: 'Build it differently' });
    const lineage = (await harness.events.list(project.id)).find(
      (event) => event.type === 'prd.revised',
    );
    expect(lineage?.data).toMatchObject({
      identity: revised.identity,
      parentIdentity: prdIdentity('Build it'),
      revision: 2,
    });
    expect(String((lineage?.data as { diff?: string }).diff)).toContain('-Build it');
    expect(String((lineage?.data as { diff?: string }).diff)).toContain('+Build it differently');

    const approved = await harness.service.approvePrd(project.id, {
      identity: revised.identity,
      actor,
    });
    expect(approved.run.prd).toMatchObject({ name: 'prd', revision: 2 });
    expect((await harness.runs.get(approved.run.id))?.prd).toMatchObject({
      name: 'prd',
      revision: 2,
    });
  });

  it('reconciles workspace and lineage when a revision replay follows a partial write', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));

    // Simulate a crash after the artifact write but before workspace/event
    // writes: revision 2 exists, no prd.revised event, workspace stale.
    await harness.artifacts.put({
      projectId: project.id,
      name: 'prd',
      content: 'Build it differently',
      contentType: 'text/markdown',
      createdBy: 'user',
      expectedRevision: 1,
    });
    expect(
      (await harness.events.list(project.id)).filter((event) => event.type === 'prd.revised'),
    ).toHaveLength(0);

    const replay = await harness.service.revisePrd(project.id, { prd: 'Build it differently' });

    expect(replay.revision).toBe(2);
    const revisedEvents = (await harness.events.list(project.id)).filter(
      (event) => event.type === 'prd.revised',
    );
    expect(revisedEvents).toHaveLength(1);
    expect(revisedEvents[0]?.data).toMatchObject({
      identity: prdIdentity('Build it differently'),
      parentIdentity: prdIdentity('Build it'),
      revision: 2,
    });

    // Replaying again never duplicates the event or diff.
    await harness.service.revisePrd(project.id, { prd: 'Build it differently' });
    expect(
      (await harness.events.list(project.id)).filter((event) => event.type === 'prd.revised'),
    ).toHaveLength(1);
  });

  it('converges concurrent identical approvals to one enqueue with both callers fulfilled', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    const identity = prdIdentity('Build it');

    const results = await Promise.allSettled([
      harness.service.approvePrd(project.id, { identity, actor }),
      harness.service.approvePrd(project.id, { identity, actor }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(harness.enqueued).toHaveLength(1);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('queued');
  });

  it('converges concurrent identical revisions with both callers fulfilled', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));

    const results = await Promise.allSettled([
      harness.service.revisePrd(project.id, { prd: 'Build it differently' }),
      harness.service.revisePrd(project.id, { prd: 'Build it differently' }),
    ]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect((await harness.artifacts.getLatest(project.id, 'prd'))?.metadata.revision).toBe(2);
    expect(
      (await harness.events.list(project.id)).filter((event) => event.type === 'prd.revised'),
    ).toHaveLength(1);
  });

  it('serializes approval behind a revision before reading or publishing a job', async () => {
    const harness = makeHarness();
    const project = await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    let releaseRevision!: () => void;
    let revisionCasReached!: () => void;
    const revisionPaused = new Promise<void>((resolve) => {
      revisionCasReached = resolve;
    });
    const continueRevision = new Promise<void>((resolve) => {
      releaseRevision = resolve;
    });
    harness.runs.onAfterUpdate = async (run) => {
      if (run.status === 'awaiting_approval' && run.version === 3) {
        revisionCasReached();
        await continueRevision;
      }
    };

    const revision = harness.service.revisePrd(project.id, { prd: 'Build it differently' });
    await revisionPaused;
    const approval = harness.service.approvePrd(project.id, {
      identity: prdIdentity('Build it'),
      actor,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(harness.enqueued).toEqual([]);
    releaseRevision();
    await expect(revision).resolves.toMatchObject({ revision: 2 });
    await expect(approval).rejects.toMatchObject({ name: 'PrdApprovalConflictError' });
    expect(harness.enqueued).toEqual([]);
  });
});

describe('PRD approval gate (#602) — enqueue surfaces', () => {
  const input = (harness: ReturnType<typeof makeHarness>) => ({
    name: 'Issue Radar',
    prd: 'Build it',
    workflowId: harness.workflow.id,
    projectDirectory: '/operator/projects/issue-radar',
  });

  it('refuses to retry a project that was never approved and enqueues nothing', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));

    await expect(harness.service.retry(project.id)).rejects.toMatchObject({
      name: 'ValidationError',
    });
    expect(harness.enqueued).toEqual([]);
    expect(await harness.artifacts.getLatest(project.id, 'prd-approval')).toBeNull();
  });

  it('routes retry({prompt}) through a real PRD revision while awaiting approval, without enqueueing', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));

    const retried = await harness.service.retry(project.id, { prompt: 'Build it differently' });

    expect(harness.enqueued).toEqual([]);
    expect(retried.status).toBe('awaiting_approval');
    expect((await harness.artifacts.getLatest(project.id, 'prd'))?.metadata.revision).toBe(2);
    expect((await harness.artifacts.getLatest(project.id, 'prd'))?.content).toBe(
      'Build it differently',
    );
  });

  it('refuses to retry while Blocking Questions are unresolved and enqueues nothing', async () => {
    const base = makeHarness();
    const harness = makeHarness({}, undefined, { workflow: { ...base.workflow, stack: 'nextjs' } });
    const project = await harness.service.create({
      ...input(harness),
      prd: VALID_STANDARD_PRD.replace(
        '- **FR-001**: The owner can create a task. `capability:user-owned-crud`',
        '- **FR-001**: The owner syncs via quantum link. `capability:quantum-sync`',
      ),
    });

    await expect(harness.service.retry(project.id)).rejects.toMatchObject({
      name: 'ValidationError',
    });
    expect(harness.enqueued).toEqual([]);
  });

  it('retries a failed run with a current approval and pins the approved revision', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    expect(harness.enqueued).toHaveLength(1);
    const firstRun = (await harness.runs.get(project.currentRunId!))!;
    await harness.runs.update(
      { ...firstRun, status: 'failed', error: { name: 'ExecutionError', message: 'boom' } },
      firstRun.version,
    );
    await harness.projects.update(
      { ...(await harness.projects.get(project.id))!, status: 'failed', error: 'boom' },
      (await harness.projects.get(project.id))!.version,
    );

    const retried = await harness.service.retry(project.id);

    expect(retried.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(2);
    const retriedRun = await harness.runs.get(retried.currentRunId!);
    expect(retriedRun?.prd).toMatchObject({ name: 'prd', revision: 1 });
  });

  it('reopens approval instead of enqueueing when a failed run has no current approval', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    const firstRun = (await harness.runs.get(project.currentRunId!))!;
    await harness.runs.update(
      { ...firstRun, status: 'failed', error: { name: 'ExecutionError', message: 'boom' } },
      firstRun.version,
    );
    await harness.projects.update(
      { ...(await harness.projects.get(project.id))!, status: 'failed', error: 'boom' },
      (await harness.projects.get(project.id))!.version,
    );

    const retried = await harness.service.retry(project.id, { prompt: 'Build it differently' });

    expect(retried.status).toBe('awaiting_approval');
    expect(harness.enqueued).toHaveLength(1); // only the original approval's job
    expect((await harness.artifacts.getLatest(project.id, 'prd'))?.metadata.revision).toBe(2);
    const events = await harness.events.list(project.id);
    expect(events.some((event) => event.type === 'prd.approval_reopened')).toBe(true);
  });

  it('holds the project lock across retry approval check and queued-run persistence', async () => {
    const lock = new InProcessProjectMutationLock();
    const harness = makeHarness({}, undefined, { lock });
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    const firstRun = (await harness.runs.get(project.currentRunId!))!;
    await harness.runs.update(
      { ...firstRun, status: 'failed', error: { name: 'ExecutionError', message: 'boom' } },
      firstRun.version,
    );
    await harness.projects.update(
      { ...(await harness.projects.get(project.id))!, status: 'failed', error: 'boom' },
      (await harness.projects.get(project.id))!.version,
    );

    const order: string[] = [];
    let lockedRevision: Promise<void> | undefined;
    const originalGetLatest = harness.artifacts.getLatest.bind(harness.artifacts);
    const originalPut = harness.artifacts.put.bind(harness.artifacts);
    harness.artifacts.getLatest = async (artifactProjectId, name) => {
      const artifact = await originalGetLatest(artifactProjectId, name);
      if (name === 'prd-approval' && lockedRevision === undefined) {
        // A lock-abiding PRD writer (what revisePrd is) arrives mid-check…
        lockedRevision = lock.runExclusive(project.id, async () => {
          await originalPut({
            projectId: project.id,
            name: 'prd',
            content: 'revised prd',
            contentType: 'text/markdown',
            createdBy: 'user',
          });
          order.push('prd-revised');
        });
        // …and this yield would let it land between check and persistence
        // if retry's queued-run section did not hold the same lock.
        await new Promise((resolve) => setImmediate(resolve));
      }
      return artifact;
    };
    const originalCreate = harness.runs.create.bind(harness.runs);
    harness.runs.create = (run) => {
      order.push('run-persisted');
      return originalCreate(run);
    };

    const retried = await harness.service.retry(project.id);
    await lockedRevision;

    // #602 clarification: nothing may be persisted as queued once its approval
    // is obsolete — the run must land before the revision writer gets in.
    expect(order).toEqual(['run-persisted', 'prd-revised']);
    expect(retried.status).toBe('queued');
    expect((await harness.runs.get(retried.currentRunId!))!.prd).toMatchObject({
      name: 'prd',
      revision: 1,
    });
    expect((await harness.artifacts.getLatest(project.id, 'prd'))!.metadata.revision).toBe(2);
  });

  it('keeps retry({prompt}) atomic against a concurrent approval of the PRD it replaces', async () => {
    const lock = new InProcessProjectMutationLock();
    const harness = makeHarness({}, undefined, { lock });
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    const staleIdentity = prdIdentity(
      String((await harness.artifacts.getLatest(project.id, 'prd'))!.content),
    );
    const enqueuedBefore = harness.enqueued.length;
    const firstRun = (await harness.runs.get(project.currentRunId!))!;
    await harness.runs.update(
      { ...firstRun, status: 'failed', error: { name: 'ExecutionError', message: 'boom' } },
      firstRun.version,
    );
    await harness.projects.update(
      { ...(await harness.projects.get(project.id))!, status: 'failed', error: 'boom' },
      (await harness.projects.get(project.id))!.version,
    );

    const order: string[] = [];
    let approval: Promise<unknown> | undefined;
    const originalPut = harness.artifacts.put.bind(harness.artifacts);
    harness.artifacts.put = async (artifactInput) => {
      const stored = await originalPut(artifactInput);
      if (artifactInput.name === 'prd') order.push('prd-revised');
      return stored;
    };
    const originalGetLatest = harness.artifacts.getLatest.bind(harness.artifacts);
    harness.artifacts.getLatest = async (artifactProjectId, name) => {
      const artifact = await originalGetLatest(artifactProjectId, name);
      if (name === 'prd-approval' && approval === undefined) {
        // An approval of the revision the caller is replacing arrives mid-retry.
        // It obeys the lock, so it may only land after the whole retry section.
        approval = harness.service
          .approvePrd(project.id, {
            identity: staleIdentity,
            actor: { kind: 'user', id: 'operator' },
          })
          .then(
            () => order.push('approved'),
            (error: Error) => order.push(`approve-rejected:${error.name}`),
          );
        await new Promise((resolve) => setImmediate(resolve));
      }
      return artifact;
    };

    const retried = await harness.service.retry(project.id, { prompt: 'Build it differently' });
    await approval;

    // #602: the revision has to land before the stale approval is even
    // evaluated, and the replaced PRD must never reach the queue.
    expect(order).toEqual(['prd-revised', 'approve-rejected:PrdApprovalConflictError']);
    expect(retried.status).toBe('awaiting_approval');
    expect((await harness.artifacts.getLatest(project.id, 'prd'))!.metadata.revision).toBe(2);
    expect(harness.enqueued).toHaveLength(enqueuedBefore);
  });

  it('executes steps against the pinned approved revision even after a newer revision lands', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    const run = (await harness.runs.get(project.currentRunId!))!;
    expect(run.prd).toMatchObject({ name: 'prd', revision: 1 });
    // A newer revision lands after approval (the race the pin closes): the
    // step below must still read revision 1, never 'latest'.
    await harness.artifacts.put({
      projectId: project.id,
      name: 'prd',
      content: 'Unapproved newer revision',
      contentType: 'text/markdown',
      createdBy: 'user',
      expectedRevision: 1,
    });
    await harness.runs.update({ ...run, status: 'running' }, run.version);

    await (harness.orchestrator as unknown as HasExecuteStep).executeStep(
      (await harness.projects.get(project.id))!,
      harness.workflow,
      {
        ...(harness.workflow.nodes[0] as unknown as ExecutableStep),
        id: 'plan-from-prd',
        inputArtifacts: ['prd'],
      } as ExecutableStep,
      run.id,
      'plan',
      new AbortController().signal,
    );

    const request = harness.executor.requests.find((entry) => entry.stepId === 'plan-from-prd');
    expect(request?.inputArtifacts).toEqual([
      expect.objectContaining({ name: 'prd', revision: 1 }),
    ]);
  });

  it('pins for-each-task implement inputs to the approved revision, never latest', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    const run = (await harness.runs.get(project.currentRunId!))!;
    expect(run.prd).toMatchObject({ name: 'prd', revision: 1 });
    // The same race as above, through the other enqueue-to-execution path:
    // for-each-task resolves its implement inputs before the step boundary,
    // so an unapproved newer revision must not survive to the executor.
    await harness.artifacts.put({
      projectId: project.id,
      name: 'prd',
      content: 'Unapproved newer revision',
      contentType: 'text/markdown',
      createdBy: 'user',
      expectedRevision: 1,
    });
    await harness.runs.update({ ...run, status: 'running' }, run.version);
    await harness.artifacts.put({
      projectId: project.id,
      name: 'plan.current',
      content: {
        schemaVersion: '1',
        status: 'completed',
        summary: 'Planned.',
        data: {
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
        },
      },
      createdBy: 'agent',
    });
    const workflow: WorkflowDefinition = WorkflowDefinitionSchema.parse({
      schemaVersion: '1',
      id: 'task-graph-pin-v1',
      name: 'Task graph pin fixture',
      description: 'for-each-task implement inputs must load the pinned PRD revision.',
      stack: 'node',
      nodes: [
        {
          id: 'plan',
          type: 'agent',
          role: 'planner',
          taskKind: 'planning',
          title: 'Plan',
          instructions: 'Plan tasks.',
          outputArtifact: 'plan.current',
        },
        {
          id: 'task-execution',
          type: 'for-each-task',
          title: 'Implement tasks',
          taskGraphArtifact: 'plan.current',
          implement: {
            id: 'implement-task',
            type: 'agent',
            role: 'developer',
            taskKind: 'implementation',
            title: 'Implement task',
            instructions: 'Implement the task.',
            inputArtifacts: ['prd', 'plan.current'],
            outputArtifact: 'implementation.report',
            mutatesWorkspace: true,
            maxAttempts: 1,
          },
        },
      ],
    });

    await (
      harness.orchestrator as unknown as { taskGraphRunner: TaskGraphRunner }
    ).taskGraphRunner.run({
      project: (await harness.projects.get(project.id))!,
      workflow,
      node: workflow.nodes[1] as ForEachTaskStep,
      runId: run.id,
      signal: new AbortController().signal,
    });

    const prdInputs = harness.executor.requests
      .flatMap((request) => request.inputArtifacts ?? [])
      .filter((reference) => reference.name === 'prd');
    expect(prdInputs.length).toBeGreaterThan(0);
    for (const reference of prdInputs) expect(reference).toMatchObject({ revision: 1 });
  });

  it('refuses an unapproved queued PRD run before provisioning or agent execution', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    const run = (await harness.runs.get(project.currentRunId!))!;
    const queuedRun = await harness.runs.update({ ...run, status: 'queued' }, run.version);
    const currentProject = (await harness.projects.get(project.id))!;
    await harness.projects.update({ ...currentProject, status: 'queued' }, currentProject.version);

    await expect(
      harness.orchestrator.runProject(project.id, harness.workflow.id, queuedRun.id),
    ).rejects.toThrow(/approved PRD pin|approval/i);

    expect(harness.executor.requests).toEqual([]);
  });

  it('refuses a queued PRD run when stored content no longer matches the approved pin hash', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    const prd = harness.artifacts.named('prd')[0]!;
    prd.content = 'tampered after approval';

    await expect(
      harness.orchestrator.runProject(project.id, harness.workflow.id, project.currentRunId!),
    ).rejects.toThrow(/pinned reference/i);

    expect(harness.executor.requests).toEqual([]);
  });

  it('refuses a queued PRD run when its approved markdown becomes structured content', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    harness.artifacts.named('prd')[0]!.content = { tampered: true };

    await expect(
      harness.orchestrator.runProject(project.id, harness.workflow.id, project.currentRunId!),
    ).rejects.toThrow(/approved PRD pin/i);

    expect(harness.executor.requests).toEqual([]);
  });

  it('refuses a queued run whose approved PRD pin names another artifact', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    const other = await harness.artifacts.put({
      projectId: project.id,
      name: 'other',
      content: 'Build it',
      contentType: 'text/markdown',
      createdBy: 'user',
    });
    const run = (await harness.runs.get(project.currentRunId!))!;
    await harness.runs.update(
      {
        ...run,
        prd: {
          name: other.metadata.name,
          revision: other.metadata.revision,
          sha256: other.metadata.sha256,
        },
      },
      run.version,
    );

    await expect(
      harness.orchestrator.runProject(project.id, harness.workflow.id, project.currentRunId!),
    ).rejects.toThrow(/approved PRD pin/i);

    expect(harness.executor.requests).toEqual([]);
  });

  it('refuses queue republication on recovery when the queued state has no current approval', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    harness.enqueued.length = 0;
    // Corrupt the state the way a legacy/pre-#602 disk would look: queued
    // rows but an approval that no longer matches the latest PRD.
    const approval = (await harness.artifacts.getLatest(project.id, 'prd-approval'))!;
    // Canonical key for the mismatched identity, so the refusal below comes
    // from the identity check itself, not from a missing integrity binding.
    await harness.artifacts.put({
      projectId: project.id,
      name: 'prd-approval',
      content: { ...(approval.content as Record<string, unknown>), identity: 'f'.repeat(64) },
      createdBy: 'user',
      idempotencyKey: createHash('sha256')
        .update(`${'f'.repeat(64)}:1`)
        .digest('hex'),
    });

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('failed');
    expect((await harness.projects.get(project.id))?.status).toBe('failed');
    const events = await harness.events.list(project.id);
    expect(events.some((event) => event.type === 'project.queue_publication_refused')).toBe(true);
  });

  it('refuses queue republication on recovery when the queued run has no PRD pin', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    harness.enqueued.length = 0;
    const run = (await harness.runs.get(project.currentRunId!))!;
    await harness.runs.update({ ...run, prd: undefined }, run.version);

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('failed');
    expect((await harness.projects.get(project.id))?.status).toBe('failed');
    const events = await harness.events.list(project.id);
    expect(events.some((event) => event.type === 'project.queue_publication_refused')).toBe(true);
  });

  it('refuses queue republication when the queued pin names another artifact', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    harness.enqueued.length = 0;
    const other = await harness.artifacts.put({
      projectId: project.id,
      name: 'other',
      content: 'Build it',
      contentType: 'text/markdown',
      createdBy: 'user',
    });
    const run = (await harness.runs.get(project.currentRunId!))!;
    await harness.runs.update(
      {
        ...run,
        prd: {
          name: other.metadata.name,
          revision: other.metadata.revision,
          sha256: other.metadata.sha256,
        },
      },
      run.version,
    );

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('failed');
    expect((await harness.projects.get(project.id))?.status).toBe('failed');
  });

  it('refuses recovery when approved markdown becomes an object with the same string coercion', async () => {
    const harness = makeHarness();
    const project = await harness.service.create({
      ...input(harness),
      prd: '[object Object]',
    });
    await approveCurrentPrd(harness, project.id);
    harness.enqueued.length = 0;
    harness.artifacts.named('prd')[0]!.content = {};

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('failed');
    expect((await harness.projects.get(project.id))?.status).toBe('failed');
  });

  it('refuses recovery when a forged approval matches tampered PRD text but not its digest', async () => {
    const harness = makeHarness();
    const project = await harness.service.create(input(harness));
    await approveCurrentPrd(harness, project.id);
    harness.enqueued.length = 0;
    harness.artifacts.named('prd')[0]!.content = 'Tampered after approval';
    // Well-formed forgery with its canonical key: the refusal below must come
    // from the PRD digest check, not from approval shape/integrity validation.
    await harness.artifacts.put({
      projectId: project.id,
      name: 'prd-approval',
      content: {
        schemaVersion: '1',
        identity: prdIdentity('Tampered after approval'),
        prdRevision: 1,
      },
      createdBy: 'attacker',
      idempotencyKey: createHash('sha256')
        .update(`${prdIdentity('Tampered after approval')}:1`)
        .digest('hex'),
    });

    await harness.service.recoverQueuedProjects();

    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('failed');
    expect((await harness.projects.get(project.id))?.status).toBe('failed');
  });
});

describe('PRD approval crash convergence (#602)', () => {
  it('refuses to replay approval for a queued run whose PRD pin is missing', async () => {
    const harness = makeHarness();
    const project = await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    await approveCurrentPrd(harness, project.id);
    harness.enqueued.length = 0;
    const run = (await harness.runs.get(project.currentRunId!))!;
    await harness.runs.update({ ...run, prd: undefined }, run.version);

    await expect(approveCurrentPrd(harness, project.id)).rejects.toThrow(/PRD pin/i);

    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('failed');
    expect((await harness.projects.get(project.id))?.status).toBe('failed');
    expect((await harness.events.list(project.id)).map((event) => event.type)).toContain(
      'project.queue_publication_refused',
    );
  });

  it('re-approval converges project state and queue after a partial file-mode commit', async () => {
    const harness = makeHarness();
    const project = await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
      projectDirectory: '/operator/projects/issue-radar',
    });
    vi.spyOn(harness.projects, 'update').mockRejectedValueOnce(new Error('project row lost'));

    await expect(approveCurrentPrd(harness, project.id)).rejects.toThrow('project row lost');
    expect(harness.enqueued).toEqual([]);
    expect((await harness.runs.get(project.currentRunId!))?.status).toBe('queued');
    expect((await harness.projects.get(project.id))?.status).toBe('awaiting_approval');

    const replay = await approveCurrentPrd(harness, project.id);

    expect(replay.project.status).toBe('queued');
    expect((await harness.projects.get(project.id))?.status).toBe('queued');
    expect(harness.enqueued).toHaveLength(1);
  });
});
