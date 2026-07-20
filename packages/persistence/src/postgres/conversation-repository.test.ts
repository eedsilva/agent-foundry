import { expect, it } from 'vitest';
import type {
  Attachment,
  ChangeRequest,
  Conversation,
  Operation,
  Project,
} from '@agent-foundry/contracts';
import { IdempotencyConflictError, NotFoundError } from '@agent-foundry/domain';
import { PostgresConversationRepository } from './conversation-repository.js';
import { PostgresProjectRepository } from './project-repository.js';
import { describePostgres } from './testing.js';

const createdAt = '2026-07-17T12:00:00.000Z';

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

function conversation(projectId = 'project-1'): Conversation {
  return { id: projectId, projectId, createdAt };
}

function attachment(id = 'attachment-1', projectId = 'project-1'): Attachment {
  return {
    id,
    projectId,
    conversationId: projectId,
    kind: 'file',
    name: 'requirements.md',
    mediaType: 'text/markdown',
    sha256: 'a'.repeat(64),
    sizeBytes: 42,
    access: { scope: 'project', projectId },
    createdAt,
  };
}

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'operation-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: 'message-1',
    kind: 'build',
    idempotencyKey: 'b'.repeat(64),
    artifactReferences: [],
    directExecution: true,
    createdAt,
    ...overrides,
  };
}

function changeRequest(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    id: 'cr-1',
    projectId: 'project-1',
    conversationId: 'project-1',
    messageId: 'message-1',
    suggestedKind: 'build',
    summary: 'Add a login page.',
    rationale: 'Imperative verb.',
    referencedDecisionIds: [],
    contextSources: [],
    status: 'proposed',
    createdAt,
    ...overrides,
  };
}

describePostgres('Postgres conversation repository', (ctx) => {
  it('creates a conversation idempotently and rejects a conflicting re-create', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    const repo = new PostgresConversationRepository(sql);

    await repo.createConversation(conversation());
    await repo.createConversation(conversation()); // identical retry is a no-op
    expect(await repo.getConversation('project-1')).toEqual(conversation());

    await expect(
      repo.createConversation({ ...conversation(), createdAt: '2026-07-18T00:00:00.000Z' }),
    ).rejects.toThrow(/already exists with different data/);
  });

  it('returns every record type from getSnapshot in the expected order', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    const repo = new PostgresConversationRepository(sql);
    await repo.createConversation(conversation());

    const message = await repo.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'Add a login page.' }],
      createdAt,
    });
    const createdAttachment = await repo.createAttachment(attachment());
    const createdOperation = await repo.createOperation(operation());
    const createdChangeRequest = await repo.createChangeRequest(changeRequest());

    const snapshot = await repo.getSnapshot('project-1');
    expect(snapshot).toEqual({
      conversation: conversation(),
      messages: [message],
      attachments: [createdAttachment],
      operations: [createdOperation],
      changeRequests: [createdChangeRequest],
    });
  });

  it('assigns contiguous message sequences under 10 concurrent appends and paginates by cursor', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    const repo = new PostgresConversationRepository(sql);
    await repo.createConversation(conversation());

    const appended = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        repo.appendMessage({
          id: `message-${String(index).padStart(2, '0')}`,
          projectId: 'project-1',
          conversationId: 'project-1',
          role: 'user',
          content: [{ type: 'text', text: `message ${index}` }],
          createdAt,
        }),
      ),
    );

    expect(appended.map((message) => message.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );

    const first = await repo.listMessages('project-1', { cursor: 0, limit: 4 });
    const second = await repo.listMessages('project-1', {
      cursor: first.at(-1)!.sequence,
      limit: 4,
    });
    expect(first.map((message) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(second.map((message) => message.sequence)).toEqual([5, 6, 7, 8]);
  });

  it('collapses identical operation retries and rejects conflicting key reuse', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    const repo = new PostgresConversationRepository(sql);
    await repo.createConversation(conversation());

    const [first, retry] = await Promise.all([
      repo.createOperation(operation()),
      repo.createOperation(
        operation({ id: 'operation-retry', createdAt: '2026-07-17T12:00:01.000Z' }),
      ),
    ]);

    expect(retry).toEqual(first);
    await expect(
      repo.createOperation(operation({ id: 'operation-conflict', kind: 'repair', createdAt })),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await repo.listOperations('project-1')).toEqual([first]);
  });

  it('updates an operation in place and rejects an unknown id', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    const repo = new PostgresConversationRepository(sql);
    await repo.createConversation(conversation());
    const op = operation({ approval: { status: 'pending' } });
    await repo.createOperation(op);

    const approved = { ...op, approval: { status: 'approved' as const, decidedAt: createdAt } };
    const updated = await repo.updateOperation(approved);
    expect(updated).toEqual(approved);
    expect(await repo.getOperation('project-1', op.id)).toEqual(approved);

    await expect(repo.updateOperation({ ...approved, id: 'missing' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('creates, lists, and updates a change request scoped to its project', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    const repo = new PostgresConversationRepository(sql);
    await repo.createConversation(conversation());

    const created = await repo.createChangeRequest(changeRequest());
    expect(await repo.getChangeRequest('project-1', created.id)).toEqual(created);
    expect(await repo.listChangeRequests('project-1')).toEqual([created]);

    const updated = await repo.updateChangeRequest({
      ...created,
      status: 'confirmed',
      confirmedKind: 'build',
      decidedAt: '2026-07-17T12:01:00.000Z',
    });
    expect((await repo.getChangeRequest('project-1', created.id))?.status).toBe('confirmed');
    expect(updated.confirmedKind).toBe('build');

    await expect(repo.updateChangeRequest({ ...updated, id: 'missing' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('rejects duplicate ids for messages, attachments, and change requests', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    const repo = new PostgresConversationRepository(sql);
    await repo.createConversation(conversation());

    await repo.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
      createdAt,
    });
    await expect(
      repo.appendMessage({
        id: 'message-1',
        projectId: 'project-1',
        conversationId: 'project-1',
        role: 'user',
        content: [{ type: 'text', text: 'again' }],
        createdAt,
      }),
    ).rejects.toThrow(/already exists/);

    await repo.createAttachment(attachment());
    await expect(repo.createAttachment(attachment())).rejects.toThrow(/already exists/);

    await repo.createChangeRequest(changeRequest());
    await expect(repo.createChangeRequest(changeRequest())).rejects.toThrow(/already exists/);
  });

  it('throws NotFoundError from every mutation when the conversation does not exist', async () => {
    const sql = ctx.db();
    const repo = new PostgresConversationRepository(sql);

    expect(await repo.getConversation('missing-project')).toBeNull();
    await expect(
      repo.appendMessage({
        id: 'message-1',
        projectId: 'missing-project',
        conversationId: 'missing-project',
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        createdAt,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repo.createAttachment(attachment('attachment-1', 'missing-project')),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repo.createOperation(
        operation({ projectId: 'missing-project', conversationId: 'missing-project' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      repo.createChangeRequest(
        changeRequest({ projectId: 'missing-project', conversationId: 'missing-project' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('redacts message content and attachment names before persisting', async () => {
    const sql = ctx.db();
    await new PostgresProjectRepository(sql).create(project());
    const repo = new PostgresConversationRepository(sql);
    await repo.createConversation(conversation());
    const secret = 'abcdef1234567890ABCDEF';

    const message = await repo.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [
        { type: 'text', text: `Authorization: Bearer ${secret}` },
        { type: 'data', value: { apiKey: secret } },
      ],
      createdAt,
    });
    const storedAttachment = await repo.createAttachment({
      ...attachment(),
      name: `token=${secret}`,
    });

    expect(message.content).toEqual([
      { type: 'text', text: 'Authorization: [REDACTED]' },
      { type: 'data', value: { apiKey: '[REDACTED]' } },
    ]);
    expect(storedAttachment.name).toContain('[REDACTED]');
    expect(await repo.getAttachment('project-1', storedAttachment.id)).toEqual(storedAttachment);
  });
});
