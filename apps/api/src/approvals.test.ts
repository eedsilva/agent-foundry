import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createRuntime, type Runtime } from '@agent-foundry/composition';
import { buildApp } from './app.js';

// Self-contained fixture: an architecture-review gate and a release-review
// gate, standing in for the "architecture and release approval" E2E coverage
// issue #14 requires, without touching the real workflows/web-app-v1.yaml
// (which stays fully automated).
const FIXTURE_WORKFLOW = `
schemaVersion: '1'
id: approval-e2e-v1
name: Approval E2E fixture
description: Minimal architecture + release approval-gate pipeline for issue #14 E2E coverage.
stack: nextjs
nodes:
  - id: plan
    type: agent
    role: planner
    taskKind: planning
    title: Draft a plan
    instructions: Draft a short plan from the PRD.
    outputArtifact: plan.current

  - id: architecture
    type: agent
    role: architect
    taskKind: architecture
    title: Draft architecture
    instructions: Draft architecture notes from the plan.
    inputArtifacts: [plan.current]
    outputArtifact: architecture.current

  - id: architecture-approval
    type: approval-gate
    title: Architecture approval
    artifact: architecture.current
    outputArtifact: architecture.approval
    actions: [approve, reject, request-changes]
    onReject: return-to-step
    returnToStepId: architecture
    repairArtifact: architecture.repair-notes

  - id: build
    type: agent
    role: developer
    taskKind: implementation
    title: Implement
    instructions: Implement a small vertical slice from the approved architecture.
    inputArtifacts: [architecture.current]
    outputArtifact: implementation.report

  - id: release-approval
    type: approval-gate
    title: Release approval
    artifact: implementation.report
    outputArtifact: release.approval
    actions: [approve, reject]
`;

const apps: FastifyInstance[] = [];
const dirs: string[] = [];

interface StartedApi {
  runtime: Runtime;
  baseUrl: string;
}

async function startApi(): Promise<StartedApi> {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-foundry-approvals-data-'));
  const workflowsDir = await mkdtemp(join(tmpdir(), 'agent-foundry-approvals-wf-'));
  dirs.push(dataDir, workflowsDir);
  await writeFile(join(workflowsDir, 'approval-e2e-v1.yaml'), FIXTURE_WORKFLOW, 'utf8');

  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT: resolve(import.meta.dirname, '../../..'),
    DATA_DIR: dataDir,
    WORKFLOWS_DIR: workflowsDir,
    EXECUTOR_MODE: 'mock',
    AUTO_INSTALL_DEPENDENCIES: 'false',
    WORKER_ID: 'approvals-worker',
  });
  const app = await buildApp(runtime);
  apps.push(app);
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  return { runtime, baseUrl };
}

async function createProject(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Approval E2E',
      prd: 'x'.repeat(60),
      workflowId: 'approval-e2e-v1',
    }),
  });
  expect(response.status).toBe(202);
  const { project } = (await response.json()) as { project: { id: string } };
  return project.id;
}

async function currentRunId(baseUrl: string, projectId: string): Promise<string> {
  const response = await fetch(`${baseUrl}/projects/${projectId}`);
  const { project } = (await response.json()) as { project: { currentRunId: string } };
  return project.currentRunId;
}

async function getRun(baseUrl: string, runId: string): Promise<{ status: string }> {
  const response = await fetch(`${baseUrl}/runs/${runId}`);
  const { run } = (await response.json()) as { run: { status: string } };
  return run;
}

interface ApprovalEntry {
  request: { id: string; nodeId: string };
  decision: { action: string } | null;
}

async function listApprovals(baseUrl: string, runId: string): Promise<ApprovalEntry[]> {
  const response = await fetch(`${baseUrl}/runs/${runId}/approvals`);
  expect(response.status).toBe(200);
  const { approvals } = (await response.json()) as { approvals: ApprovalEntry[] };
  return approvals;
}

function decide(
  baseUrl: string,
  runId: string,
  requestId: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${baseUrl}/runs/${runId}/approvals/${requestId}/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close().catch(() => undefined)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('approval review API (#14)', () => {
  it('approves through the architecture and release gates to completion', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    expect(await runtime.worker.runOnce()).toBe(true);

    const runId = await currentRunId(baseUrl, projectId);
    expect((await getRun(baseUrl, runId)).status).toBe('awaiting_approval');

    const [archEntry] = await listApprovals(baseUrl, runId);
    expect(archEntry!.request.nodeId).toBe('architecture-approval');
    expect(
      (await decide(baseUrl, runId, archEntry!.request.id, { action: 'approve', decidedBy: 'ed' }))
        .status,
    ).toBe(202);

    expect(await runtime.worker.runOnce()).toBe(true);
    const releaseEntry = (await listApprovals(baseUrl, runId)).find((entry) => !entry.decision);
    expect(releaseEntry!.request.nodeId).toBe('release-approval');
    expect(
      (
        await decide(baseUrl, runId, releaseEntry!.request.id, {
          action: 'approve',
          decidedBy: 'ed',
        })
      ).status,
    ).toBe(202);

    expect(await runtime.worker.runOnce()).toBe(true);
    expect((await getRun(baseUrl, runId)).status).toBe('completed');
  });

  it('rejects at the release gate and ends the run as rejected', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    expect(await runtime.worker.runOnce()).toBe(true);
    const runId = await currentRunId(baseUrl, projectId);

    const [archEntry] = await listApprovals(baseUrl, runId);
    await decide(baseUrl, runId, archEntry!.request.id, { action: 'approve', decidedBy: 'ed' });
    expect(await runtime.worker.runOnce()).toBe(true);

    const releaseEntry = (await listApprovals(baseUrl, runId)).find((entry) => !entry.decision);
    expect(
      (
        await decide(baseUrl, runId, releaseEntry!.request.id, {
          action: 'reject',
          decidedBy: 'ed',
        })
      ).status,
    ).toBe(202);

    expect(await runtime.worker.runOnce()).toBe(true);
    expect((await getRun(baseUrl, runId)).status).toBe('rejected');
  });

  it('rejects request-changes without a note', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    expect(await runtime.worker.runOnce()).toBe(true);
    const runId = await currentRunId(baseUrl, projectId);
    const [entry] = await listApprovals(baseUrl, runId);

    const response = await decide(baseUrl, runId, entry!.request.id, {
      action: 'request-changes',
      decidedBy: 'ed',
    });
    expect(response.status).toBe(400);
  });

  it('rejects ambiguous actor and decidedBy input', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    expect(await runtime.worker.runOnce()).toBe(true);
    const runId = await currentRunId(baseUrl, projectId);
    const [entry] = await listApprovals(baseUrl, runId);

    const response = await decide(baseUrl, runId, entry!.request.id, {
      action: 'approve',
      actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
      decidedBy: 'someone-else',
    });
    expect(response.status).toBe(400);
  });

  it('request-changes rewinds to the architecture step, writes a repair artifact, and re-halts', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    expect(await runtime.worker.runOnce()).toBe(true);
    const runId = await currentRunId(baseUrl, projectId);
    const [entry] = await listApprovals(baseUrl, runId);

    const response = await decide(baseUrl, runId, entry!.request.id, {
      action: 'request-changes',
      actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
      note: 'tighten the boundaries; token=plain-token-value',
    });
    expect(response.status).toBe(202);
    const decisionResponse = (await response.json()) as {
      decision: { decidedBy: string; actor: { id: string; displayName?: string } };
    };
    expect(decisionResponse.decision).toMatchObject({
      decidedBy: 'Ed',
      actor: { id: 'ed', displayName: 'Ed' },
    });

    expect(await runtime.worker.runOnce()).toBe(true);
    const approvals = await listApprovals(baseUrl, runId);
    expect(approvals).toHaveLength(2);
    const fresh = approvals.find((item) => item.request.id !== entry!.request.id);
    expect(fresh?.decision).toBeNull();
    expect(fresh?.request.nodeId).toBe('architecture-approval');

    const artifactResponse = await fetch(
      `${baseUrl}/projects/${projectId}/artifacts/architecture.repair-notes`,
    );
    expect(artifactResponse.status).toBe(200);
    const { content, metadata } = (await artifactResponse.json()) as {
      content: { note: string };
      metadata: { kind: string; actor: { id: string }; sourceDecisionId: string };
    };
    expect(content).toMatchObject({
      note: 'tighten the boundaries; token=[REDACTED]',
      actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
    });
    expect(metadata).toMatchObject({ kind: 'feedback', actor: { id: 'ed' } });

    const auditResponse = await fetch(`${baseUrl}/runs/${runId}/audit`);
    expect(auditResponse.status).toBe(200);
    const audit = (await auditResponse.json()) as {
      entries: Array<{
        kind: string;
        id: string;
        timestamp: string;
        decision?: { decidedBy: string; actor?: { id: string; displayName?: string } };
      }>;
    };
    expect(audit.entries.map((item) => item.kind)).toEqual([
      'approval-request',
      'approval-decision',
      'feedback',
      'approval-request',
    ]);
    expect(
      [...audit.entries].sort(
        (left, right) =>
          left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id),
      ),
    ).toEqual(audit.entries);
    expect(audit.entries.find((item) => item.kind === 'approval-decision')?.decision).toMatchObject(
      {
        decidedBy: 'Ed',
        actor: { id: 'ed', displayName: 'Ed' },
      },
    );
  });

  it('returns 409 with the settled decision when two differing decisions race', async () => {
    const { baseUrl, runtime } = await startApi();
    const projectId = await createProject(baseUrl);
    expect(await runtime.worker.runOnce()).toBe(true);
    const runId = await currentRunId(baseUrl, projectId);
    const [entry] = await listApprovals(baseUrl, runId);

    const [a, b] = await Promise.all([
      decide(baseUrl, runId, entry!.request.id, { action: 'approve', decidedBy: 'ed' }),
      decide(baseUrl, runId, entry!.request.id, { action: 'reject', decidedBy: 'sam' }),
    ]);

    const statuses = [a!.status, b!.status].sort();
    expect(statuses).toEqual([202, 409]);
    const conflictResponse = a!.status === 409 ? a! : b!;
    const body = (await conflictResponse.json()) as {
      error: string;
      decision: { action: string };
    };
    expect(body.error).toBe('ApprovalConflictError');
    expect(['approve', 'reject']).toContain(body.decision.action);
  });
});
