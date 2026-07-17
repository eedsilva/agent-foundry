import { describe, expect, it } from 'vitest';
import {
  AttachmentSchema,
  ConversationSchema,
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
      mediaType: ' image/png ',
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
  });

  it('parses the canonical project conversation', () => {
    const conversation = {
      id: 'conversation-1',
      projectId: 'project-1',
      createdAt,
    };
    expect(ConversationSchema.parse(conversation)).toEqual(conversation);
  });
});
