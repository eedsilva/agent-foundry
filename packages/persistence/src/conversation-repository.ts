import { join } from 'node:path';
import {
  AttachmentSchema,
  ChangeRequestSchema,
  ConversationSchema,
  MessageSchema,
  OperationSchema,
  type Attachment,
  type ChangeRequest,
  type Conversation,
  type Message,
  type Operation,
} from '@agent-foundry/contracts';
import {
  IdempotencyConflictError,
  NotFoundError,
  ValidationError,
  redactString,
  redactUnknown,
  type ConversationRepository,
  type ConversationSnapshot,
} from '@agent-foundry/domain';
import {
  atomicWriteJson,
  atomicWriteText,
  exists,
  readJsonLines,
  readJsonOrNull,
  safeSegment,
  withRecoverableDirectoryLock,
} from './fs-utils.js';

export class FileConversationRepository implements ConversationRepository {
  constructor(
    private readonly dataDir: string,
    private readonly writeText: (path: string, value: string) => Promise<void> = atomicWriteText,
  ) {}

  async createConversation(conversation: Conversation): Promise<void> {
    const parsed = ConversationSchema.parse(conversation);
    await this.withLock(parsed.projectId, async () => {
      const existing = await this.getConversation(parsed.projectId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
          throw new Error(`Conversation ${parsed.id} already exists with different data`);
        }
        return;
      }
      await atomicWriteJson(this.conversationPath(parsed.projectId), parsed);
    });
  }

  async getConversation(projectId: string): Promise<Conversation | null> {
    const safeProjectId = safeSegment(projectId);
    const value = await readJsonOrNull<unknown>(this.conversationPath(safeProjectId));
    if (value === null) return null;
    const conversation = ConversationSchema.parse(value);
    if (conversation.id !== safeProjectId || conversation.projectId !== safeProjectId) {
      throw new ValidationError('Conversation identity does not match requested project');
    }
    return conversation;
  }

  async getSnapshot(projectId: string): Promise<ConversationSnapshot> {
    const safeProjectId = safeSegment(projectId);
    if (!(await exists(this.rootFor(safeProjectId)))) {
      return {
        conversation: null,
        messages: [],
        attachments: [],
        operations: [],
        changeRequests: [],
      };
    }
    return this.withLock(safeProjectId, async () => ({
      conversation: await this.getConversation(safeProjectId),
      messages: await this.readMessages(safeProjectId),
      attachments: await this.readAttachments(safeProjectId),
      operations: await this.readOperations(safeProjectId),
      changeRequests: await this.readChangeRequests(safeProjectId),
    }));
  }

  async appendMessage(message: Omit<Message, 'sequence'>): Promise<Message> {
    const projectId = safeSegment(message.projectId);
    return this.withLock(projectId, async () => {
      await this.requireConversation(projectId, message.conversationId);
      const existing = await this.readMessages(projectId);
      if (existing.some((item) => item.id === message.id)) {
        throw new Error(`Message ${message.id} already exists`);
      }
      const parsed = MessageSchema.parse({
        ...message,
        sequence: (existing.at(-1)?.sequence ?? 0) + 1,
      });
      const redacted = MessageSchema.parse({
        ...parsed,
        content: parsed.content.map((block) => {
          if (block.type === 'text') return { ...block, text: redactString(block.text) };
          if (block.type === 'data') return { ...block, value: redactUnknown(block.value) };
          return block;
        }),
      });
      await this.writeJsonLines(this.messagesPath(projectId), [...existing, redacted]);
      return redacted;
    });
  }

  async listMessages(
    projectId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<Message[]> {
    const cursor = options.cursor ?? 0;
    const messages = (await this.readMessages(projectId)).filter(
      (message) => message.sequence > cursor,
    );
    return options.limit === undefined ? messages : messages.slice(0, options.limit);
  }

  async createAttachment(attachment: Attachment): Promise<Attachment> {
    const parsed = AttachmentSchema.parse(attachment);
    const redacted = AttachmentSchema.parse({
      ...parsed,
      ...(parsed.name !== undefined ? { name: redactString(parsed.name) } : {}),
    });
    return this.withLock(parsed.projectId, async () => {
      await this.requireConversation(parsed.projectId, parsed.conversationId);
      const existing = await this.readAttachments(parsed.projectId);
      if (existing.some((item) => item.id === parsed.id)) {
        throw new Error(`Attachment ${parsed.id} already exists`);
      }
      await this.writeJsonLines(this.attachmentsPath(parsed.projectId), [...existing, redacted]);
      return redacted;
    });
  }

  async getAttachment(projectId: string, attachmentId: string): Promise<Attachment | null> {
    safeSegment(attachmentId);
    return (
      (await this.readAttachments(projectId)).find(
        (attachment) => attachment.id === attachmentId,
      ) ?? null
    );
  }

  async listAttachments(projectId: string): Promise<Attachment[]> {
    return this.readAttachments(projectId);
  }

  async createOperation(operation: Operation): Promise<Operation> {
    const parsed = OperationSchema.parse(operation);
    return this.withLock(parsed.projectId, async () => {
      await this.requireConversation(parsed.projectId, parsed.conversationId);
      // ponytail: full-file JSONL scans; add sequence, attachment/id, pagination, and
      // idempotency indexes if measured volume makes them hot.
      const operations = await this.readOperations(parsed.projectId);
      const existing = operations.find((item) => item.idempotencyKey === parsed.idempotencyKey);
      if (existing) {
        if (JSON.stringify(operationInput(existing)) !== JSON.stringify(operationInput(parsed))) {
          throw new IdempotencyConflictError(parsed.idempotencyKey);
        }
        return existing;
      }
      await this.writeJsonLines(this.operationsPath(parsed.projectId), [...operations, parsed]);
      return parsed;
    });
  }

  async getOperation(projectId: string, operationId: string): Promise<Operation | null> {
    return (
      (await this.readOperations(projectId)).find((operation) => operation.id === operationId) ??
      null
    );
  }

  async updateOperation(
    operation: Operation,
    expectedProposalRevision?: number,
  ): Promise<Operation> {
    const parsed = OperationSchema.parse(operation);
    return this.withLock(parsed.projectId, async () => {
      const operations = await this.readOperations(parsed.projectId);
      const index = operations.findIndex((item) => item.id === parsed.id);
      if (index === -1) throw new NotFoundError(`Operation ${parsed.id} not found`);
      const existing = operations[index]!;
      if (
        expectedProposalRevision !== undefined &&
        (existing.approval?.status !== 'pending' ||
          existing.artifactReferences[0]?.revision !== expectedProposalRevision)
      ) {
        throw new ValidationError(`Plan operation ${parsed.id} is no longer editable`);
      }
      operations[index] = parsed;
      await this.writeJsonLines(this.operationsPath(parsed.projectId), operations);
      return parsed;
    });
  }

  async listOperations(projectId: string): Promise<Operation[]> {
    return this.readOperations(projectId);
  }

  async createChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest> {
    const parsed = ChangeRequestSchema.parse(changeRequest);
    return this.withLock(parsed.projectId, async () => {
      await this.requireConversation(parsed.projectId, parsed.conversationId);
      const existing = await this.readChangeRequests(parsed.projectId);
      if (existing.some((item) => item.id === parsed.id)) {
        throw new Error(`Change request ${parsed.id} already exists`);
      }
      await this.writeJsonLines(this.changeRequestsPath(parsed.projectId), [...existing, parsed]);
      return parsed;
    });
  }

  async getChangeRequest(
    projectId: string,
    changeRequestId: string,
  ): Promise<ChangeRequest | null> {
    return (
      (await this.readChangeRequests(projectId)).find((item) => item.id === changeRequestId) ?? null
    );
  }

  async updateChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest> {
    const parsed = ChangeRequestSchema.parse(changeRequest);
    return this.withLock(parsed.projectId, async () => {
      const changeRequests = await this.readChangeRequests(parsed.projectId);
      const index = changeRequests.findIndex((item) => item.id === parsed.id);
      if (index === -1) throw new NotFoundError(`Change request ${parsed.id} not found`);
      changeRequests[index] = parsed;
      await this.writeJsonLines(this.changeRequestsPath(parsed.projectId), changeRequests);
      return parsed;
    });
  }

  async listChangeRequests(projectId: string): Promise<ChangeRequest[]> {
    return this.readChangeRequests(projectId);
  }

  private async requireConversation(projectId: string, conversationId: string): Promise<void> {
    const conversation = await this.getConversation(projectId);
    if (!conversation) throw new NotFoundError(`Conversation ${projectId} not found`);
    if (conversation.id !== conversationId || conversation.projectId !== projectId) {
      throw new ValidationError('Conversation does not belong to the target project');
    }
  }

  private async readMessages(projectId: string): Promise<Message[]> {
    return (await readJsonLines<unknown>(this.messagesPath(projectId))).map((value) =>
      MessageSchema.parse(value),
    );
  }

  private async readAttachments(projectId: string): Promise<Attachment[]> {
    return (await readJsonLines<unknown>(this.attachmentsPath(projectId))).map((value) =>
      AttachmentSchema.parse(value),
    );
  }

  private async readOperations(projectId: string): Promise<Operation[]> {
    return (await readJsonLines<unknown>(this.operationsPath(projectId))).map((value) =>
      OperationSchema.parse(value),
    );
  }

  private async readChangeRequests(projectId: string): Promise<ChangeRequest[]> {
    return (await readJsonLines<unknown>(this.changeRequestsPath(projectId))).map((value) =>
      ChangeRequestSchema.parse(value),
    );
  }

  private writeJsonLines(path: string, values: unknown[]): Promise<void> {
    return this.writeText(path, `${values.map((value) => JSON.stringify(value)).join('\n')}\n`);
  }

  private rootFor(projectId: string): string {
    return join(this.dataDir, 'projects', safeSegment(projectId), 'conversation');
  }

  private withLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    return withRecoverableDirectoryLock(
      this.dataDir,
      ['projects', safeSegment(projectId), 'conversation', '.lock'],
      operation,
    );
  }

  private conversationPath(projectId: string): string {
    return join(this.rootFor(projectId), 'conversation.json');
  }

  private messagesPath(projectId: string): string {
    return join(this.rootFor(projectId), 'messages.jsonl');
  }

  private attachmentsPath(projectId: string): string {
    return join(this.rootFor(projectId), 'attachments.jsonl');
  }

  private operationsPath(projectId: string): string {
    return join(this.rootFor(projectId), 'operations.jsonl');
  }

  private changeRequestsPath(projectId: string): string {
    return join(this.rootFor(projectId), 'changeRequests.jsonl');
  }
}

// Exported so the Postgres adapter's idempotency-key comparison stays identical
// to this file adapter's (see postgres/conversation-repository.ts).
export function operationInput(operation: Operation): Omit<Operation, 'id' | 'createdAt'> {
  const { id: _id, createdAt: _createdAt, ...input } = operation;
  return input;
}
