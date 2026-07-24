import { expect, it } from 'vitest';
import type { Project, QueueJob, WorkflowRun } from '@agent-foundry/contracts';
import { describePostgres } from './testing.js';
import { PostgresTransactionRunner } from './transaction-runner.js';
import { PostgresProjectRepository } from './project-repository.js';
import { PostgresWorkflowRunRepository } from './run-repositories.js';
import { PostgresEventStore } from './event-store.js';
import { PostgresJobQueue } from './job-queue.js';

const now = '2026-07-14T12:00:00.000Z';

function project(): Project {
  return {
    id: 'project-1',
    name: 'Test Project',
    workflowId: 'web-app-v1',
    policyId: 'default',
    status: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
    currentRunId: 'run-1',
  };
}

function run(): WorkflowRun {
  return {
    id: 'run-1',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    status: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function job(): QueueJob {
  return {
    id: 'job-1',
    type: 'run-project',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    runId: 'run-1',
    attempts: 0,
    maxAttempts: 2,
    createdAt: now,
    availableAt: now,
    leaseEpoch: 0,
  };
}

describePostgres('transactional seam atomicity', (ctx) => {
  it('a failure mid-transaction persists no project, no run, no event, and no job', async () => {
    const sql = ctx.db();
    const runner = new PostgresTransactionRunner(sql);
    const projects = new PostgresProjectRepository(sql);
    const runs = new PostgresWorkflowRunRepository(sql);
    const events = new PostgresEventStore(sql);
    const queue = new PostgresJobQueue(sql, {
      leaseMs: 60_000,
      clock: { now: () => new Date(now) },
    });

    await expect(
      runner.run(async (tx) => {
        await projects.create(project(), tx);
        await runs.create(run(), tx);
        await events.append(
          {
            id: 'event-1',
            projectId: 'project-1',
            type: 'project.created',
            createdAt: now,
            message: 'created',
            data: {},
          },
          tx,
        );
        await queue.enqueue(job(), tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await projects.get('project-1')).toBeNull();
    expect(await events.list('project-1')).toHaveLength(0);
    const [jobRow] = await sql<{ id: string }[]>`select id from jobs where id = 'job-1'`;
    expect(jobRow).toBeUndefined();
  });

  it('a committed transaction persists the project, run, event, and job atomically', async () => {
    const sql = ctx.db();
    const runner = new PostgresTransactionRunner(sql);
    const projects = new PostgresProjectRepository(sql);
    const runs = new PostgresWorkflowRunRepository(sql);
    const events = new PostgresEventStore(sql);
    const queue = new PostgresJobQueue(sql, {
      leaseMs: 60_000,
      clock: { now: () => new Date(now) },
    });

    await runner.run(async (tx) => {
      await projects.create(project(), tx);
      await runs.create(run(), tx);
      await events.append(
        {
          id: 'event-1',
          projectId: 'project-1',
          type: 'project.created',
          createdAt: now,
          message: 'created',
          data: {},
        },
        tx,
      );
      await queue.enqueue(job(), tx);
    });

    expect(await projects.get('project-1')).not.toBeNull();
    expect(await events.list('project-1')).toHaveLength(1);
    const [jobRow] = await sql<{ id: string }[]>`select id from jobs where id = 'job-1'`;
    expect(jobRow?.id).toBe('job-1');
  });
});
