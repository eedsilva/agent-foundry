import { describe, expect, it } from 'vitest';
import {
  ConversationPageResponseSchema,
  CreateAttachmentRequestSchema,
  CreateAttachmentResponseSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  CreateModelOverrideRequestSchema,
  CreateModelOverrideResponseSchema,
  CreateOperationRequestSchema,
  CreateOperationResponseSchema,
  CreateQualityObservationRequestSchema,
  CreateQualityObservationResponseSchema,
  DecideApprovalRequestSchema,
  DecideChangeRequestRequestSchema,
  DecideOperationRequestSchema,
  DecideOperationResponseSchema,
  ProjectExportResponseSchema,
  ProjectDetailResponseSchema,
  RetryStepRequestSchema,
  RunAuditExportSchema,
  StartOperationRequestSchema,
  StartOperationResponseSchema,
} from './api.js';

const conversationCreatedAt = '2026-07-17T12:00:00.000Z';
const conversation = {
  id: 'project-1',
  projectId: 'project-1',
  createdAt: conversationCreatedAt,
};
const message = {
  id: 'message-1',
  projectId: 'project-1',
  conversationId: conversation.id,
  role: 'user' as const,
  content: [{ type: 'text' as const, text: 'Build it' }],
  sequence: 1,
  createdAt: conversationCreatedAt,
};
const attachment = {
  id: 'attachment-1',
  projectId: 'project-1',
  conversationId: conversation.id,
  kind: 'file' as const,
  mediaType: 'text/plain',
  sha256: 'a'.repeat(64),
  sizeBytes: 5,
  access: { scope: 'project' as const, projectId: 'project-1' },
  createdAt: conversationCreatedAt,
};
const operation = {
  id: 'operation-1',
  projectId: 'project-1',
  conversationId: conversation.id,
  messageId: message.id,
  kind: 'build' as const,
  idempotencyKey: 'b'.repeat(64),
  artifactReferences: [],
  directExecution: true,
  createdAt: conversationCreatedAt,
};

describe('conversation HTTP contracts (#36)', () => {
  it('parses strict create requests and responses', () => {
    expect(
      CreateAttachmentRequestSchema.parse({
        kind: 'image',
        name: ' design.png ',
        mediaType: 'image/png',
        sha256: attachment.sha256,
        sizeBytes: 5,
      }),
    ).toMatchObject({ name: 'design.png', mediaType: 'image/png' });
    expect(CreateAttachmentResponseSchema.parse({ attachment }).attachment).toEqual(attachment);
    expect(() =>
      CreateAttachmentRequestSchema.parse({
        kind: 'file',
        mediaType: 'text/plain; token=raw-secret',
        sha256: attachment.sha256,
        sizeBytes: 5,
      }),
    ).toThrow();

    expect(
      CreateMessageRequestSchema.parse({ role: 'user', content: message.content }).content,
    ).toEqual(message.content);
    expect(CreateMessageResponseSchema.parse({ message }).message).toEqual(message);

    expect(
      CreateOperationRequestSchema.parse({
        kind: 'build',
        idempotencyKey: operation.idempotencyKey,
        runId: 'run-1',
        changeRequestId: 'change-1',
        projectVersionId: 'version-1',
      }),
    ).toMatchObject({ kind: 'build', artifactReferences: [] });
    expect(CreateOperationResponseSchema.parse({ operation }).operation).toEqual(operation);
    expect(() =>
      CreateMessageRequestSchema.parse({ role: 'user', content: message.content, extra: true }),
    ).toThrow();
  });

  it('parses a conversation page with a sequence cursor', () => {
    expect(
      ConversationPageResponseSchema.parse({
        conversation,
        messages: [message],
        attachments: [attachment],
        operations: [operation],
        nextCursor: 1,
      }).nextCursor,
    ).toBe(1);
    expect(
      ConversationPageResponseSchema.parse({
        conversation,
        messages: [],
        attachments: [],
        operations: [],
        nextCursor: null,
      }).nextCursor,
    ).toBeNull();
  });

  it('parses a complete versioned project export', () => {
    const project = {
      id: 'project-1',
      name: 'Builder',
      workflowId: 'web-app-v1',
      policyId: 'default',
      status: 'completed' as const,
      version: 1,
      createdAt: conversationCreatedAt,
      updatedAt: conversationCreatedAt,
    };
    expect(
      ProjectExportResponseSchema.parse({
        schemaVersion: '1',
        project,
        conversation,
        messages: [message],
        attachments: [attachment],
        operations: [operation],
      }),
    ).toMatchObject({ schemaVersion: '1', project, conversation });
  });

  it('parses start/decide operation requests and rejects ambiguous build gating', () => {
    expect(StartOperationRequestSchema.parse({ kind: 'plan' })).toEqual({ kind: 'plan' });
    expect(
      StartOperationRequestSchema.parse({ kind: 'build', planOperationId: 'operation-1' }),
    ).toMatchObject({ planOperationId: 'operation-1' });
    expect(
      StartOperationRequestSchema.parse({ kind: 'build', directExecution: true }),
    ).toMatchObject({ directExecution: true });
    expect(() => StartOperationRequestSchema.parse({ kind: 'build' })).toThrow();
    expect(() =>
      StartOperationRequestSchema.parse({
        kind: 'build',
        planOperationId: 'operation-1',
        directExecution: true,
      }),
    ).toThrow();
    expect(StartOperationResponseSchema.parse({ operation }).operation).toEqual(operation);

    expect(DecideOperationRequestSchema.parse({ action: 'approve' })).toEqual({
      action: 'approve',
    });
    expect(DecideOperationResponseSchema.parse({ operation }).operation).toEqual(operation);
  });
});

describe('project detail HTTP contract', () => {
  it('requires and parses knowledge files', () => {
    const detail = {
      project: {
        id: 'project-1',
        name: 'Builder',
        workflowId: 'web-app-v1',
        status: 'completed' as const,
        version: 1,
        createdAt: conversationCreatedAt,
        updatedAt: conversationCreatedAt,
      },
      artifacts: [],
      events: [],
      workspacePath: '/workspace/project-1',
      knowledgeFiles: [
        {
          schemaVersion: '1' as const,
          id: 'reference-1',
          projectId: 'project-1',
          name: 'reference.png',
          mediaType: 'image/png',
          purpose: 'design-reference' as const,
          pinned: true,
          currentVersion: 1,
          revisions: [
            {
              version: 1,
              artifact: {
                name: 'knowledge-reference-1',
                revision: 1,
                sha256: 'a'.repeat(64),
              },
              createdAt: conversationCreatedAt,
            },
          ],
          createdAt: conversationCreatedAt,
          updatedAt: conversationCreatedAt,
        },
      ],
    };

    expect(ProjectDetailResponseSchema.parse(detail).knowledgeFiles[0]?.name).toBe('reference.png');
    expect(() =>
      ProjectDetailResponseSchema.parse({ ...detail, knowledgeFiles: undefined }),
    ).toThrow();
  });
});

describe('model override API contracts (#16)', () => {
  const audit = {
    actor: { kind: 'user' as const, id: 'ed' },
    reason: 'Pin a model for a risky repair',
    estimatedImpact: 'Higher latency and metered cost',
  };

  it('accepts audited run and step pin requests', () => {
    expect(
      CreateModelOverrideRequestSchema.parse({
        modelId: 'codex-gpt-5',
        provider: 'codex',
        model: 'gpt-5',
        scope: { kind: 'run' },
        ...audit,
      }).scope,
    ).toEqual({ kind: 'run' });
    expect(
      CreateModelOverrideRequestSchema.parse({
        modelId: 'codex-gpt-5',
        provider: 'codex',
        model: 'gpt-5',
        scope: { kind: 'step', nodeId: 'implementation-gate', stepId: 'repair-code' },
        ...audit,
      }).scope,
    ).toMatchObject({ kind: 'step', stepId: 'repair-code' });
  });

  it('rejects unaudited pins and retry overrides', () => {
    expect(() =>
      CreateModelOverrideRequestSchema.parse({
        provider: 'codex',
        model: 'gpt-5',
        scope: { kind: 'run' },
      }),
    ).toThrow();
    expect(() =>
      RetryStepRequestSchema.parse({
        mode: 'preserve',
        override: { provider: 'codex', model: 'gpt-5' },
      }),
    ).toThrow();
  });

  it('parses resolved override responses and audited retry input', () => {
    const record = {
      id: 'override-1',
      sequence: 1,
      runId: 'run-1',
      scope: { kind: 'run' as const },
      modelId: 'codex-gpt-5',
      provider: 'codex' as const,
      model: 'gpt-5',
      ...audit,
      createdAt: '2026-07-16T12:00:00.000Z',
    };
    expect(CreateModelOverrideResponseSchema.parse({ override: record }).override).toEqual(record);
    expect(
      RetryStepRequestSchema.parse({
        mode: 'invalidate',
        override: { modelId: 'codex-gpt-5', provider: 'codex', model: 'gpt-5', ...audit },
      }).override,
    ).toMatchObject({ modelId: 'codex-gpt-5', reason: audit.reason });
  });

  it('requires the selected catalog identity on new pin inputs', () => {
    expect(() =>
      CreateModelOverrideRequestSchema.parse({
        provider: 'codex',
        model: 'gpt-5',
        scope: { kind: 'run' },
        ...audit,
      }),
    ).toThrow();
    expect(() =>
      RetryStepRequestSchema.parse({
        mode: 'preserve',
        override: { provider: 'codex', model: 'gpt-5', ...audit },
      }),
    ).toThrow();
  });
});

describe('DecideApprovalRequestSchema (#14)', () => {
  it('requires a note when action is request-changes', () => {
    expect(() =>
      DecideApprovalRequestSchema.parse({ action: 'request-changes', decidedBy: 'ed' }),
    ).toThrow(/note is required/);
  });

  it('accepts request-changes with a note', () => {
    const parsed = DecideApprovalRequestSchema.parse({
      action: 'request-changes',
      decidedBy: 'ed',
      note: 'please add tests',
    });
    expect(parsed.note).toBe('please add tests');
  });

  it('leaves approve and reject unaffected by the note requirement', () => {
    expect(() =>
      DecideApprovalRequestSchema.parse({ action: 'approve', decidedBy: 'ed' }),
    ).not.toThrow();
    expect(() =>
      DecideApprovalRequestSchema.parse({ action: 'reject', decidedBy: 'ed' }),
    ).not.toThrow();
  });

  it('accepts a typed actor and keeps legacy decidedBy input readable', () => {
    const actor = DecideApprovalRequestSchema.parse({
      action: 'approve',
      actor: { kind: 'user', id: ' ed ', displayName: ' Ed ' },
    }).actor;
    expect(actor).toEqual({ kind: 'user', id: 'ed', displayName: 'Ed' });
    expect(
      DecideApprovalRequestSchema.parse({ action: 'approve', decidedBy: 'legacy-ed' }).decidedBy,
    ).toBe('legacy-ed');
  });

  it('rejects blank actor ids and display names after trimming', () => {
    expect(() =>
      DecideApprovalRequestSchema.parse({
        action: 'approve',
        actor: { kind: 'user', id: '   ' },
      }),
    ).toThrow();
    expect(() =>
      DecideApprovalRequestSchema.parse({
        action: 'approve',
        actor: { kind: 'user', id: 'ed', displayName: '   ' },
      }),
    ).toThrow();
  });

  it('rejects ambiguous actor and decidedBy input', () => {
    expect(() =>
      DecideApprovalRequestSchema.parse({
        action: 'approve',
        actor: { kind: 'user', id: 'ed', displayName: 'Ed' },
        decidedBy: 'someone-else',
      }),
    ).toThrow(/exactly one identity/);
  });

  it('parses a deterministic run audit response', () => {
    const timestamp = '2026-07-14T12:00:00.000Z';
    const audit = RunAuditExportSchema.parse({
      schemaVersion: '1',
      runId: 'run-1',
      entries: [
        {
          kind: 'approval-request',
          id: 'approval-1',
          timestamp,
          request: {
            id: 'approval-1',
            runId: 'run-1',
            stepRunId: 'step-run-1',
            nodeId: 'gate',
            artifact: { name: 'review', revision: 1, sha256: 'a'.repeat(64) },
            allowedActions: ['approve'],
            createdAt: timestamp,
          },
        },
        {
          kind: 'approval-decision',
          id: 'decision-1',
          timestamp,
          decision: {
            id: 'decision-1',
            requestId: 'approval-1',
            runId: 'run-1',
            stepRunId: 'step-run-1',
            action: 'approve',
            decidedBy: 'ed',
            decidedAt: timestamp,
          },
        },
      ],
    });
    expect(audit.entries.map((entry) => entry.kind)).toEqual([
      'approval-request',
      'approval-decision',
    ]);
  });
});

describe('StartOperationRequestSchema', () => {
  it('accepts an optional changeRequestId', () => {
    const parsed = StartOperationRequestSchema.parse({
      kind: 'plan',
      changeRequestId: 'cr-1',
    });
    expect(parsed.changeRequestId).toBe('cr-1');
  });
});

describe('DecideChangeRequestRequestSchema', () => {
  it('accepts a reject action with no kind', () => {
    expect(DecideChangeRequestRequestSchema.parse({ action: 'reject' })).toEqual({
      action: 'reject',
    });
  });

  it('accepts a confirm action for a non-build kind with no plan fields', () => {
    const parsed = DecideChangeRequestRequestSchema.parse({ action: 'confirm', kind: 'plan' });
    expect(parsed).toEqual({ action: 'confirm', kind: 'plan' });
  });

  it('requires exactly one of planOperationId/directExecution when confirming a build', () => {
    expect(() =>
      DecideChangeRequestRequestSchema.parse({ action: 'confirm', kind: 'build' }),
    ).toThrow();
    expect(() =>
      DecideChangeRequestRequestSchema.parse({
        action: 'confirm',
        kind: 'build',
        directExecution: true,
      }),
    ).not.toThrow();
  });
});

describe('quality observation HTTP contracts (#64)', () => {
  const qualityObservation = {
    id: 'quality-1',
    source: 'human-edit' as const,
    subject: {
      modelId: 'producer',
      taskKind: 'implementation' as const,
      role: 'developer' as const,
      taxonomyVersion: '2' as const,
      category: 'implementation/backend' as const,
      artifact: { name: 'implementation', revision: 1, sha256: 'a'.repeat(64) },
    },
    evaluator: { kind: 'human' as const, id: 'ed' },
    blind: false,
    rubric: 'post-review-edit',
    score: 0.8,
    evidence: [{ kind: 'human-edit' as const, summary: 'Human accepted the implementation.' }],
    observedAt: conversationCreatedAt,
  };

  it('accepts delayed human and system input with strict evaluator attribution', () => {
    expect(
      CreateQualityObservationRequestSchema.parse({
        source: 'human-edit',
        artifact: qualityObservation.subject.artifact,
        evaluator: qualityObservation.evaluator,
        rubric: qualityObservation.rubric,
        score: qualityObservation.score,
        evidence: qualityObservation.evidence,
      }),
    ).toMatchObject({ source: 'human-edit', evaluator: { kind: 'human' } });
    expect(() =>
      CreateQualityObservationRequestSchema.parse({
        source: 'post-merge-regression',
        artifact: qualityObservation.subject.artifact,
        evaluator: qualityObservation.evaluator,
        rubric: 'production-regression',
        score: 0,
        evidence: [{ kind: 'regression', summary: 'Production check failed after merge.' }],
      }),
    ).toThrow(/system evaluator/);
    expect(
      CreateQualityObservationResponseSchema.parse({ observation: qualityObservation }),
    ).toEqual({
      observation: qualityObservation,
    });
  });
});
