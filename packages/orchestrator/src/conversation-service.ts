import {
  AttachmentSchema,
  ConversationPageResponseSchema,
  ConversationSchema,
  CreateAttachmentRequestSchema,
  CreateMessageRequestSchema,
  CreateOperationRequestSchema,
  MessageSchema,
  OperationSchema,
  ProjectExportResponseSchema,
  type Attachment,
  type Conversation,
  type ConversationPageResponse,
  type CreateAttachmentRequest,
  type CreateMessageRequest,
  type CreateOperationRequest,
  type Message,
  type Operation,
  type Project,
  type ProjectExportResponse,
} from '@agent-foundry/contracts';
import {
  NotFoundError,
  ValidationError,
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type IdGenerator,
  type ProjectRepository,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';

export class ConversationService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly artifacts: ArtifactStore,
    private readonly conversations: ConversationRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async get(
    projectId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<ConversationPageResponse> {
    const project = await this.requireProject(projectId);
    const cursor = options.cursor ?? 0;
    const limit = options.limit ?? 50;
    if (!Number.isInteger(cursor) || cursor < 0 || !Number.isInteger(limit) || limit < 1) {
      throw new ValidationError('Conversation cursor and limit must be positive integers');
    }
    const listed = await this.conversations.listMessages(projectId, { cursor, limit: limit + 1 });
    const messages = listed.slice(0, limit);
    return ConversationPageResponseSchema.parse({
      conversation: await this.conversationFor(project),
      messages,
      attachments: await this.conversations.listAttachments(projectId),
      operations: await this.conversations.listOperations(projectId),
      nextCursor: listed.length > limit ? messages.at(-1)!.sequence : null,
    });
  }

  async listMessages(
    projectId: string,
    options: { cursor?: number; limit?: number } = {},
  ): Promise<Message[]> {
    await this.requireProject(projectId);
    return this.conversations.listMessages(projectId, options);
  }

  async createAttachment(projectId: string, input: CreateAttachmentRequest): Promise<Attachment> {
    const project = await this.requireProject(projectId);
    const parsed = CreateAttachmentRequestSchema.parse(input);
    await this.ensureConversation(project);
    return this.conversations.createAttachment(
      AttachmentSchema.parse({
        id: this.ids.next(),
        projectId,
        conversationId: projectId,
        ...parsed,
        access: { scope: 'project', projectId },
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  async createMessage(projectId: string, input: CreateMessageRequest): Promise<Message> {
    const project = await this.requireProject(projectId);
    const parsed = CreateMessageRequestSchema.parse(input);
    for (const block of parsed.content) {
      if (block.type !== 'attachment') continue;
      const attachment = await this.conversations.getAttachment(projectId, block.attachmentId);
      if (
        !attachment ||
        attachment.projectId !== projectId ||
        attachment.conversationId !== projectId ||
        attachment.access.projectId !== projectId
      ) {
        throw new ValidationError(
          `Attachment ${block.attachmentId} does not belong to project ${projectId}`,
        );
      }
    }
    await this.ensureConversation(project);
    const message = MessageSchema.omit({ sequence: true }).parse({
      id: this.ids.next(),
      projectId,
      conversationId: projectId,
      ...parsed,
      createdAt: this.clock.now().toISOString(),
    });
    return this.conversations.appendMessage(message);
  }

  async createOperation(
    projectId: string,
    messageId: string,
    input: CreateOperationRequest,
  ): Promise<Operation> {
    const project = await this.requireProject(projectId);
    const parsed = CreateOperationRequestSchema.parse(input);
    const candidate = OperationSchema.parse({
      id: this.ids.next(),
      projectId,
      conversationId: projectId,
      messageId,
      ...parsed,
      createdAt: this.clock.now().toISOString(),
    });
    if (
      (await this.conversations.listOperations(projectId)).some(
        (operation) => operation.idempotencyKey === parsed.idempotencyKey,
      )
    ) {
      return this.conversations.createOperation(candidate);
    }
    const message = (await this.conversations.listMessages(projectId)).find(
      (item) => item.id === messageId,
    );
    if (!message || message.projectId !== projectId || message.conversationId !== projectId) {
      throw new NotFoundError(`Message ${messageId} not found`);
    }
    if (parsed.runId) {
      const run = await this.runs.get(parsed.runId);
      if (!run || run.projectId !== projectId) {
        throw new NotFoundError(`Workflow run ${parsed.runId} not found`);
      }
    }
    for (const reference of parsed.artifactReferences) {
      const artifact = await this.artifacts.getRevision(
        projectId,
        reference.name,
        reference.revision,
      );
      if (
        !artifact ||
        artifact.metadata.projectId !== projectId ||
        artifact.metadata.sha256 !== reference.sha256
      ) {
        throw new ValidationError(
          `Artifact ${reference.name} revision ${reference.revision} does not belong to project ${projectId}`,
        );
      }
    }
    await this.ensureConversation(project);
    return this.conversations.createOperation(candidate);
  }

  async export(projectId: string): Promise<ProjectExportResponse> {
    const project = await this.requireProject(projectId);
    return ProjectExportResponseSchema.parse({
      schemaVersion: '1',
      project,
      conversation: await this.conversationFor(project),
      messages: await this.conversations.listMessages(projectId),
      attachments: await this.conversations.listAttachments(projectId),
      operations: await this.conversations.listOperations(projectId),
    });
  }

  private async requireProject(projectId: string): Promise<Project> {
    const project = await this.projects.get(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} not found`);
    return project;
  }

  private async conversationFor(project: Project): Promise<Conversation> {
    return (
      (await this.conversations.getConversation(project.id)) ??
      ConversationSchema.parse({
        id: project.id,
        projectId: project.id,
        createdAt: project.createdAt,
      })
    );
  }

  private async ensureConversation(project: Project): Promise<void> {
    await this.conversations.createConversation(await this.conversationFor(project));
  }
}
