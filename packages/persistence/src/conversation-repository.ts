import { join } from 'node:path';
import {
  AttachmentSchema,
  ConversationSchema,
  MessageSchema,
  OperationSchema,
  type Attachment,
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
} from '@agent-foundry/domain';
import {
  appendJsonLine,
  atomicWriteJson,
  readJsonLines,
  readJsonOrNull,
  safeSegment,
  withRecoverableDirectoryLock,
} from './fs-utils.js';

export class FileConversationRepository implements ConversationRepository {
  constructor(private readonly dataDir: string) {}

  async createConversation(conversation: Conversation): Promise<void> {
    const parsed = ConversationSchema.parse(conversation);
    if (parsed.id !== parsed.projectId) {
      throw new ValidationError('Conversation id must match projectId');
    }
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
    const value = await readJsonOrNull<unknown>(this.conversationPath(projectId));
    return value === null ? null : ConversationSchema.parse(value);
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
      await appendJsonLine(this.messagesPath(projectId), redacted);
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
      await appendJsonLine(this.attachmentsPath(parsed.projectId), redacted);
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
      await appendJsonLine(this.operationsPath(parsed.projectId), parsed);
      return parsed;
    });
  }

  async listOperations(projectId: string): Promise<Operation[]> {
    return this.readOperations(projectId);
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
}

function operationInput(operation: Operation): Omit<Operation, 'id' | 'createdAt'> {
  const { id: _id, createdAt: _createdAt, ...input } = operation;
  return input;
}
