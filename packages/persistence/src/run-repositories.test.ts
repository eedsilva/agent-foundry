import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepAttempt, StepRun, WorkflowRun } from '@agent-foundry/contracts';
import { VersionConflictError } from '@agent-foundry/domain';
import * as persistence from './index.js';
import { atomicWriteJson } from './fs-utils.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-foundry-runs-'));
  temporaryDirectories.push(path);
  return path;
}

const createdAt = '2026-07-14T12:00:00.000Z';

function workflowRun(id = 'run-1', projectId = 'project-1'): WorkflowRun {
  return {
    id,
    projectId,
    workflowId: 'web-app-v1',
    status: 'queued',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function stepRun(id = 'step-run-1', runId = 'run-1'): StepRun {
  return {
    id,
    runId,
    nodeId: 'planning-loop',
    stepId: 'planner',
    stepType: 'agent',
    status: 'pending',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function attempt(id = 'attempt-1', runId = 'run-1', stepRunId = 'step-run-1'): StepAttempt {
  return {
    id,
    runId,
    stepRunId,
    sequence: 1,
    executorKind: 'agent',
    provider: 'mock',
    model: 'mock/default',
    context: {
      projectId: 'project-1',
      workflowId: 'web-app-v1',
      nodeId: 'planning-loop',
      stepId: 'planner',
    },
    status: 'running',
    version: 1,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    inputArtifacts: [],
    outputArtifacts: [],
  };
}

describe('filesystem run repositories', () => {
  it('exports separate repositories for each persisted entity', () => {
    const exported = persistence as Record<string, unknown>;
    expect(exported.FileWorkflowRunRepository).toBeDefined();
    expect(exported.FileStepRunRepository).toBeDefined();
    expect(exported.FileStepAttemptRepository).toBeDefined();
  });

  it('creates, gets, and parent-filters runs, steps, and attempts', async () => {
    const dataDir = await temporaryDataDir();
    const runs = new persistence.FileWorkflowRunRepository(dataDir);
    const steps = new persistence.FileStepRunRepository(dataDir);
    const attempts = new persistence.FileStepAttemptRepository(dataDir);

    await runs.create(workflowRun());
    await runs.create(workflowRun('run-2', 'project-2'));
    await steps.create(stepRun());
    await steps.create(stepRun('step-run-2', 'run-2'));
    await attempts.create(attempt());
    await attempts.create(attempt('attempt-2', 'run-2', 'step-run-2'));

    const updatedStep = await steps.update(
      {
        ...stepRun(),
        status: 'running',
        startedAt: '2026-07-14T12:01:00.000Z',
        updatedAt: '2026-07-14T12:01:00.000Z',
      },
      1,
    );
    const updatedAttempt = await attempts.update(
      {
        ...attempt(),
        status: 'succeeded',
        completedAt: '2026-07-14T12:02:00.000Z',
        updatedAt: '2026-07-14T12:02:00.000Z',
      },
      1,
    );

    expect(await runs.get('run-1')).toEqual(workflowRun());
    expect(updatedStep).toMatchObject({ status: 'running', version: 2 });
    expect(updatedAttempt).toMatchObject({ status: 'succeeded', version: 2 });
    expect((await runs.list('project-1')).map((run) => run.id)).toEqual(['run-1']);
    expect((await steps.list('run-1')).map((step) => step.id)).toEqual(['step-run-1']);
    expect((await attempts.list('run-1', 'step-run-1')).map((item) => item.id)).toEqual([
      'attempt-1',
    ]);
  });

  it('recovers an abandoned workflow-run lock', async () => {
    const dataDir = await temporaryDataDir();
    const lockPath = join(dataDir, 'runs', 'run-1', 'run.json.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({
        token: '11111111-1111-4111-8111-111111111111',
        pid: 2147483647,
        acquiredAt: new Date().toISOString(),
      }),
    );
    const runs = new persistence.FileWorkflowRunRepository(dataDir);

    await expect(runs.create(workflowRun())).resolves.toBeUndefined();
    await expect(stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows exactly one concurrent update for an expected version', async () => {
    const dataDir = await temporaryDataDir();
    const runs = new persistence.FileWorkflowRunRepository(dataDir);
    const queued = workflowRun();
    await runs.create(queued);
    const running: WorkflowRun = {
      ...queued,
      status: 'running',
      startedAt: '2026-07-14T12:01:00.000Z',
      updatedAt: '2026-07-14T12:01:00.000Z',
    };

    const results = await Promise.allSettled([
      runs.update(running, 1),
      runs.update({ ...running, updatedAt: '2026-07-14T12:02:00.000Z' }, 1),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(VersionConflictError) });
    expect((await runs.get('run-1'))?.version).toBe(2);
  });

  it('rejects duplicate IDs and malformed persisted state', async () => {
    const dataDir = await temporaryDataDir();
    const runs = new persistence.FileWorkflowRunRepository(dataDir);
    await runs.create(workflowRun());

    await expect(runs.create(workflowRun())).rejects.toThrow(/already exists/);
    await atomicWriteJson(join(dataDir, 'runs', 'run-1', 'run.json'), {
      ...workflowRun(),
      status: 'invented',
    });
    await expect(runs.get('run-1')).rejects.toThrow();
  });
});
