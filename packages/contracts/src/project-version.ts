import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';
import { ArtifactReferenceSchema, EntityVersionSchema } from './run.js';

export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const ProjectVersionKindSchema = z.enum(['run', 'revert', 'branch']);
export type ProjectVersionKind = z.infer<typeof ProjectVersionKindSchema>;

/**
 * An immutable ledger entry over the workspace's git history. `run` versions
 * are recorded automatically after a mutating step commits; `revert` and
 * `branch` versions are user-driven and always point back at a parent
 * version rather than rewriting or removing it.
 */
export const ProjectVersionSchema = z
  .object({
    schemaVersion: z.literal('1'),
    id: PathSegmentSchema,
    projectId: PathSegmentSchema,
    sequence: z.number().int().positive(),
    kind: ProjectVersionKindSchema,
    runId: PathSegmentSchema.optional(),
    stepRunId: PathSegmentSchema.optional(),
    attemptId: PathSegmentSchema.optional(),
    parentVersionId: PathSegmentSchema.optional(),
    commit: z.string().min(1),
    branchName: z.string().min(1).optional(),
    previewSessionId: PathSegmentSchema.optional(),
    artifacts: z.array(ArtifactReferenceSchema).default([]),
    protected: z.boolean().default(false),
    version: EntityVersionSchema,
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === 'run' && !value.runId) {
      context.addIssue({
        code: 'custom',
        path: ['runId'],
        message: 'A run version requires runId',
      });
    }
    if ((value.kind === 'revert' || value.kind === 'branch') && !value.parentVersionId) {
      context.addIssue({
        code: 'custom',
        path: ['parentVersionId'],
        message: `A ${value.kind} version requires parentVersionId`,
      });
    }
    if (value.kind === 'branch' && !value.branchName) {
      context.addIssue({
        code: 'custom',
        path: ['branchName'],
        message: 'A branch version requires branchName',
      });
    }
    if (value.kind !== 'branch' && value.branchName) {
      context.addIssue({
        code: 'custom',
        path: ['branchName'],
        message: 'Only branch versions may set branchName',
      });
    }
  });
export type ProjectVersion = z.infer<typeof ProjectVersionSchema>;
