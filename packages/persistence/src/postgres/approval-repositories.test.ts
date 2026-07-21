import { expect, it } from 'vitest';
import type {
  ApprovalDecision,
  ApprovalRequest,
  Project,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  PostgresApprovalDecisionRepository,
  PostgresApprovalRequestRepository,
} from './approval-repositories.js';
import { PostgresProjectRepository } from './project-repository.js';
import { PostgresWorkflowRunRepository } from './run-repositories.js';
import { describePostgres } from './testing.js';

const createdAt = '2026-07-14T12:00:00.000Z';

function project(id = 'project-1'): Project {
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

function request(id = 'approval-1', runId = 'run-1', stepRunId = 'step-run-1'): ApprovalRequest {
  return {
    id,
    runId,
    stepRunId,
    nodeId: 'review-gate',
    artifact: { name: 'plan', revision: 1, sha256: 'a'.repeat(64) },
    allowedActions: ['approve', 'reject'],
    createdAt,
  };
}

function decision(
  id = 'decision-1',
  requestId = 'approval-1',
  runId = 'run-1',
  stepRunId = 'step-run-1',
): ApprovalDecision {
  return {
    id,
    requestId,
    runId,
    stepRunId,
    action: 'approve',
    decidedBy: 'ed',
    decidedAt: createdAt,
  };
}

describePostgres('Postgres approval repositories', (ctx) => {
  it('creates, gets, and lists approval requests, including getForStepRun', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    await new PostgresWorkflowRunRepository(sql).create(workflowRun());
    const requests = new PostgresApprovalRequestRepository(sql);

    await requests.create(request());
    await requests.create(request('approval-2', 'run-1', 'step-run-2'));

    expect(await requests.get('run-1', 'approval-1')).toEqual(request());
    expect(await requests.getForStepRun('run-1', 'step-run-2')).toMatchObject({
      id: 'approval-2',
    });
    expect(await requests.getForStepRun('run-1', 'no-such-step')).toBeNull();
    expect((await requests.list('run-1')).map((item) => item.id)).toEqual([
      'approval-1',
      'approval-2',
    ]);
  });

  it('rejects a second creation of the same request', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    await new PostgresWorkflowRunRepository(sql).create(workflowRun());
    const requests = new PostgresApprovalRequestRepository(sql);

    await requests.create(request());
    await expect(requests.create(request())).rejects.toThrow(/already exists/);
  });

  it('rejects an approval request for a workflow run that does not exist (FK violation)', async () => {
    const sql = ctx.db();
    const requests = new PostgresApprovalRequestRepository(sql);

    await expect(requests.create(request())).rejects.toThrow();
  });

  it('records decisions linked to requests and enforces at most one decision per request', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    await new PostgresWorkflowRunRepository(sql).create(workflowRun());
    const requests = new PostgresApprovalRequestRepository(sql);
    const decisions = new PostgresApprovalDecisionRepository(sql);
    await requests.create(request());

    await decisions.create(decision());
    expect(await decisions.get('run-1', 'approval-1')).toEqual(decision());
    expect(await decisions.get('run-1', 'approval-2')).toBeNull();

    await expect(decisions.create(decision())).rejects.toThrow(/already has a decision/);
  });

  it('rejects a decision for an approval request that does not exist (FK violation)', async () => {
    const sql = ctx.db();
    const decisions = new PostgresApprovalDecisionRepository(sql);

    await expect(decisions.create(decision())).rejects.toThrow();
  });
});
