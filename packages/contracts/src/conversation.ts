import { z } from 'zod';
import { JsonValueSchema, PathSegmentSchema } from './primitives.js';
import { ArtifactReferenceSchema, IdempotencyKeySchema } from './run.js';

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1) }).strict(),
  z.object({ type: z.literal('data'), value: JsonValueSchema }).strict(),
  z.object({ type: z.literal('attachment'), attachmentId: PathSegmentSchema }).strict(),
]);
export type MessageContentBlock = z.infer<typeof MessageContentBlockSchema>;

export const ConversationSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    conversationId: PathSegmentSchema,
    role: MessageRoleSchema,
    content: z.array(MessageContentBlockSchema).min(1),
    sequence: z.number().int().positive(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Message = z.infer<typeof MessageSchema>;

export const AttachmentKindSchema = z.enum(['file', 'image']);
export type AttachmentKind = z.infer<typeof AttachmentKindSchema>;

export const AttachmentSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    conversationId: PathSegmentSchema,
    kind: AttachmentKindSchema,
    name: z.string().trim().min(1).optional(),
    mediaType: z
      .string()
      .max(127)
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/)
      .transform((value) => value.toLowerCase()),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    access: z.object({ scope: z.literal('project'), projectId: PathSegmentSchema }).strict(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine((attachment) => attachment.access.projectId === attachment.projectId, {
    message: 'Must match attachment projectId',
    path: ['access', 'projectId'],
  });
export type Attachment = z.infer<typeof AttachmentSchema>;

export const OperationKindSchema = z.enum(['plan', 'build', 'explain', 'repair', 'visual-edit']);
export type OperationKind = z.infer<typeof OperationKindSchema>;

export const OperationSchema = z
  .object({
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    conversationId: PathSegmentSchema,
    messageId: PathSegmentSchema,
    kind: OperationKindSchema,
    idempotencyKey: IdempotencyKeySchema,
    runId: PathSegmentSchema.optional(),
    changeRequestId: PathSegmentSchema.optional(),
    projectVersionId: PathSegmentSchema.optional(),
    artifactReferences: z.array(ArtifactReferenceSchema).default([]),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Operation = z.infer<typeof OperationSchema>;
