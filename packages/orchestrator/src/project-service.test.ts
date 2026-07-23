import { describe, expect, it, vi } from 'vitest';
import type { AppEnvironment } from '@agent-foundry/contracts';
import type { GeneratedProjectRuntime } from '@agent-foundry/domain';
import { makeHarness, makeStores, seedRun } from './testing/harness.js';

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
  it('initializes the generated-project runtime before persisting a new project', async () => {
    const stores = makeStores();
    const initialize = vi.fn(async ({ projectId }: { projectId: string }) => {
      expect(await stores.projects.get(projectId)).toBeNull();
      return ENVIRONMENT;
    });
    const unused = () => Promise.reject(new Error('unused test runtime operation'));
    const harness = makeHarness({}, stores, {
      generatedProjectRuntime: {
        initialize,
        start: unused,
        stop: unused,
        inspect: unused,
        migrate: unused,
        seed: unused,
        health: unused,
        reset: unused,
        cleanup: unused,
      } satisfies GeneratedProjectRuntime,
    });

    await harness.service.create({
      name: 'Issue Radar',
      prd: 'Build it',
      workflowId: harness.workflow.id,
    });

    expect(initialize).toHaveBeenCalledWith({ projectId: 'id-0001' });
  });
});
