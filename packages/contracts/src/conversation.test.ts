import { describe, expect, it } from 'vitest';
import {
  AttachmentSchema,
  ConversationSchema,
  ContextSourceSchema,
  MessageContentBlockSchema,
  MessageRoleSchema,
  MessageSchema,
  OperationKindSchema,
  OperationSchema,
} from './conversation.js';

const createdAt = '2026-07-17T12:00:00.000Z';

describe('conversation aggregate contracts (#36)', () => {
  it('parses every message role and structured content variant', () => {
    expect(
      ['user', 'assistant', 'system', 'tool'].map((role) => MessageRoleSchema.parse(role)),
    ).toEqual(['user', 'assistant', 'system', 'tool']);
    expect(
      [
        { type: 'text', text: 'Build the dashboard' },
        { type: 'data', value: { selected: ['hero'], approved: true } },
        { type: 'attachment', attachmentId: 'attachment-1' },
      ].map((block) => MessageContentBlockSchema.parse(block)),
    ).toHaveLength(3);
  });

  it('requires an ordered, non-empty message in its project conversation', () => {
    const message = {
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      role: 'user',
      content: [{ type: 'text', text: 'Ship it' }],
      sequence: 1,
      createdAt,
    };
    expect(MessageSchema.parse(message)).toEqual(message);
    expect(() => MessageSchema.parse({ ...message, content: [] })).toThrow();
    expect(() => MessageSchema.parse({ ...message, sequence: 0 })).toThrow();
    expect(() => MessageSchema.parse({ ...message, unexpected: true })).toThrow();
  });

  it('parses project-scoped attachment metadata and validates hash and size', () => {
    const attachment = {
      id: 'attachment-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      kind: 'image',
      name: ' mockup.png ',
      mediaType: 'image/png',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
      access: { scope: 'project', projectId: 'project-1' },
      createdAt,
    };
    expect(AttachmentSchema.parse(attachment)).toMatchObject({
      kind: 'image',
      name: 'mockup.png',
      mediaType: 'image/png',
      access: { scope: 'project', projectId: 'project-1' },
    });
    expect(AttachmentSchema.parse({ ...attachment, kind: 'file' }).kind).toBe('file');
    expect(() => AttachmentSchema.parse({ ...attachment, sha256: 'A'.repeat(64) })).toThrow();
    expect(() => AttachmentSchema.parse({ ...attachment, sizeBytes: -1 })).toThrow();
  });

  it('accepts bare MIME types and rejects parameters, whitespace, and controls', () => {
    const attachment = {
      id: 'attachment-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      kind: 'file',
      mediaType: 'text/plain',
      sha256: 'a'.repeat(64),
      sizeBytes: 42,
      access: { scope: 'project', projectId: 'project-1' },
      createdAt,
    };
    expect(
      ['text/plain', 'image/png', 'Application/Vnd.Foo+Json'].map(
        (mediaType) => AttachmentSchema.parse({ ...attachment, mediaType }).mediaType,
      ),
    ).toEqual(['text/plain', 'image/png', 'application/vnd.foo+json']);
    for (const mediaType of [
      'text/plain; token=raw-secret',
      ' text/plain',
      'text /plain',
      'text/plain\n',
      `${'a'.repeat(64)}/${'b'.repeat(64)}`,
    ]) {
      expect(() => AttachmentSchema.parse({ ...attachment, mediaType })).toThrow();
    }
  });

  it('rejects attachment access for a different project', () => {
    expect(() =>
      AttachmentSchema.parse({
        id: 'attachment-1',
        projectId: 'project-1',
        conversationId: 'conversation-1',
        kind: 'file',
        mediaType: 'text/plain',
        sha256: 'a'.repeat(64),
        sizeBytes: 42,
        access: { scope: 'project', projectId: 'project-2' },
        createdAt,
      }),
    ).toThrow();
  });

  it('parses every operation kind and optional aggregate links', () => {
    const operation = {
      id: 'operation-1',
      projectId: 'project-1',
      conversationId: 'conversation-1',
      messageId: 'message-1',
      kind: 'build',
      idempotencyKey: 'b'.repeat(64),
      runId: 'run-1',
      changeRequestId: 'change-1',
      projectVersionId: 'version-1',
      artifactReferences: [{ name: 'result', revision: 1, sha256: 'c'.repeat(64) }],
      contextSources: [],
      directExecution: true,
      createdAt,
    };
    expect(
      ['plan', 'build', 'explain', 'repair', 'visual-edit'].map((kind) =>
        OperationKindSchema.parse(kind),
      ),
    ).toEqual(['plan', 'build', 'explain', 'repair', 'visual-edit']);
    expect(OperationSchema.parse(operation)).toEqual(operation);
    expect(
      OperationSchema.parse({ ...operation, artifactReferences: undefined }).artifactReferences,
    ).toEqual([]);
    expect(
      OperationSchema.parse({ ...operation, contextSources: undefined }).contextSources,
    ).toEqual([]);
    expect(ContextSourceSchema.parse({ type: 'harness-fragment', id: 'CLAUDE.md' })).toEqual({
      type: 'harness-fragment',
      id: 'CLAUDE.md',
    });
  });

  it('records plan approval and build gating on an operation', () => {
    const plan = {
      id: 'operation-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      kind: 'plan' as const,
      idempotencyKey: 'a'.repeat(64),
      artifactReferences: [],
      contextSources: [],
      approval: { status: 'pending' as const },
      createdAt,
    };
    expect(OperationSchema.parse(plan)).toEqual(plan);

    const approved = {
      ...plan,
      approval: {
        status: 'approved' as const,
        decidedAt: createdAt,
        decidedBy: { kind: 'user' as const, id: 'ed' },
      },
    };
    expect(OperationSchema.parse(approved)).toEqual(approved);

    const buildFromPlan = {
      id: 'operation-2',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-2',
      kind: 'build' as const,
      idempotencyKey: 'b'.repeat(64),
      artifactReferences: [],
      contextSources: [],
      planOperationId: plan.id,
      createdAt,
    };
    expect(OperationSchema.parse(buildFromPlan)).toEqual(buildFromPlan);

    const buildDirect = {
      ...buildFromPlan,
      id: 'operation-3',
      planOperationId: undefined,
      directExecution: true,
    };
    expect(OperationSchema.parse(buildDirect)).toMatchObject({ directExecution: true });
  });

  it('attaches the exact structured patch to a direct visual-edit operation', () => {
    const visualEdit = {
      target: { domPath: 'main > h1', file: 'src/App.tsx', line: 12, column: 5 },
      property: 'text' as const,
      oldValue: 'Old title',
      newValue: 'New title',
    };
    expect(
      OperationSchema.parse({
        id: 'operation-visual-1',
        projectId: 'project-1',
        conversationId: 'project-1',
        messageId: 'message-visual-1',
        kind: 'visual-edit',
        idempotencyKey: 'd'.repeat(64),
        artifactReferences: [],
        visualEdit,
        createdAt,
      }),
    ).toMatchObject({ visualEdit });
  });

  it('rejects a build operation with neither or both plan gates', () => {
    const base = {
      id: 'operation-4',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-3',
      kind: 'build' as const,
      idempotencyKey: 'c'.repeat(64),
      artifactReferences: [],
      createdAt,
    };
    expect(() => OperationSchema.parse(base)).toThrow();
    expect(() =>
      OperationSchema.parse({ ...base, planOperationId: 'operation-1', directExecution: true }),
    ).toThrow();
  });

  it('parses the canonical project conversation', () => {
    const conversation = {
      id: 'project-1',
      projectId: 'project-1',
      createdAt,
    };
    expect(ConversationSchema.parse(conversation)).toEqual(conversation);
    expect(() => ConversationSchema.parse({ ...conversation, id: 'conversation-1' })).toThrow();
  });
});
