import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';
import { ArtifactReferenceSchema } from './run.js';

export const BareMediaTypeSchema = z
  .string()
  .max(127)
  .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/)
  .transform((value) => value.toLowerCase());

export const KnowledgeFileRevisionSchema = z
  .object({
    version: z.number().int().positive(),
    artifact: ArtifactReferenceSchema,
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine((revision) => revision.version === revision.artifact.revision, {
    message: 'Version must match artifact revision',
    path: ['artifact', 'revision'],
  });
export type KnowledgeFileRevision = z.infer<typeof KnowledgeFileRevisionSchema>;

export const KnowledgeFilePurposeSchema = z.enum(['reference', 'design-reference', 'bug-evidence']);
export type KnowledgeFilePurpose = z.infer<typeof KnowledgeFilePurposeSchema>;

export const KnowledgeFileSchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    name: z.string().trim().min(1).max(255),
    mediaType: BareMediaTypeSchema,
    purpose: KnowledgeFilePurposeSchema,
    pinned: z.boolean(),
    currentVersion: z.number().int().positive(),
    revisions: z.array(KnowledgeFileRevisionSchema).min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((file, context) => {
    const latest = file.revisions.at(-1);
    if (latest?.version !== file.currentVersion) {
      context.addIssue({
        code: 'custom',
        path: ['currentVersion'],
        message: 'Must name the final revision',
      });
    }
    for (let index = 1; index < file.revisions.length; index += 1) {
      if (file.revisions[index]!.version <= file.revisions[index - 1]!.version) {
        context.addIssue({
          code: 'custom',
          path: ['revisions', index, 'version'],
          message: 'Revisions must be ordered by increasing version',
        });
      }
      if (file.revisions[index]!.artifact.name !== file.revisions[0]!.artifact.name) {
        context.addIssue({
          code: 'custom',
          path: ['revisions', index, 'artifact', 'name'],
          message: 'Revisions must reference one artifact',
        });
      }
    }
  });
export type KnowledgeFile = z.infer<typeof KnowledgeFileSchema>;

export const CreateKnowledgeFileRequestSchema = z
  .object({
    name: KnowledgeFileSchema.shape.name,
    mediaType: BareMediaTypeSchema,
    purpose: KnowledgeFilePurposeSchema,
    pinned: z.boolean(),
    contentBase64: z.string().min(1),
  })
  .strict();
export type CreateKnowledgeFileRequest = z.infer<typeof CreateKnowledgeFileRequestSchema>;

export const UpdateKnowledgeFileRequestSchema = CreateKnowledgeFileRequestSchema.extend({
  id: PathSegmentSchema,
});
export type UpdateKnowledgeFileRequest = z.infer<typeof UpdateKnowledgeFileRequestSchema>;
