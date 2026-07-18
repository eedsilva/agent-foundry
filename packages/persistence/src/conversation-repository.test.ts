import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Attachment, Conversation, Operation } from '@agent-foundry/contracts';
import { IdempotencyConflictError, NotFoundError } from '@agent-foundry/domain';
import { FileConversationRepository } from './conversation-repository.js';
import { atomicWriteText } from './fs-utils.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agent-foundry-conversation-'));
  temporaryDirectories.push(path);
  return path;
}

const createdAt = '2026-07-17T12:00:00.000Z';
const conversation: Conversation = {
  id: 'project-1',
  projectId: 'project-1',
  createdAt,
};

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

describe('FileConversationRepository', () => {
  it('rejects a persisted conversation whose id differs from its project', async () => {
    const dataDir = await temporaryDataDir();
    const root = join(dataDir, 'projects', 'project-1', 'conversation');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'conversation.json'),
      `${JSON.stringify({ ...conversation, id: 'other-conversation' })}\n`,
    );

    await expect(
      new FileConversationRepository(dataDir).getConversation('project-1'),
    ).rejects.toThrow();
  });

  it('rejects an internally canonical conversation stored under another project', async () => {
    const dataDir = await temporaryDataDir();
    const root = join(dataDir, 'projects', 'project-1', 'conversation');
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'conversation.json'),
      `${JSON.stringify({ ...conversation, id: 'project-2', projectId: 'project-2' })}\n`,
    );
    const repository = new FileConversationRepository(dataDir);

    const reads = await Promise.allSettled([
      repository.getConversation('project-1'),
      repository.getSnapshot('project-1'),
    ]);
    expect(reads.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  });

  it('does not treat an ENOTDIR conversation path as absent legacy storage', async () => {
    const dataDir = await temporaryDataDir();
    await writeFile(join(dataDir, 'projects'), 'corrupt path shape');

    await expect(
      new FileConversationRepository(dataDir).getSnapshot('project-1'),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('recovers an abandoned conversation lock before creating the aggregate', async () => {
    const dataDir = await temporaryDataDir();
    const lockPath = join(dataDir, 'projects', 'project-1', 'conversation', '.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, 'owner.json'),
      JSON.stringify({
        token: '11111111-1111-4111-8111-111111111111',
        pid: 2_147_483_647,
        acquiredAt: new Date().toISOString(),
      }),
    );

    const repository = new FileConversationRepository(dataDir);
    await repository.createConversation(conversation);

    await expect(repository.getConversation('project-1')).resolves.toEqual(conversation);
  }, 12_000);

  it('assigns contiguous message sequences under concurrent appends and paginates stably', async () => {
    const repository = new FileConversationRepository(await temporaryDataDir());
    await repository.createConversation(conversation);

    const appended = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        repository.appendMessage({
          id: `message-${String(index).padStart(2, '0')}`,
          projectId: conversation.projectId,
          conversationId: conversation.id,
          role: 'user',
          content: [{ type: 'text', text: `message ${index}` }],
          createdAt,
        }),
      ),
    );

    expect(appended.map((message) => message.sequence).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    const first = await repository.listMessages('project-1', { cursor: 0, limit: 7 });
    const second = await repository.listMessages('project-1', {
      cursor: first.at(-1)!.sequence,
      limit: 7,
    });
    expect(first.map((message) => message.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(second.map((message) => message.sequence)).toEqual([8, 9, 10, 11, 12, 13, 14]);
  });

  it('stores project-scoped attachments and reconstructs the aggregate from the same directory', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FileConversationRepository(dataDir);
    await repository.createConversation(conversation);
    await repository.createAttachment(attachment());
    await repository.createAttachment(attachment('attachment-2'));

    const restarted = new FileConversationRepository(dataDir);
    await expect(restarted.getConversation('project-1')).resolves.toEqual(conversation);
    await expect(restarted.getAttachment('project-1', 'attachment-1')).resolves.toEqual(
      attachment(),
    );
    await expect(restarted.getAttachment('project-2', 'attachment-1')).resolves.toBeNull();
    await expect(restarted.listAttachments('project-1')).resolves.toEqual([
      attachment(),
      attachment('attachment-2'),
    ]);
  });

  it('collapses identical operation retries and rejects conflicting key reuse', async () => {
    const repository = new FileConversationRepository(await temporaryDataDir());
    await repository.createConversation(conversation);

    const [first, retry] = await Promise.all([
      repository.createOperation(operation()),
      repository.createOperation(
        operation({ id: 'operation-retry', createdAt: '2026-07-17T12:00:01.000Z' }),
      ),
    ]);

    expect(retry).toEqual(first);
    await expect(
      repository.createOperation(
        operation({ id: 'operation-conflict', kind: 'repair', createdAt }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(repository.listOperations('project-1')).resolves.toEqual([first]);
  });

  it('fetches a single operation by id and returns null when absent', async () => {
    const dataDir = await temporaryDataDir();
    const repo = new FileConversationRepository(dataDir);
    await repo.createConversation({ id: 'project-1', projectId: 'project-1', createdAt });
    const operation = {
      id: 'operation-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      kind: 'plan' as const,
      idempotencyKey: 'a'.repeat(64),
      artifactReferences: [],
      createdAt,
    };
    await repo.createOperation(operation);

    expect(await repo.getOperation('project-1', 'operation-1')).toEqual(operation);
    expect(await repo.getOperation('project-1', 'missing')).toBeNull();
  });

  it('updates an existing operation in place and rejects an unknown id', async () => {
    const dataDir = await temporaryDataDir();
    const repo = new FileConversationRepository(dataDir);
    await repo.createConversation({ id: 'project-1', projectId: 'project-1', createdAt });
    const operation = {
      id: 'operation-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      messageId: 'message-1',
      kind: 'plan' as const,
      idempotencyKey: 'a'.repeat(64),
      artifactReferences: [],
      approval: { status: 'pending' as const },
      createdAt,
    };
    await repo.createOperation(operation);

    const approved = {
      ...operation,
      approval: { status: 'approved' as const, decidedAt: createdAt },
    };
    const updated = await repo.updateOperation(approved);
    expect(updated).toEqual(approved);
    expect(await repo.getOperation('project-1', 'operation-1')).toEqual(approved);

    await expect(repo.updateOperation({ ...approved, id: 'missing' })).rejects.toThrow(
      NotFoundError,
    );
  });

  it('redacts message content and attachment names before writing JSONL', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FileConversationRepository(dataDir);
    await repository.createConversation(conversation);
    const secret = 'abcdef1234567890ABCDEF';

    const message = await repository.appendMessage({
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
    const storedAttachment = await repository.createAttachment({
      ...attachment(),
      name: `token=${secret}`,
    });

    expect(message.content).toEqual([
      { type: 'text', text: 'Authorization: [REDACTED]' },
      { type: 'data', value: { apiKey: '[REDACTED]' } },
    ]);
    expect(storedAttachment.name).toContain('[REDACTED]');
    const root = join(dataDir, 'projects', 'project-1', 'conversation');
    const persisted = await Promise.all(
      ['messages.jsonl', 'attachments.jsonl'].map((file) => readFile(join(root, file), 'utf8')),
    );
    expect(persisted.join('\n')).not.toContain(secret);
    await expect(access(join(root, 'conversation.json'))).resolves.toBeUndefined();
  });

  it('keeps the prior JSONL reconstructable when atomic replacement is interrupted', async () => {
    const dataDir = await temporaryDataDir();
    const repository = new FileConversationRepository(dataDir);
    await repository.createConversation(conversation);
    await repository.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'first' }],
      createdAt,
    });

    const interrupted = new FileConversationRepository(dataDir, async (path, value) => {
      await writeFile(`${path}.interrupted.tmp`, value);
      throw new Error('simulated interruption before rename');
    });
    await expect(
      interrupted.appendMessage({
        id: 'message-2',
        projectId: 'project-1',
        conversationId: 'project-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'second' }],
        createdAt,
      }),
    ).rejects.toThrow('simulated interruption before rename');

    const restarted = new FileConversationRepository(dataDir);
    await expect(restarted.listMessages('project-1')).resolves.toMatchObject([
      { id: 'message-1', sequence: 1 },
    ]);
    expect(await readdir(join(dataDir, 'projects', 'project-1', 'conversation'))).toContain(
      'messages.jsonl.interrupted.tmp',
    );

    await restarted.appendMessage({
      id: 'message-2',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'second' }],
      createdAt,
    });
    await expect(restarted.listMessages('project-1')).resolves.toMatchObject([
      { id: 'message-1', sequence: 1 },
      { id: 'message-2', sequence: 2 },
    ]);
  });

  it('takes one locked aggregate snapshot without creating legacy storage', async () => {
    const legacyDataDir = await temporaryDataDir();
    const legacy = new FileConversationRepository(legacyDataDir);
    await expect(legacy.getSnapshot('legacy-project')).resolves.toEqual({
      conversation: null,
      messages: [],
      attachments: [],
      operations: [],
    });
    await expect(
      access(join(legacyDataDir, 'projects', 'legacy-project', 'conversation')),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const dataDir = await temporaryDataDir();
    let releaseOperation!: () => void;
    const operationRelease = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    let operationWriteStarted!: () => void;
    const operationStarted = new Promise<void>((resolve) => {
      operationWriteStarted = resolve;
    });
    const repository = new FileConversationRepository(dataDir, async (path, value) => {
      if (path.endsWith('operations.jsonl')) {
        operationWriteStarted();
        await operationRelease;
      }
      await atomicWriteText(path, value);
    });
    await repository.createConversation(conversation);
    await repository.appendMessage({
      id: 'message-1',
      projectId: 'project-1',
      conversationId: 'project-1',
      role: 'user',
      content: [{ type: 'text', text: 'build it' }],
      createdAt,
    });

    const operationWrite = repository.createOperation(operation());
    await operationStarted;
    const snapshot = repository.getSnapshot('project-1');
    releaseOperation();

    await operationWrite;
    const captured = await snapshot;
    expect(captured.operations).toHaveLength(1);
    expect(captured.messages.map((message) => message.id)).toContain(
      captured.operations[0]!.messageId,
    );
  });
});
