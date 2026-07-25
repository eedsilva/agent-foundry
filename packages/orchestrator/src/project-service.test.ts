import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '@agent-foundry/contracts';
import type { GeneratedProjectRuntime } from '@agent-foundry/domain';
import { FileWorkspaceManager } from '@agent-foundry/persistence';
import { SupabaseGeneratedProjectRuntime } from '@agent-foundry/platform';
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
    const diagnostic = 'supabase start failed: raw CLI/container output';
    const initialize = vi.fn().mockRejectedValue(new Error(diagnostic));
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
      error: { code: 'PROJECT_PROVISIONING_FAILED', message: diagnostic },
    });
    const events = await harness.events.list('id-0001');
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'project.provisioning_started' }),
        expect.objectContaining({
          type: 'project.provisioning_failed',
          message: 'Project provisioning failed. Review the project event timeline for details.',
          data: { diagnostic },
        }),
      ]),
    );
    expect(harness.nacked).toHaveLength(1);
  });

  it('removes every initialized project resource when project persistence fails', async () => {
    const transactionError = new Error('project transaction failed');
    const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-project-service-'));
    const stores = makeStores();
    stores.projects.create = () => Promise.reject(transactionError);
    const workspaces = new FileWorkspaceManager(dataDir, {
      gitAuthorName: 'Test Agent',
      gitAuthorEmail: 'test@example.com',
    });
    (stores as unknown as { workspaces: FileWorkspaceManager }).workspaces = workspaces;
    const runtime = new SupabaseGeneratedProjectRuntime({
      dataDir,
      command: async (...args) => {
        const workdir = args[args.indexOf('--workdir') + 1];
        if (args[0] === 'init' && workdir) {
          await mkdir(join(workdir, 'supabase', 'migrations'), { recursive: true });
          await writeFile(
            join(workdir, 'supabase', 'config.toml'),
            `project_id = "environment"\n\n[api]\nport = 54321\n\n[db]\nport = 54322\nshadow_port = 54320\n\n[db.pooler]\nenabled = false\nport = 54329\n\n[studio]\nport = 54323\n\n[inbucket]\nport = 54324\n\n[edge_runtime]\ninspector_port = 8083\n\n[analytics]\nport = 54327\n`,
          );
        }
        if (args[0] === 'status') {
          return {
            stdout: JSON.stringify({
              API_URL: 'http://127.0.0.1:54321',
              ANON_KEY: 'anon-secret',
              SERVICE_ROLE_KEY: 'service-role-secret',
            }),
            stderr: '',
            exitCode: 0,
          };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    });
    const harness = makeHarness({}, stores, { generatedProjectRuntime: runtime });
    const projectRoot = join(dataDir, 'projects', 'id-0001');

    try {
      await expect(
        harness.service.create({
          name: 'Issue Radar',
          prd: 'Build it',
          workflowId: harness.workflow.id,
        }),
      ).rejects.toBe(transactionError);

      await expect(access(join(projectRoot, 'workspace'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(join(projectRoot, 'environment'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(access(join(projectRoot, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(projectRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
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
