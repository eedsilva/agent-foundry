import { z } from 'zod';
import {
  ProjectSchema,
  StoredArtifactSchema,
  ProjectEventSchema,
  ExecutorHealthSchema,
} from './project.js';
import {
  ModelDefinitionSchema,
  ModelOverrideRecordSchema,
  ModelOverrideScopeSchema,
} from './model.js';
import { ActorRefSchema, PathSegmentSchema, ProviderSchema } from './primitives.js';
import { ApprovalActionSchema } from './workflow.js';
import {
  AttachmentSchema,
  ConversationSchema,
  MessageSchema,
  OperationKindSchema,
  OperationObjectSchema,
  OperationSchema,
  requireExactlyOnePlanSource,
} from './conversation.js';
import {
  ApprovalDecisionSchema,
  ApprovalRequestSchema,
  StepAttemptSchema,
  StepRunSchema,
  WorkflowRunSchema,
} from './run.js';
import { ChangeRequestSchema } from './change-request.js';
import { QualityObservationInputSchema, QualityObservationSchema } from './quality.js';

export const CreateAttachmentRequestSchema = z
  .object({
    kind: AttachmentSchema.shape.kind,
    name: AttachmentSchema.shape.name,
    mediaType: AttachmentSchema.shape.mediaType,
    sha256: AttachmentSchema.shape.sha256,
    sizeBytes: AttachmentSchema.shape.sizeBytes,
  })
  .strict();
export type CreateAttachmentRequest = z.infer<typeof CreateAttachmentRequestSchema>;

export const CreateAttachmentResponseSchema = z.object({ attachment: AttachmentSchema }).strict();
export type CreateAttachmentResponse = z.infer<typeof CreateAttachmentResponseSchema>;

export const CreateMessageRequestSchema = MessageSchema.pick({ role: true, content: true });
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;

export const CreateMessageResponseSchema = z.object({ message: MessageSchema }).strict();
export type CreateMessageResponse = z.infer<typeof CreateMessageResponseSchema>;

export const CreateOperationRequestSchema = OperationObjectSchema.pick({
  kind: true,
  idempotencyKey: true,
  runId: true,
  changeRequestId: true,
  projectVersionId: true,
  artifactReferences: true,
});
export type CreateOperationRequest = z.infer<typeof CreateOperationRequestSchema>;

export const CreateOperationResponseSchema = z.object({ operation: OperationSchema }).strict();
export type CreateOperationResponse = z.infer<typeof CreateOperationResponseSchema>;

export const StartOperationRequestSchema = z
  .object({
    kind: z.enum(['plan', 'build']),
    planOperationId: PathSegmentSchema.optional(),
    directExecution: z.boolean().optional(),
    changeRequestId: PathSegmentSchema.optional(),
  })
  .strict()
  .superRefine(requireExactlyOnePlanSource);
export type StartOperationRequest = z.infer<typeof StartOperationRequestSchema>;

export const StartOperationResponseSchema = z.object({ operation: OperationSchema }).strict();
export type StartOperationResponse = z.infer<typeof StartOperationResponseSchema>;

export const DecideOperationRequestSchema = z
  .object({ action: z.enum(['approve', 'reject']) })
  .strict();
export type DecideOperationRequest = z.infer<typeof DecideOperationRequestSchema>;

export const DecideOperationResponseSchema = z.object({ operation: OperationSchema }).strict();
export type DecideOperationResponse = z.infer<typeof DecideOperationResponseSchema>;

export const ClassifyMessageResponseSchema = z
  .object({ changeRequest: ChangeRequestSchema })
  .strict();
export type ClassifyMessageResponse = z.infer<typeof ClassifyMessageResponseSchema>;

export const DecideChangeRequestRequestSchema = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('reject') }).strict(),
    z
      .object({
        action: z.literal('confirm'),
        kind: OperationKindSchema,
        planOperationId: PathSegmentSchema.optional(),
        directExecution: z.boolean().optional(),
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (input.action !== 'confirm' || input.kind !== 'build') return;
    requireExactlyOnePlanSource(input, ctx);
  });
export type DecideChangeRequestRequest = z.infer<typeof DecideChangeRequestRequestSchema>;

export const DecideChangeRequestResponseSchema = z
  .object({ changeRequest: ChangeRequestSchema, operation: OperationSchema.optional() })
  .strict();
export type DecideChangeRequestResponse = z.infer<typeof DecideChangeRequestResponseSchema>;

export const ConversationPageResponseSchema = z
  .object({
    conversation: ConversationSchema,
    messages: z.array(MessageSchema),
    attachments: z.array(AttachmentSchema),
    operations: z.array(OperationSchema),
    nextCursor: z.number().int().positive().nullable(),
  })
  .strict();
export type ConversationPageResponse = z.infer<typeof ConversationPageResponseSchema>;

export const ProjectExportResponseSchema = z
  .object({
    schemaVersion: z.literal('1'),
    project: ProjectSchema,
    conversation: ConversationSchema,
    messages: z.array(MessageSchema),
    attachments: z.array(AttachmentSchema),
    operations: z.array(OperationSchema),
  })
  .strict();
export type ProjectExportResponse = z.infer<typeof ProjectExportResponseSchema>;

export const CreateProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prd: z.string().trim().min(50).max(500_000),
  workflowId: PathSegmentSchema.default('web-app-v1'),
  policyId: PathSegmentSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const CreateProjectResponseSchema = z.object({
  project: ProjectSchema,
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;

export const CreateQualityObservationRequestSchema = QualityObservationInputSchema;
export type CreateQualityObservationRequest = z.infer<typeof CreateQualityObservationRequestSchema>;

export const CreateQualityObservationResponseSchema = z
  .object({ observation: QualityObservationSchema })
  .strict();
export type CreateQualityObservationResponse = z.infer<
  typeof CreateQualityObservationResponseSchema
>;

export const ProjectDetailResponseSchema = z.object({
  project: ProjectSchema,
  artifacts: z.array(StoredArtifactSchema),
  events: z.array(ProjectEventSchema),
});
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponseSchema>;

export const CancelRunResponseSchema = z.object({
  run: WorkflowRunSchema,
});
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

export const RunDetailResponseSchema = z.object({
  run: WorkflowRunSchema,
  steps: z.array(
    z.object({
      step: StepRunSchema,
      attempts: z.array(StepAttemptSchema),
    }),
  ),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

export const RetryStepRequestSchema = z.object({
  mode: z.enum(['preserve', 'invalidate']),
  override: z
    .object({
      modelId: PathSegmentSchema,
      provider: ProviderSchema.exclude(['mock']),
      model: z.string().trim().min(1),
      actor: ActorRefSchema,
      reason: z.string().trim().min(1),
      estimatedImpact: z.string().trim().min(1),
    })
    .strict()
    .optional(),
});
export type RetryStepRequest = z.infer<typeof RetryStepRequestSchema>;

export const CreateModelOverrideRequestSchema = z
  .object({
    scope: ModelOverrideScopeSchema,
    modelId: PathSegmentSchema,
    provider: ProviderSchema.exclude(['mock']),
    model: z.string().trim().min(1),
    actor: ActorRefSchema,
    reason: z.string().trim().min(1),
    estimatedImpact: z.string().trim().min(1),
  })
  .strict();
export type CreateModelOverrideRequest = z.infer<typeof CreateModelOverrideRequestSchema>;

export const CreateModelOverrideResponseSchema = z
  .object({ override: ModelOverrideRecordSchema })
  .strict();
export type CreateModelOverrideResponse = z.infer<typeof CreateModelOverrideResponseSchema>;

export const RetryPlanResponseSchema = z.object({
  target: StepRunSchema,
  downstream: z.array(StepRunSchema),
  artifacts: z.array(z.string()),
});
export type RetryPlanResponse = z.infer<typeof RetryPlanResponseSchema>;

export const ResumeBlockedResponseSchema = z.object({
  error: z.literal('ResumeBlockedError'),
  message: z.string(),
  diagnostics: z.array(
    z.object({
      field: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  ),
  options: z.object({ restart: z.string() }),
});
export type ResumeBlockedResponse = z.infer<typeof ResumeBlockedResponseSchema>;

export const DecideApprovalRequestSchema = z
  .object({
    action: ApprovalActionSchema,
    decidedBy: z.string().trim().min(1).optional(),
    actor: ActorRefSchema.optional(),
    note: z.string().trim().min(1).optional(),
  })
  .refine((input) => Boolean(input.actor) !== Boolean(input.decidedBy), {
    message: 'exactly one identity form is required: actor or decidedBy',
    path: ['actor'],
  })
  .refine((input) => input.action !== 'request-changes' || Boolean(input.note), {
    message: "note is required when action is 'request-changes'",
    path: ['note'],
  });
export type DecideApprovalRequest = z.infer<typeof DecideApprovalRequestSchema>;

export const DecideApprovalResponseSchema = z.object({
  run: WorkflowRunSchema,
  decision: ApprovalDecisionSchema,
});
export type DecideApprovalResponse = z.infer<typeof DecideApprovalResponseSchema>;

export const ApprovalConflictResponseSchema = z.object({
  error: z.literal('ApprovalConflictError'),
  message: z.string(),
  decision: ApprovalDecisionSchema,
});
export type ApprovalConflictResponse = z.infer<typeof ApprovalConflictResponseSchema>;

export const ApprovalListResponseSchema = z.object({
  approvals: z.array(
    z.object({
      request: ApprovalRequestSchema,
      decision: ApprovalDecisionSchema.nullable(),
    }),
  ),
});
export type ApprovalListResponse = z.infer<typeof ApprovalListResponseSchema>;

const RunAuditEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('approval-request'),
      id: PathSegmentSchema,
      timestamp: z.string().datetime(),
      request: ApprovalRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('approval-decision'),
      id: PathSegmentSchema,
      timestamp: z.string().datetime(),
      decision: ApprovalDecisionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('feedback'),
      id: z.string().min(1),
      timestamp: z.string().datetime(),
      artifact: StoredArtifactSchema,
    })
    .strict(),
]);

export const RunAuditExportSchema = z
  .object({
    schemaVersion: z.literal('1'),
    runId: PathSegmentSchema,
    entries: z.array(RunAuditEntrySchema),
  })
  .strict();
export type RunAuditExport = z.infer<typeof RunAuditExportSchema>;

export const RuntimeInfoResponseSchema = z.object({
  executorMode: z.enum(['real', 'mock']),
  models: z.array(ModelDefinitionSchema),
  executors: z.array(ExecutorHealthSchema),
});
export type RuntimeInfoResponse = z.infer<typeof RuntimeInfoResponseSchema>;

export const BranchVersionRequestSchema = z.object({ label: z.string().min(1).optional() });
export type BranchVersionRequest = z.infer<typeof BranchVersionRequestSchema>;

export const SetVersionProtectedRequestSchema = z.object({ protected: z.boolean() });
export type SetVersionProtectedRequest = z.infer<typeof SetVersionProtectedRequestSchema>;
