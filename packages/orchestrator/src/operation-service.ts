import { createHash } from 'node:crypto';
import type { Operation, StartOperationRequest, WorkflowRun } from '@agent-foundry/contracts';
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

export class OperationService {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly queue: JobQueue,
    private readonly artifacts: ArtifactStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

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

  protected idempotencyKey(operationId: string, runId: string): string {
    return createHash('sha256').update(`${operationId}:${runId}`).digest('hex');
  }
}
