import { describe, expect, it } from 'vitest';
import {
  ArtifactMetadataSchema,
  FeedbackArtifactSchema,
  ProjectSchema,
  QueueJobSchema,
} from './project.js';
import { ActorRefSchema } from './primitives.js';
import { WorkflowNodeSchema } from './workflow.js';
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  RunRetryDirectiveSchema,
  StepAttemptSchema,
  StepRunSchema,
  WorkflowRunSchema,
} from './run.js';
import { ModelOverrideRecordSchema, RouteDecisionSchema } from './model.js';
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

  it('parses immutable run and step model override records', () => {
    const base = {
      id: 'override-1',
      runId: 'run-1',
      modelId: 'codex-gpt-5',
      provider: 'codex' as const,
      model: 'gpt-5',
      actor: { kind: 'user' as const, id: 'ed' },
      reason: 'Unblock a high-risk repair',
      estimatedImpact: 'Higher latency and metered cost',
      createdAt: '2026-07-16T12:00:00.000Z',
    };

    expect(ModelOverrideRecordSchema.parse({ ...base, scope: { kind: 'run' } }).scope).toEqual({
      kind: 'run',
    });
    expect(
      ModelOverrideRecordSchema.parse({ ...base, sequence: 7, scope: { kind: 'run' } }).sequence,
    ).toBe(7);
    expect(ModelOverrideRecordSchema.parse({ ...base, scope: { kind: 'run' } }).sequence).toBe(1);
    expect(
      ModelOverrideRecordSchema.parse({
        ...base,
        scope: { kind: 'step', nodeId: 'implementation-gate', stepId: 'repair-code' },
      }).scope,
    ).toEqual({ kind: 'step', nodeId: 'implementation-gate', stepId: 'repair-code' });
    expect(() =>
      ModelOverrideRecordSchema.parse({
        ...base,
        scope: { kind: 'run' },
        estimatedImpact: '   ',
      }),
    ).toThrow();
  });

  it('keeps route decisions compatible while exposing override provenance', () => {
    const route = {
      routeId: 'route-1',
      createdAt: '2026-07-16T12:00:00.000Z',
      profile: {
        role: 'developer' as const,
        taskKind: 'implementation' as const,
        complexity: 3,
        risk: 3,
        estimatedContextTokens: 1_000,
        estimatedOutputTokens: 500,
        mutatesWorkspace: true,
        priorities: { quality: 1, speed: 0, cost: 0, reliability: 0 },
      },
      selected: {
        model: {
          id: 'codex-gpt-5',
          provider: 'codex' as const,
          model: 'gpt-5',
          maxContextTokens: 100_000,
          capabilities: {
            planning: 1,
            architecture: 1,
            coding: 1,
            review: 1,
            repair: 1,
            structuredOutput: 1,
            speed: 1,
            costEfficiency: 1,
            reliability: 1,
          },
        },
        score: {
          capability: 1,
          context: 1,
          speed: 1,
          cost: 1,
          reliability: 1,
          historical: 1,
          tagAffinity: 1,
          estimatedCostUsd: null,
          total: 1,
        },
      },
      fallbacks: [],
      rejected: [],
    };

    expect(RouteDecisionSchema.parse(route).override).toBeUndefined();
    expect(
      RouteDecisionSchema.parse({
        ...route,
        override: {
          source: 'step',
          overrideId: 'override-1',
          modelId: 'codex-gpt-5',
          provider: 'codex',
          model: 'gpt-5',
          actor: { kind: 'user', id: 'ed' },
          reason: 'Repair pin',
          estimatedImpact: 'Higher latency',
          createdAt: '2026-07-16T12:00:00.000Z',
        },
      }).override,
    ).toMatchObject({ source: 'step', overrideId: 'override-1' });
    expect(() =>
      RouteDecisionSchema.parse({
        ...route,
        override: {
          source: 'run',
          modelId: 'codex-gpt-5',
          provider: 'codex',
          model: 'gpt-5',
          actor: { kind: 'user', id: 'ed' },
          reason: 'Run pin',
          estimatedImpact: 'Higher latency',
          createdAt: '2026-07-16T12:00:00.000Z',
        },
      }),
    ).toThrow();
    expect(
      RouteDecisionSchema.parse({
        ...route,
        override: {
          source: 'retry',
          modelId: 'codex-gpt-5',
          provider: 'codex',
          model: 'gpt-5',
          actor: { kind: 'user', id: 'ed' },
          reason: 'Retry pin',
          estimatedImpact: 'Higher latency',
          createdAt: '2026-07-16T12:00:00.000Z',
        },
      }).override,
    ).toMatchObject({ source: 'retry' });
  });

  it('parses restart-safe execution and emergency ceiling evidence', () => {
    const run = WorkflowRunSchema.parse({
      id: 'run-1',
      projectId: 'project-1',
      workflowId: 'web-app-v1',
      status: 'failed',
      version: 1,
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T16:00:00.000Z',
      startedAt: '2026-07-16T12:00:00.000Z',
      completedAt: '2026-07-16T16:00:00.000Z',
      error: {
        name: 'EmergencyCeilingError',
        message: 'Repair ceiling reached',
        code: 'EMERGENCY_CEILING',
      },
      execution: {
        activeElapsedMs: 14_400_000,
        consecutiveRepairs: 10,
        lastVerifiedCheckpoint: 'abc123',
        ceiling: {
          reason: 'consecutive-repairs',
          reachedAt: '2026-07-16T16:00:00.000Z',
          draftBranch: 'draft/run-1',
        },
      },
    });

    expect(run.execution?.ceiling?.draftBranch).toBe('draft/run-1');
    expect(
      WorkflowRunSchema.parse({
        id: 'run-legacy',
        projectId: 'project-1',
        workflowId: 'web-app-v1',
        status: 'queued',
        version: 1,
        createdAt: '2026-07-16T12:00:00.000Z',
        updatedAt: '2026-07-16T12:00:00.000Z',
      }).execution,
    ).toBeUndefined();
  });

  it('reads legacy retry directives and audited retry overrides', () => {
    const base = {
      stepRunId: 'step-run-1',
      nodeId: 'implementation-gate',
      stepId: 'repair-code',
      mode: 'preserve' as const,
      requestedAt: '2026-07-16T12:00:00.000Z',
    };
    expect(
      RunRetryDirectiveSchema.parse({
        ...base,
        override: { modelId: 'codex-gpt-5', provider: 'codex', model: 'gpt-5' },
      }).override?.actor,
    ).toBeUndefined();
    expect(
      RunRetryDirectiveSchema.parse({
        ...base,
        override: {
          modelId: 'codex-gpt-5',
          provider: 'codex',
          model: 'gpt-5',
          actor: { kind: 'user', id: 'ed' },
          reason: 'Retry on stronger model',
          estimatedImpact: 'Higher latency',
        },
      }).override,
    ).toMatchObject({ reason: 'Retry on stronger model' });
    expect(() =>
      RunRetryDirectiveSchema.parse({
        ...base,
        override: {
          modelId: 'codex-gpt-5',
          provider: 'codex',
          model: 'gpt-5',
          actor: { kind: 'user', id: 'ed' },
        },
      }),
    ).toThrow(/provided together/);
  });

  it('keeps legacy maxAttempts and maxIterations readable', () => {
    const agent = {
      id: 'review',
      type: 'agent' as const,
      role: 'code-reviewer' as const,
      taskKind: 'code-review' as const,
      title: 'Review',
      instructions: 'Review the implementation',
      outputArtifact: 'review',
      maxAttempts: 5,
    };
    const parsedAgent = WorkflowNodeSchema.parse(agent);
    expect(parsedAgent.type === 'agent' && parsedAgent.maxAttempts).toBe(5);
    const parsedLoop = WorkflowNodeSchema.parse({
      id: 'quality',
      type: 'quality-loop',
      title: 'Quality loop',
      check: agent,
      repair: {
        ...agent,
        id: 'repair',
        role: 'fixer',
        taskKind: 'repair',
        outputArtifact: 'repair',
      },
      approval: { artifact: 'review', path: 'approved', equals: true },
      maxIterations: 10,
    });
    expect(parsedLoop.type === 'quality-loop' && parsedLoop.maxIterations).toBe(10);
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
