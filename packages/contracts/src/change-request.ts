import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';
import { OperationKindSchema } from './conversation.js';

export const ChangeRequestStatusSchema = z.enum(['proposed', 'confirmed', 'rejected']);
export type ChangeRequestStatus = z.infer<typeof ChangeRequestStatusSchema>;

export const ContextSourceSchema = z
  .object({
    type: z.enum(['message', 'change-request', 'project-version', 'harness-fragment']),
    id: z.string().min(1),
  })
  .strict();
export type ContextSource = z.infer<typeof ContextSourceSchema>;

export const ChangeRequestSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    conversationId: PathSegmentSchema,
    messageId: PathSegmentSchema,
    suggestedKind: OperationKindSchema,
    confirmedKind: OperationKindSchema.optional(),
    summary: z.string().min(1),
    rationale: z.string().min(1),
    referencedDecisionIds: z.array(PathSegmentSchema).default([]),
    contextSources: z.array(ContextSourceSchema).default([]),
    status: ChangeRequestStatusSchema,
    operationId: PathSegmentSchema.optional(),
    createdAt: z.string().datetime(),
    decidedAt: z.string().datetime().optional(),
  })
  .strict();
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;
