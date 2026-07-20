import { expect, it } from 'vitest';
import type { Project, StepAttempt, StepRun, WorkflowRun } from '@agent-foundry/contracts';
import { NotFoundError, VersionConflictError } from '@agent-foundry/domain';
import { PostgresProjectRepository } from './project-repository.js';
import {
  PostgresStepAttemptRepository,
  PostgresStepRunRepository,
  PostgresWorkflowRunRepository,
} from './run-repositories.js';
import { describePostgres } from './testing.js';

const createdAt = '2026-07-14T12:00:00.000Z';

function makeProject(id = 'project-1'): Project {
  return {
    id,
    name: 'Project',
    workflowId: 'web-app-v1',
    policyId: 'default',
    status: 'queued',
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

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

function attempt(
  id = 'attempt-1',
  runId = 'run-1',
  stepRunId = 'step-run-1',
  sequence = 1,
): StepAttempt {
  return {
    id,
    runId,
    stepRunId,
    sequence,
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

describePostgres('Postgres run/step/attempt repositories', (ctx) => {
  it('creates, gets, updates, and parent-filters runs, steps, and attempts', async () => {
    const sql = ctx.db();
    const projects = new PostgresProjectRepository(sql);
    const runs = new PostgresWorkflowRunRepository(sql);
    const steps = new PostgresStepRunRepository(sql);
    const attempts = new PostgresStepAttemptRepository(sql);

    await projects.create(makeProject('project-1'));
    await projects.create(makeProject('project-2'));
    await runs.create(workflowRun('run-1', 'project-1'));
    await runs.create(workflowRun('run-2', 'project-2'));
    await steps.create(stepRun('step-run-1', 'run-1'));
    // Create attempts out of sequence order to prove list() sorts by sequence, not insert order.
    await attempts.create(attempt('attempt-2', 'run-1', 'step-run-1', 2));
    await attempts.create(attempt('attempt-1', 'run-1', 'step-run-1', 1));

    const updatedStep = await steps.update(
      { ...stepRun('step-run-1', 'run-1'), status: 'running', startedAt: createdAt },
      1,
    );
    const updatedAttempt = await attempts.update(
      {
        ...attempt('attempt-1', 'run-1', 'step-run-1', 1),
        status: 'succeeded',
        completedAt: '2026-07-14T12:02:00.000Z',
        updatedAt: '2026-07-14T12:02:00.000Z',
      },
      1,
    );

    expect(await runs.get('run-1')).toEqual(workflowRun('run-1', 'project-1'));
    expect(updatedStep).toMatchObject({ status: 'running', version: 2 });
    expect(await steps.get('run-1', 'step-run-1')).toEqual(updatedStep);
    expect(updatedAttempt).toMatchObject({ status: 'succeeded', version: 2 });
    expect(await attempts.get('run-1', 'step-run-1', 'attempt-1')).toEqual(updatedAttempt);

    expect((await runs.list('project-1')).map((run) => run.id)).toEqual(['run-1']);
    expect((await steps.list('run-1')).map((step) => step.id)).toEqual(['step-run-1']);
    expect((await attempts.list('run-1', 'step-run-1')).map((item) => item.id)).toEqual([
      'attempt-1',
      'attempt-2',
    ]);
  });

  it('rejects create with a non-1 version and rejects duplicate run ids', async () => {
    const sql = ctx.db();
    const projects = new PostgresProjectRepository(sql);
    const runs = new PostgresWorkflowRunRepository(sql);
    await projects.create(makeProject('project-1'));

    await expect(runs.create({ ...workflowRun(), version: 2 })).rejects.toThrow(/version 1/i);

    await runs.create(workflowRun());

    await expect(runs.create(workflowRun())).rejects.toThrow(/already exists/i);
  });

  it('allows exactly one concurrent CAS update for a run at the same expected version', async () => {
    const sql = ctx.db();
    const projects = new PostgresProjectRepository(sql);
    const runs = new PostgresWorkflowRunRepository(sql);
    await projects.create(makeProject('project-1'));
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
    const rejected = results.find((result) => result.status === 'rejected') as
      PromiseRejectedResult | undefined;
    expect(rejected?.reason).toBeInstanceOf(VersionConflictError);
    expect(rejected?.reason).toMatchObject({ actualVersion: 2 });
    expect((await runs.get('run-1'))?.version).toBe(2);
  });

  it('throws NotFoundError when updating a run that does not exist', async () => {
    const sql = ctx.db();
    const runs = new PostgresWorkflowRunRepository(sql);

    await expect(runs.update(workflowRun(), 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects creating a workflow run whose project does not exist (FK violation)', async () => {
    const sql = ctx.db();
    const runs = new PostgresWorkflowRunRepository(sql);

    await expect(runs.create(workflowRun('run-x', 'missing-project'))).rejects.toThrow(
      /workflow_runs/,
    );
  });
});
