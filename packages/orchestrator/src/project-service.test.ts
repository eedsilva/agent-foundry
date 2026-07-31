import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment, PreviewSession, PreviewWorkspaceRef } from '@agent-foundry/contracts';
import { EnvironmentOperationError, type GeneratedProjectRuntime } from '@agent-foundry/domain';
import { makeHarness, makeStores, seedRun } from './testing/harness.js';
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
        previewMigration: unused,
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

    expect(initialize).toHaveBeenCalledWith({ projectId: 'id-0001' });
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
        previewMigration: unused,
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
      }),
    ).rejects.toBe(transactionError);

    expect(harness.workspaces.cleanups).toEqual(['id-0001']);
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
    });
    await runWorker(harness);

    expect(start).toHaveBeenCalledWith({
      workspaceRef: {
        projectId: 'id-0001',
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
        failurePhase: 'start',
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
        previewMigration: unused,
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
      previews: { start, activeForProject: async () => previewSession() },
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
    });
    await runWorker(harness);

    expect(start).not.toHaveBeenCalled();
    expect(
      (await harness.events.list('id-0001')).some((event) => event.type === 'project.provisioned'),
    ).toBe(true);
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
    });

    expect(harness.workspaces.lastScaffoldFiles).toEqual([]);
    expect(await harness.artifacts.getLatest('id-0001', 'scaffold-manifest')).toBeNull();
  });
});
