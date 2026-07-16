import { describe, expect, it } from 'vitest';
import {
  ArtifactMetadataSchema,
  FeedbackArtifactSchema,
  ProjectSchema,
  QueueJobSchema,
} from './project.js';
import { ActorRefSchema } from './primitives.js';
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  StepAttemptSchema,
  StepRunSchema,
  WorkflowRunSchema,
} from './run.js';
import * as contracts from './index.js';

const exported = contracts as Record<string, unknown>;

describe('persisted run contracts', () => {
  it('parses all supported actor identities', () => {
    for (const kind of ['user', 'system', 'worker', 'provider'] as const) {
      expect(ActorRefSchema.parse({ kind, id: `${kind}-1`, displayName: kind })).toEqual({
        kind,
        id: `${kind}-1`,
        displayName: kind,
      });
    }
  });

  it('exports schemas for workflow runs, step runs, and attempts', () => {
    expect(exported.WorkflowRunSchema).toBeDefined();
    expect(exported.StepRunSchema).toBeDefined();
    expect(exported.StepAttemptSchema).toBeDefined();
  });

  it('accepts valid queued, pending, and running entity records', () => {
    const timestamp = '2026-07-14T12:00:00.000Z';
    expect(
      WorkflowRunSchema.parse({
        id: 'run-1',
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        status: 'queued',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).status,
    ).toBe('queued');
    expect(
      StepRunSchema.parse({
        id: 'step-run-1',
        runId: 'run-1',
        nodeId: 'planning-loop',
        stepId: 'planner',
        stepType: 'agent',
        iteration: 1,
        status: 'pending',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      }).status,
    ).toBe('pending');
    expect(
      StepAttemptSchema.parse({
        id: 'attempt-1',
        runId: 'run-1',
        stepRunId: 'step-run-1',
        sequence: 1,
        executorKind: 'agent',
        provider: 'codex',
        model: 'gpt-5.6-sol',
        context: {
          projectId: 'project-1',
          workflowId: 'web-app-v1',
          nodeId: 'planning-loop',
          stepId: 'planner',
          iteration: 1,
        },
        status: 'running',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
      }).status,
    ).toBe('running');
  });

  it('reads a v0.1 project with version 1 and no current run', () => {
    const project = ProjectSchema.parse({
      id: 'project-1',
      name: 'Legacy project',
      workflowId: 'web-app-v1',
      status: 'completed',
      createdAt: '2026-07-01T12:00:00.000Z',
      updatedAt: '2026-07-01T13:00:00.000Z',
    });

    expect(project.version).toBe(1);
    expect(project.currentRunId).toBeUndefined();
  });

  it('keeps run linkage optional on legacy jobs and artifacts', () => {
    const job = QueueJobSchema.parse({
      id: 'job-1',
      type: 'run-project',
      projectId: 'project-1',
      workflowId: 'web-app-v1',
      attempts: 0,
      maxAttempts: 1,
      createdAt: '2026-07-01T12:00:00.000Z',
      availableAt: '2026-07-01T12:00:00.000Z',
    });
    const metadata = ArtifactMetadataSchema.parse({
      projectId: 'project-1',
      name: 'plan.current',
      revision: 1,
      contentType: 'application/json',
      createdAt: '2026-07-01T12:00:00.000Z',
      createdBy: 'planner',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      attemptId: 'attempt-1',
      sha256: 'a'.repeat(64),
    });

    expect(job.runId).toBeUndefined();
    expect(metadata).toMatchObject({ stepRunId: 'step-run-1', attemptId: 'attempt-1' });
  });

  it('rejects terminal runs without lifecycle timestamps', () => {
    expect(() =>
      WorkflowRunSchema.parse({
        id: 'run-1',
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        status: 'completed',
        version: 1,
        createdAt: '2026-07-14T12:00:00.000Z',
        updatedAt: '2026-07-14T12:00:00.000Z',
      }),
    ).toThrow();
  });

  it('requires deterministic verifier identity for verification attempts', () => {
    expect(() =>
      StepAttemptSchema.parse({
        id: 'attempt-1',
        runId: 'run-1',
        stepRunId: 'step-run-1',
        sequence: 1,
        executorKind: 'verification',
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
        createdAt: '2026-07-14T12:00:00.000Z',
        updatedAt: '2026-07-14T12:00:00.000Z',
        startedAt: '2026-07-14T12:00:00.000Z',
        inputArtifacts: [],
        outputArtifacts: [],
      }),
    ).toThrow(/workspace-verifier/);
  });

  it('rejects reversed lifecycle timestamps and errors on successful entities', () => {
    expect(() =>
      WorkflowRunSchema.parse({
        id: 'run-1',
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        status: 'completed',
        version: 1,
        createdAt: '2026-07-14T12:00:00.000Z',
        updatedAt: '2026-07-14T12:00:00.000Z',
        startedAt: '2026-07-14T12:02:00.000Z',
        completedAt: '2026-07-14T12:01:00.000Z',
      }),
    ).toThrow(/cannot precede/);

    expect(() =>
      WorkflowRunSchema.parse({
        id: 'run-1',
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        status: 'completed',
        version: 1,
        createdAt: '2026-07-14T12:00:00.000Z',
        updatedAt: '2026-07-14T12:02:00.000Z',
        startedAt: '2026-07-14T12:00:00.000Z',
        completedAt: '2026-07-14T12:02:00.000Z',
        error: { name: 'Error', message: 'stale error' },
      }),
    ).toThrow(/Only failed runs/);
  });

  it('accepts a run parked awaiting approval and a run rejected as terminal', () => {
    const timestamp = '2026-07-14T12:00:00.000Z';
    expect(
      WorkflowRunSchema.parse({
        id: 'run-1',
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        status: 'awaiting_approval',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
      }).status,
    ).toBe('awaiting_approval');

    expect(
      WorkflowRunSchema.parse({
        id: 'run-1',
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        status: 'rejected',
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
      }).status,
    ).toBe('rejected');
  });

  it('parses linked, immutable approval requests and decisions', () => {
    const timestamp = '2026-07-14T12:00:00.000Z';
    const request = ApprovalRequestSchema.parse({
      id: 'approval-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      nodeId: 'review-gate',
      artifact: { name: 'plan', revision: 1, sha256: 'a'.repeat(64) },
      allowedActions: ['approve', 'reject'],
      createdAt: timestamp,
    });
    expect(request.timeoutAt).toBeUndefined();

    const decision = ApprovalDecisionSchema.parse({
      id: 'decision-1',
      requestId: 'approval-1',
      runId: 'run-1',
      stepRunId: 'step-run-1',
      action: 'approve',
      decidedBy: 'ed',
      decidedAt: timestamp,
    });
    expect(decision.action).toBe('approve');

    const actorDecision = ApprovalDecisionSchema.parse({
      ...decision,
      actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
    });
    expect(actorDecision.actor?.id).toBe('ed');
  });

  it('parses typed feedback artifacts and metadata without breaking legacy metadata', () => {
    const timestamp = '2026-07-14T12:00:00.000Z';
    const actor = { kind: 'user' as const, id: 'ed' };
    expect(
      FeedbackArtifactSchema.parse({
        schemaVersion: '1',
        actor,
        sourceRequestId: 'approval-1',
        sourceDecisionId: 'decision-1',
        runId: 'run-1',
        stepRunId: 'step-run-1',
        note: 'please add tests',
        createdAt: timestamp,
      }).note,
    ).toBe('please add tests');

    expect(
      ArtifactMetadataSchema.parse({
        projectId: 'project-1',
        name: 'repair-notes',
        revision: 1,
        contentType: 'application/json',
        createdAt: timestamp,
        createdBy: 'approval-gate:gate',
        runId: 'run-1',
        stepRunId: 'step-run-1',
        kind: 'feedback',
        actor,
        sourceDecisionId: 'decision-1',
        sha256: 'a'.repeat(64),
      }),
    ).toMatchObject({ kind: 'feedback', actor, sourceDecisionId: 'decision-1' });
  });
});
