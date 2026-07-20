import type {
  ChangeRequest,
  DecideChangeRequestRequest,
  Operation,
  StartOperationRequest,
  WorkflowRun,
} from '@agent-foundry/contracts';
import { ChangeRequestSchema } from '@agent-foundry/contracts';
import {
  NotFoundError,
  ValidationError,
  type ArtifactStore,
  type Clock,
  type ConversationRepository,
  type IdGenerator,
  type JobQueue,
  type WorkflowRunRepository,
} from '@agent-foundry/domain';
import { CONVERSATION_WORKFLOW_ID } from './conversation-step-config.js';
import { classifyMessage } from './message-classifier.js';
import type { ConversationService } from './conversation-service.js';
import { sha256 } from './idempotency.js';

export class OperationService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly queue: JobQueue,
    private readonly artifacts: ArtifactStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly conversationService: ConversationService,
  ) {}

  async classify(projectId: string, messageId: string): Promise<ChangeRequest> {
    const message = (await this.conversations.listMessages(projectId)).find(
      (item) => item.id === messageId,
    );
    if (!message) throw new NotFoundError(`Message ${messageId} not found`);

    const priorChangeRequests = await this.conversations.listChangeRequests(projectId);
    const existing = priorChangeRequests.find((cr) => cr.messageId === messageId);
    if (existing) return existing;

    const result = classifyMessage({ message, priorChangeRequests });
    return this.conversations.createChangeRequest(
      ChangeRequestSchema.parse({
        id: this.ids.next(),
        projectId,
        conversationId: projectId,
        messageId,
        suggestedKind: result.suggestedKind,
        summary: result.summary,
        rationale: result.rationale,
        referencedDecisionIds: result.referencedDecisionIds,
        contextSources: [],
        status: 'proposed',
        createdAt: this.clock.now().toISOString(),
      }),
    );
  }

  async decideChangeRequest(
    projectId: string,
    changeRequestId: string,
    input: DecideChangeRequestRequest,
  ): Promise<{ changeRequest: ChangeRequest; operation?: Operation }> {
    const changeRequest = await this.conversations.getChangeRequest(projectId, changeRequestId);
    if (!changeRequest) throw new NotFoundError(`Change request ${changeRequestId} not found`);
    if (changeRequest.status !== 'proposed') {
      throw new ValidationError(`Change request ${changeRequestId} has already been decided`);
    }

    if (input.action === 'reject') {
      const rejected = await this.conversations.updateChangeRequest({
        ...changeRequest,
        status: 'rejected',
        decidedAt: this.clock.now().toISOString(),
      });
      return { changeRequest: rejected };
    }

    const operation =
      input.kind === 'plan' || input.kind === 'build'
        ? await this.start(projectId, changeRequest.messageId, {
            kind: input.kind,
            planOperationId: input.planOperationId,
            directExecution: input.directExecution,
            changeRequestId: changeRequest.id,
          })
        : await this.conversationService.createOperation(projectId, changeRequest.messageId, {
            kind: input.kind,
            // IdempotencyKeySchema requires 64 lowercase hex chars — changeRequest.id itself
            // (a PathSegmentSchema id) does not match, so hash it the same way start() hashes
            // operationId/runId into idempotencyKey() below.
            idempotencyKey: sha256(changeRequest.id),
            changeRequestId: changeRequest.id,
            artifactReferences: [],
          });

    const confirmed = await this.conversations.updateChangeRequest({
      ...changeRequest,
      status: 'confirmed',
      confirmedKind: input.kind,
      operationId: operation.id,
      decidedAt: this.clock.now().toISOString(),
    });
    return { changeRequest: confirmed, operation };
  }

  async start(
    projectId: string,
    messageId: string,
    input: StartOperationRequest,
  ): Promise<Operation> {
    const message = (await this.conversations.listMessages(projectId)).find(
      (item) => item.id === messageId,
    );
    if (!message) throw new NotFoundError(`Message ${messageId} not found`);
    if (input.kind === 'build' && !input.planOperationId && !input.directExecution) {
      throw new ValidationError('Build requires an approved planOperationId or directExecution');
    }

    let artifactReferences: Operation['artifactReferences'] = [];
    if (input.kind === 'build' && input.planOperationId) {
      const plan = await this.conversations.getOperation(projectId, input.planOperationId);
      if (!plan || plan.kind !== 'plan') {
        throw new ValidationError(`Plan operation ${input.planOperationId} not found`);
      }
      if (plan.approval?.status !== 'approved') {
        throw new ValidationError(`Plan operation ${input.planOperationId} is not approved`);
      }
      artifactReferences = plan.artifactReferences;
    }

    const now = this.clock.now().toISOString();
    const runId = this.ids.next();
    const operationId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: CONVERSATION_WORKFLOW_ID[input.kind],
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.runs.create(run);

    const operation = await this.conversations.createOperation({
      id: operationId,
      projectId,
      conversationId: projectId,
      messageId,
      kind: input.kind,
      idempotencyKey: this.idempotencyKey(operationId, runId),
      runId,
      artifactReferences,
      ...(input.changeRequestId ? { changeRequestId: input.changeRequestId } : {}),
      ...(input.kind === 'plan' ? { approval: { status: 'pending' as const } } : {}),
      ...(input.kind === 'build' && input.planOperationId
        ? { planOperationId: input.planOperationId }
        : {}),
      ...(input.kind === 'build' && input.directExecution ? { directExecution: true } : {}),
      createdAt: now,
    });

    await this.queue.enqueue({
      id: this.ids.next(),
      type: 'run-conversation-operation',
      projectId,
      workflowId: run.workflowId,
      runId,
      operationId,
      attempts: 0,
      maxAttempts: 1,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
    });

    return operation;
  }

  async decide(
    projectId: string,
    operationId: string,
    action: 'approve' | 'reject',
  ): Promise<Operation> {
    const operation = await this.conversations.getOperation(projectId, operationId);
    if (!operation) throw new NotFoundError(`Operation ${operationId} not found`);
    if (operation.kind !== 'plan') {
      throw new ValidationError(`Operation ${operationId} is not a plan operation`);
    }
    if (!operation.runId) throw new ValidationError(`Operation ${operationId} has no run`);
    const run = await this.runs.get(operation.runId);
    if (!run || run.status !== 'completed') {
      throw new ValidationError(`Operation ${operationId}'s run has not completed`);
    }

    if (action === 'reject') {
      return this.conversations.updateOperation({
        ...operation,
        approval: { status: 'rejected', decidedAt: this.clock.now().toISOString() },
      });
    }

    const artifact = await this.artifacts.getLatest(projectId, `operation-${operationId}`);
    if (!artifact) throw new NotFoundError(`Plan artifact for operation ${operationId} not found`);
    return this.conversations.updateOperation({
      ...operation,
      approval: { status: 'approved', decidedAt: this.clock.now().toISOString() },
      artifactReferences: [
        {
          name: artifact.metadata.name,
          revision: artifact.metadata.revision,
          sha256: artifact.metadata.sha256,
        },
      ],
    });
  }

  protected idempotencyKey(operationId: string, runId: string): string {
    return sha256(`${operationId}:${runId}`);
  }
}
