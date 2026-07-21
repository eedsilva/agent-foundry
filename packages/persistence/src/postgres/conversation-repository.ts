import type { ISql } from 'postgres';
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
import type { PostgresDb } from './client.js';
import { isUniqueViolation } from './versioned.js';

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly sql: PostgresDb) {}

  async createConversation(conversation: Conversation): Promise<void> {
    const parsed = ConversationSchema.parse(conversation);
    await this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'conversation:' + parsed.projectId}))`;
      const existing = await selectConversation(tx, parsed.projectId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed)) {
          throw new Error(`Conversation ${parsed.id} already exists with different data`);
        }
        return;
      }
      await tx`insert into conversations (project_id, data) values (${parsed.projectId}, ${tx.json(parsed as any)})`;
    });
  }

  async getConversation(projectId: string): Promise<Conversation | null> {
    return selectConversation(this.sql, projectId);
  }

  async getSnapshot(projectId: string): Promise<ConversationSnapshot> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'conversation:' + projectId}))`;
      const conversation = await selectConversation(tx, projectId);
      const messageRows = await tx<{ data: unknown }[]>`
        select data from conversation_messages
        where project_id = ${projectId} order by sequence asc`;
      const attachmentRows = await tx<{ data: unknown }[]>`
        select data from conversation_attachments
        where project_id = ${projectId} order by created_at asc, id asc`;
      const operationRows = await tx<{ data: unknown }[]>`
        select data from conversation_operations
        where project_id = ${projectId} order by created_at asc, id asc`;
      const changeRequestRows = await tx<{ data: unknown }[]>`
        select data from conversation_change_requests
        where project_id = ${projectId} order by created_at asc, id asc`;
      return {
        conversation,
        messages: messageRows.map((row) => MessageSchema.parse(row.data)),
        attachments: attachmentRows.map((row) => AttachmentSchema.parse(row.data)),
        operations: operationRows.map((row) => OperationSchema.parse(row.data)),
        changeRequests: changeRequestRows.map((row) => ChangeRequestSchema.parse(row.data)),
      };
    });
  }

  async appendMessage(message: Omit<Message, 'sequence'>): Promise<Message> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'conversation:' + message.projectId}))`;
      await requireConversation(tx, message.projectId, message.conversationId);
      const [row] = await tx<{ next: number }[]>`
        select coalesce(max(sequence), 0) + 1 as next
        from conversation_messages where project_id = ${message.projectId}`;
      const next = row?.next ?? 1;
      const parsed = MessageSchema.parse({ ...message, sequence: next });
      const redacted = MessageSchema.parse({
        ...parsed,
        content: parsed.content.map((block) => {
          if (block.type === 'text') return { ...block, text: redactString(block.text) };
          if (block.type === 'data') return { ...block, value: redactUnknown(block.value) };
          return block;
        }),
      });
      try {
        await tx`
          insert into conversation_messages (project_id, sequence, id, data)
          values (${redacted.projectId}, ${redacted.sequence}, ${redacted.id}, ${tx.json(redacted as any)})`;
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error(`Message ${redacted.id} already exists`);
        throw error;
      }
      return redacted;
    });
  }

  async listMessages(
    projectId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<Message[]> {
    const cursor = options.cursor ?? 0;
    const rows = await this.sql<{ data: unknown }[]>`
      select data from conversation_messages
      where project_id = ${projectId} and sequence > ${cursor}
      order by sequence asc
      ${options.limit === undefined ? this.sql`` : this.sql`limit ${options.limit}`}`;
    return rows.map((row) => MessageSchema.parse(row.data));
  }

  async createAttachment(attachment: Attachment): Promise<Attachment> {
    const parsed = AttachmentSchema.parse(attachment);
    const redacted = AttachmentSchema.parse({
      ...parsed,
      ...(parsed.name !== undefined ? { name: redactString(parsed.name) } : {}),
    });
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'conversation:' + redacted.projectId}))`;
      await requireConversation(tx, redacted.projectId, redacted.conversationId);
      try {
        await tx`
          insert into conversation_attachments (id, project_id, created_at, data)
          values (${redacted.id}, ${redacted.projectId}, ${redacted.createdAt}, ${tx.json(redacted as any)})`;
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error(`Attachment ${redacted.id} already exists`);
        throw error;
      }
      return redacted;
    });
  }

  async getAttachment(projectId: string, attachmentId: string): Promise<Attachment | null> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from conversation_attachments where project_id = ${projectId} and id = ${attachmentId}`;
    return rows[0] ? AttachmentSchema.parse(rows[0].data) : null;
  }

  async listAttachments(projectId: string): Promise<Attachment[]> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from conversation_attachments
      where project_id = ${projectId} order by created_at asc, id asc`;
    return rows.map((row) => AttachmentSchema.parse(row.data));
  }

  async createOperation(operation: Operation): Promise<Operation> {
    const parsed = OperationSchema.parse(operation);
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'conversation:' + parsed.projectId}))`;
      await requireConversation(tx, parsed.projectId, parsed.conversationId);
      const [existingRow] = await tx<{ data: unknown }[]>`
        select data from conversation_operations
        where project_id = ${parsed.projectId} and idempotency_key = ${parsed.idempotencyKey}
        limit 1`;
      if (existingRow) {
        const existing = OperationSchema.parse(existingRow.data);
        if (JSON.stringify(operationInput(existing)) !== JSON.stringify(operationInput(parsed))) {
          throw new IdempotencyConflictError(parsed.idempotencyKey);
        }
        return existing;
      }
      try {
        await tx`
          insert into conversation_operations (id, project_id, idempotency_key, created_at, data)
          values (${parsed.id}, ${parsed.projectId}, ${parsed.idempotencyKey}, ${parsed.createdAt}, ${tx.json(parsed as any)})`;
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error(`Operation ${parsed.id} already exists`);
        throw error;
      }
      return parsed;
    });
  }

  async getOperation(projectId: string, operationId: string): Promise<Operation | null> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from conversation_operations where project_id = ${projectId} and id = ${operationId}`;
    return rows[0] ? OperationSchema.parse(rows[0].data) : null;
  }

  async updateOperation(operation: Operation): Promise<Operation> {
    const parsed = OperationSchema.parse(operation);
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'conversation:' + parsed.projectId}))`;
      const result = await tx`
        update conversation_operations set data = ${tx.json(parsed as any)}
        where id = ${parsed.id} and project_id = ${parsed.projectId}`;
      if (result.count === 0) throw new NotFoundError(`Operation ${parsed.id} not found`);
      return parsed;
    });
  }

  async listOperations(projectId: string): Promise<Operation[]> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from conversation_operations
      where project_id = ${projectId} order by created_at asc, id asc`;
    return rows.map((row) => OperationSchema.parse(row.data));
  }

  async createChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest> {
    const parsed = ChangeRequestSchema.parse(changeRequest);
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'conversation:' + parsed.projectId}))`;
      await requireConversation(tx, parsed.projectId, parsed.conversationId);
      try {
        await tx`
          insert into conversation_change_requests (id, project_id, created_at, data)
          values (${parsed.id}, ${parsed.projectId}, ${parsed.createdAt}, ${tx.json(parsed as any)})`;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new Error(`Change request ${parsed.id} already exists`);
        }
        throw error;
      }
      return parsed;
    });
  }

  async getChangeRequest(
    projectId: string,
    changeRequestId: string,
  ): Promise<ChangeRequest | null> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from conversation_change_requests
      where project_id = ${projectId} and id = ${changeRequestId}`;
    return rows[0] ? ChangeRequestSchema.parse(rows[0].data) : null;
  }

  async updateChangeRequest(changeRequest: ChangeRequest): Promise<ChangeRequest> {
    const parsed = ChangeRequestSchema.parse(changeRequest);
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${'conversation:' + parsed.projectId}))`;
      const result = await tx`
        update conversation_change_requests set data = ${tx.json(parsed as any)}
        where id = ${parsed.id} and project_id = ${parsed.projectId}`;
      if (result.count === 0) throw new NotFoundError(`Change request ${parsed.id} not found`);
      return parsed;
    });
  }

  async listChangeRequests(projectId: string): Promise<ChangeRequest[]> {
    const rows = await this.sql<{ data: unknown }[]>`
      select data from conversation_change_requests
      where project_id = ${projectId} order by created_at asc, id asc`;
    return rows.map((row) => ChangeRequestSchema.parse(row.data));
  }
}

async function selectConversation(db: ISql, projectId: string): Promise<Conversation | null> {
  const rows = await db<
    { data: unknown }[]
  >`select data from conversations where project_id = ${projectId}`;
  if (!rows[0]) return null;
  const conversation = ConversationSchema.parse(rows[0].data);
  if (conversation.id !== projectId || conversation.projectId !== projectId) {
    throw new ValidationError('Conversation identity does not match requested project');
  }
  return conversation;
}

async function requireConversation(
  db: ISql,
  projectId: string,
  conversationId: string,
): Promise<void> {
  const conversation = await selectConversation(db, projectId);
  if (!conversation) throw new NotFoundError(`Conversation ${projectId} not found`);
  if (conversation.id !== conversationId || conversation.projectId !== projectId) {
    throw new ValidationError('Conversation does not belong to the target project');
  }
}

// Copied from FileConversationRepository's private operationInput (conversation-repository.ts)
// to keep idempotency-key comparison identical between the file and Postgres adapters.
function operationInput(operation: Operation): Omit<Operation, 'id' | 'createdAt'> {
  const { id: _id, createdAt: _createdAt, ...input } = operation;
  return input;
}
