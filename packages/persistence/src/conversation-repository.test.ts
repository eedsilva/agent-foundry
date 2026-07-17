import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Attachment, Conversation, Operation } from '@agent-foundry/contracts';
import { IdempotencyConflictError } from '@agent-foundry/domain';
import { FileConversationRepository } from './conversation-repository.js';

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
    createdAt,
    ...overrides,
  };
}

describe('FileConversationRepository', () => {
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
});
