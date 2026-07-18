import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { describe, expect, it } from 'vitest';
import type {
  ArtifactMetadata,
  Attachment,
  Conversation,
  Message,
  Operation,
  Project,
  StoredArtifact,
  WorkflowRun,
} from '@agent-foundry/contracts';
import {
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
  type ArtifactBlobPutInput,
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type IdGenerator,
  type ProjectRepository,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import { ConversationService } from './conversation-service.js';

class FixedClock implements Clock {
  now(): Date {
    return new Date('2026-07-17T12:00:00.000Z');
  }
}

class SequentialIds implements IdGenerator {
  private nextId = 0;

  next(): string {
    this.nextId += 1;
    return `entity-${this.nextId}`;
  }
}

async function setup() {
  const projects = new MemoryProjects();
  const runs = new MemoryRuns();
  const artifacts = new MemoryArtifacts();
  const conversations = new MemoryConversations();
  const service = new ConversationService(
    projects,
    runs,
    artifacts,
    conversations,
    new FixedClock(),
    new SequentialIds(),
  );
  const project: Project = {
    id: 'project-1',
    name: 'Conversation sample',
    workflowId: 'web-app-v1',
    policyId: 'default',
    status: 'completed',
    version: 1,
    createdAt: '2026-07-17T11:00:00.000Z',
    updatedAt: '2026-07-17T11:30:00.000Z',
  };
  await projects.create(project);
  return { project, projects, runs, artifacts, conversations, service };
}

describe('ConversationService', () => {
  it('derives a legacy conversation without writing and persists it on the first message', async () => {
    const { project, conversations, service } = await setup();

    const page = await service.get(project.id);

    expect(page).toEqual({
      conversation: { id: project.id, projectId: project.id, createdAt: project.createdAt },
      messages: [],
      attachments: [],
      operations: [],
      nextCursor: null,
    });
    expect(conversations.conversationCreates).toBe(0);

    await service.createMessage(project.id, {
      role: 'user',
      content: [{ type: 'text', text: 'Build the dashboard' }],
    });
    expect(conversations.conversationCreates).toBe(1);
  });

  it('rejects cross-project attachment blocks and accepts matching project access', async () => {
    const { projects, service } = await setup();
    await projects.create({
      id: 'project-2',
      name: 'Other project',
      workflowId: 'web-app-v1',
      policyId: 'default',
      status: 'completed',
      version: 1,
      createdAt: '2026-07-17T11:00:00.000Z',
      updatedAt: '2026-07-17T11:30:00.000Z',
    });
    const foreign = await service.createAttachment('project-2', {
      kind: 'image',
      mediaType: 'image/png',
      sha256: 'a'.repeat(64),
      sizeBytes: 10,
    });

    await expect(
      service.createMessage('project-1', {
        role: 'user',
        content: [{ type: 'attachment', attachmentId: foreign.id }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const local = await service.createAttachment('project-1', {
      kind: 'image',
      mediaType: 'image/png',
      sha256: 'b'.repeat(64),
      sizeBytes: 20,
    });
    await expect(
      service.createMessage('project-1', {
        role: 'user',
        content: [{ type: 'attachment', attachmentId: local.id }],
      }),
    ).resolves.toMatchObject({ sequence: 1 });
  });

  it('validates run and artifact ownership before creating an idempotent operation', async () => {
    const { project, runs, artifacts, service } = await setup();
    const message = await service.createMessage(project.id, {
      role: 'user',
      content: [{ type: 'text', text: 'Build it' }],
    });
    const run: WorkflowRun = {
      id: 'run-1',
      projectId: project.id,
      workflowId: project.workflowId,
      status: 'queued',
      version: 1,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    await runs.create(run);
    const stored = await artifacts.put({
      projectId: project.id,
      name: 'plan.current',
      content: { ok: true },
      createdBy: 'test',
    });
    const input = {
      kind: 'explain' as const,
      idempotencyKey: 'c'.repeat(64),
      runId: run.id,
      artifactReferences: [
        {
          name: stored.metadata.name,
          revision: stored.metadata.revision,
          sha256: stored.metadata.sha256,
        },
      ],
    };

    const first = await service.createOperation(project.id, message.id, input);
    await expect(service.createOperation(project.id, message.id, input)).resolves.toEqual(first);
    await expect(
      service.createOperation(project.id, message.id, { ...input, kind: 'repair' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    await expect(
      service.createOperation(project.id, message.id, { ...input, runId: 'missing-run' }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      service.createOperation(project.id, message.id, {
        ...input,
        idempotencyKey: 'f'.repeat(64),
        runId: 'missing-run',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      service.createOperation(project.id, message.id, {
        ...input,
        idempotencyKey: 'd'.repeat(64),
        artifactReferences: [{ ...input.artifactReferences[0]!, sha256: 'd'.repeat(64) }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns stable pages and a complete restart-safe export', async () => {
    const { project, projects, runs, artifacts, conversations, service } = await setup();
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        service.createMessage(project.id, {
          role: 'user',
          content: [{ type: 'text', text: `message ${index}` }],
        }),
      ),
    );

    const first = await service.get(project.id, { cursor: 0, limit: 2 });
    const second = await service.get(project.id, { cursor: first.nextCursor!, limit: 2 });
    expect(first.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);
    expect(second.messages.map((message) => message.sequence)).toEqual([3, 4]);
    expect(second.nextCursor).toBeNull();
    await service.createOperation(project.id, first.messages[0]!.id, {
      kind: 'explain',
      idempotencyKey: 'a'.repeat(64),
      artifactReferences: [],
    });

    const restarted = new ConversationService(
      projects,
      runs,
      artifacts,
      conversations,
      new FixedClock(),
      new SequentialIds(),
    );
    const exported = await restarted.export(project.id);
    expect(exported.schemaVersion).toBe('1');
    expect(exported.project).toEqual(project);
    expect(exported.messages.map((message) => message.sequence)).toEqual([1, 2, 3, 4]);
    expect(
      exported.operations.every((operation) =>
        exported.messages.some((message) => message.id === operation.messageId),
      ),
    ).toBe(true);
    expect(conversations.snapshotReads).toBe(1);
  });
});

class MemoryProjects implements ProjectRepository {
  private readonly values = new Map<string, Project>();

  create(project: Project): Promise<void> {
    this.values.set(project.id, project);
    return Promise.resolve();
  }

  get(projectId: string): Promise<Project | null> {
    return Promise.resolve(this.values.get(projectId) ?? null);
  }

  update(project: Project): Promise<Project> {
    this.values.set(project.id, project);
    return Promise.resolve(project);
  }

  list(): Promise<Project[]> {
    return Promise.resolve([...this.values.values()]);
  }
}

class MemoryRuns implements WorkflowRunRepository {
  private readonly values = new Map<string, WorkflowRun>();

  create(run: WorkflowRun): Promise<void> {
    this.values.set(run.id, run);
    return Promise.resolve();
  }

  get(runId: string): Promise<WorkflowRun | null> {
    return Promise.resolve(this.values.get(runId) ?? null);
  }

  list(projectId: string): Promise<WorkflowRun[]> {
    return Promise.resolve([...this.values.values()].filter((run) => run.projectId === projectId));
  }

  update(run: WorkflowRun): Promise<WorkflowRun> {
    this.values.set(run.id, run);
    return Promise.resolve(run);
  }
}

class MemoryArtifacts implements ArtifactStore {
  private readonly values = new Map<string, StoredArtifact>();
  private readonly blobs = new Map<string, { metadata: ArtifactMetadata; buffer: Buffer }>();

  put(input: Parameters<ArtifactStore['put']>[0]): Promise<StoredArtifact> {
    const stored: StoredArtifact = {
      metadata: {
        projectId: input.projectId,
        name: input.name,
        revision: 1,
        contentType: input.contentType ?? 'application/json',
        createdAt: '2026-07-17T12:00:00.000Z',
        createdBy: input.createdBy,
        sha256: 'e'.repeat(64),
      },
      content: input.content,
    };
    this.values.set(`${input.projectId}/${input.name}/1`, stored);
    return Promise.resolve(stored);
  }

  async putBlob(input: ArtifactBlobPutInput, source: Readable): Promise<ArtifactMetadata> {
    const content = await buffer(source);
    const prefix = `${input.projectId}/${input.name}/`;
    const revision =
      [...this.values.keys()].filter((key) => key.startsWith(prefix)).length +
      [...this.blobs.keys()].filter((key) => key.startsWith(prefix)).length +
      1;
    const metadata: ArtifactMetadata = {
      projectId: input.projectId,
      name: input.name,
      revision,
      contentType: input.contentType,
      createdAt: '2026-07-17T12:00:00.000Z',
      createdBy: input.createdBy,
      storage: 'blob',
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
    this.blobs.set(`${input.projectId}/${input.name}/${revision}`, { metadata, buffer: content });
    return metadata;
  }

  getBlobStream(projectId: string, name: string, revision: number): Promise<Readable | null> {
    const entry = this.blobs.get(`${projectId}/${name}/${revision}`);
    return Promise.resolve(entry ? Readable.from(entry.buffer) : null);
  }

  getLatest(projectId: string, name: string): Promise<StoredArtifact | null> {
    return this.getRevision(projectId, name, 1);
  }

  getRevision(projectId: string, name: string, revision: number): Promise<StoredArtifact | null> {
    return Promise.resolve(this.values.get(`${projectId}/${name}/${revision}`) ?? null);
  }

  listLatest(): Promise<StoredArtifact[]> {
    return Promise.resolve([...this.values.values()]);
  }

  listMetadata(): Promise<StoredArtifact['metadata'][]> {
    return Promise.resolve([...this.values.values()].map((artifact) => artifact.metadata));
  }
}

class MemoryConversations implements ConversationRepository {
  conversationCreates = 0;
  snapshotReads = 0;
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages: Message[] = [];
  private readonly attachments: Attachment[] = [];
  private readonly operations: Operation[] = [];

  createConversation(conversation: Conversation): Promise<void> {
    if (!this.conversations.has(conversation.projectId)) this.conversationCreates += 1;
    this.conversations.set(conversation.projectId, conversation);
    return Promise.resolve();
  }

  getConversation(projectId: string): Promise<Conversation | null> {
    return Promise.resolve(this.conversations.get(projectId) ?? null);
  }

  getSnapshot(projectId: string) {
    this.snapshotReads += 1;
    return Promise.resolve({
      conversation: this.conversations.get(projectId) ?? null,
      messages: this.messages.filter((message) => message.projectId === projectId),
      attachments: this.attachments.filter((attachment) => attachment.projectId === projectId),
      operations: this.operations.filter((operation) => operation.projectId === projectId),
    });
  }

  appendMessage(message: Omit<Message, 'sequence'>): Promise<Message> {
    const stored = {
      ...message,
      sequence: this.messages.filter((item) => item.projectId === message.projectId).length + 1,
    };
    this.messages.push(stored);
    return Promise.resolve(stored);
  }

  listMessages(
    projectId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<Message[]> {
    const values = this.messages.filter(
      (message) => message.projectId === projectId && message.sequence > (options.cursor ?? 0),
    );
    return Promise.resolve(options.limit === undefined ? values : values.slice(0, options.limit));
  }

  createAttachment(attachment: Attachment): Promise<Attachment> {
    this.attachments.push(attachment);
    return Promise.resolve(attachment);
  }

  getAttachment(projectId: string, attachmentId: string): Promise<Attachment | null> {
    return Promise.resolve(
      this.attachments.find(
        (attachment) => attachment.projectId === projectId && attachment.id === attachmentId,
      ) ?? null,
    );
  }

  listAttachments(projectId: string): Promise<Attachment[]> {
    return Promise.resolve(
      this.attachments.filter((attachment) => attachment.projectId === projectId),
    );
  }

  createOperation(operation: Operation): Promise<Operation> {
    const existing = this.operations.find(
      (item) =>
        item.projectId === operation.projectId && item.idempotencyKey === operation.idempotencyKey,
    );
    if (existing) {
      const comparable = (value: Operation) => {
        const { id: _id, createdAt: _createdAt, ...input } = value;
        return input;
      };
      if (JSON.stringify(comparable(existing)) !== JSON.stringify(comparable(operation))) {
        return Promise.reject(new IdempotencyConflictError(operation.idempotencyKey));
      }
      return Promise.resolve(existing);
    }
    this.operations.push(operation);
    return Promise.resolve(operation);
  }

  listOperations(projectId: string): Promise<Operation[]> {
    return Promise.resolve(
      this.operations.filter((operation) => operation.projectId === projectId),
    );
  }

  getOperation(projectId: string, operationId: string): Promise<Operation | null> {
    return Promise.resolve(
      this.operations.find(
        (operation) => operation.projectId === projectId && operation.id === operationId,
      ) ?? null,
    );
  }

  updateOperation(operation: Operation): Promise<Operation> {
    const index = this.operations.findIndex((item) => item.id === operation.id);
    if (index !== -1) {
      this.operations[index] = operation;
    } else {
      this.operations.push(operation);
      throw new NotFoundError(`Operation ${operation.id} not found`);
    }
    return Promise.resolve(operation);
  }
}
