import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApprovalDecision, ApprovalRequest } from '@agent-foundry/contracts';
import * as persistence from './index.js';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-foundry-approvals-'));
  temporaryDirectories.push(path);
  return path;
}

const createdAt = '2026-07-14T12:00:00.000Z';

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

describe('filesystem approval repositories', () => {
  it('exports separate repositories for requests and decisions', () => {
    const exported = persistence as Record<string, unknown>;
    expect(exported.FileApprovalRequestRepository).toBeDefined();
    expect(exported.FileApprovalDecisionRepository).toBeDefined();
  });

  it('creates and gets approval requests and their linked decisions', async () => {
    const dataDir = await temporaryDataDir();
    const requests = new persistence.FileApprovalRequestRepository(dataDir);
    const decisions = new persistence.FileApprovalDecisionRepository(dataDir);

    await requests.create(request());
    await requests.create(request('approval-2', 'run-1', 'step-run-2'));
    await decisions.create(decision());

    expect(await requests.get('run-1', 'approval-1')).toEqual(request());
    expect(await requests.getForStepRun('run-1', 'step-run-2')).toMatchObject({
      id: 'approval-2',
    });
    expect(await requests.getForStepRun('run-1', 'no-such-step')).toBeNull();
    expect((await requests.list('run-1')).map((item) => item.id)).toEqual([
      'approval-1',
      'approval-2',
    ]);

    expect(await decisions.get('run-1', 'approval-1')).toEqual(decision());
    expect(await decisions.get('run-1', 'approval-2')).toBeNull();
  });

  it('rejects a second creation of the same request or decision', async () => {
    const dataDir = await temporaryDataDir();
    const requests = new persistence.FileApprovalRequestRepository(dataDir);
    const decisions = new persistence.FileApprovalDecisionRepository(dataDir);

    await requests.create(request());
    await expect(requests.create(request())).rejects.toThrow(/already exists/);

    await decisions.create(decision());
    await expect(decisions.create(decision())).rejects.toThrow(/already has a decision/);
  });

  it('has no update method on either repository — the data is immutable', async () => {
    const dataDir = await temporaryDataDir();
    const requests = new persistence.FileApprovalRequestRepository(dataDir);
    const decisions = new persistence.FileApprovalDecisionRepository(dataDir);

    expect((requests as unknown as { update?: unknown }).update).toBeUndefined();
    expect((decisions as unknown as { update?: unknown }).update).toBeUndefined();
  });
});
