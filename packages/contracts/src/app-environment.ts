import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';

const CredentialFreeEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  }, 'Endpoint URLs must not include credentials, query strings, or fragments');

export const EnvironmentLifecycleOperationSchema = z.enum([
  'initialize',
  'start',
  'stop',
  'inspect',
  'migrate',
  'seed',
  'health',
  'reset',
  'cleanup',
  'invoke-function',
]);
export type EnvironmentLifecycleOperation = z.infer<typeof EnvironmentLifecycleOperationSchema>;

export const DestructiveEnvironmentConfirmationSchema = z
  .object({
    confirmed: z.boolean(),
    backupCreatedAt: z.string().datetime().optional(),
  })
  .strict();
export type DestructiveEnvironmentConfirmation = z.infer<
  typeof DestructiveEnvironmentConfirmationSchema
>;

export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const MigrationPreviewSchema = z
  .object({
    migrationPath: z.string().min(1),
    checksum: Sha256Schema,
    destructiveStatements: z.array(z.string().min(1)),
  })
  .strict();
export type MigrationPreview = z.infer<typeof MigrationPreviewSchema>;

export const MigrationBackupSchema = z
  .object({
    path: z.string().min(1),
    checksum: Sha256Schema,
    schemaChecksum: Sha256Schema,
    dataChecksum: Sha256Schema,
    createdAt: z.string().datetime(),
    manifestId: PathSegmentSchema,
  })
  .strict();
export type MigrationBackup = z.infer<typeof MigrationBackupSchema>;

export const MigrationApprovalSchema = z
  .object({
    migrationChecksum: Sha256Schema,
    migrationChecksums: z.array(Sha256Schema).min(1).optional(),
    backup: MigrationBackupSchema,
  })
  .strict();
export type MigrationApproval = z.infer<typeof MigrationApprovalSchema>;

/** Result of comparing a live database against an approved SchemaPlan. Extra
 * tables the plan does not name are not a failure. A plain type, not a Zod
 * object: it is produced by our own runtime and never crosses a parse
 * boundary. */
export interface SchemaVerification {
  missingTables: string[];
  /** "table.column" */
  missingColumns: string[];
  /** "table.column is <actual>, plan requires <expected>" */
  mismatchedColumns: string[];
  tablesWithoutRls: string[];
  /** "table.policy" — RLS on with no policy is deny-all, not correct. */
  missingPolicies: string[];
}

/**
 * ADR 0080 gives a project up to three environment classes that must never be
 * confused: the Candidate Supabase Stack a Run Candidate owns, the Local
 * Supabase Stack that Local Acceptance promotes, and the deliberately
 * non-promotable Manual Preview Stack of an Externally Modified Project.
 */
export const EnvironmentClassSchema = z.enum(['candidate', 'accepted', 'manual-preview']);
export type EnvironmentClass = z.infer<typeof EnvironmentClassSchema>;

/**
 * Explicit environment identity: project, environment, and the source version
 * the environment is bound to. The binding is per class on purpose — ADR 0080
 * requires an accepted or candidate environment to name the exact commit
 * (through its ProjectVersion ledger entry, which carries it) so recovery
 * "never starts an application with a mismatched commit and environment", while
 * a Manual Preview Stack has no ledger entry at all and is instead "recreated
 * when the migration digest changes". A single opaque version field would
 * accept either binding on either class; the union cannot.
 */
export const EnvironmentIdentitySchema = z.discriminatedUnion('class', [
  z
    .object({
      class: z.literal('candidate'),
      projectId: PathSegmentSchema,
      environmentId: PathSegmentSchema,
      /** The Run Candidate this stack belongs to; its Task Agent worktrees share it. */
      runCandidateId: PathSegmentSchema,
      /** ProjectVersion.id of the candidate commit. */
      projectVersionId: PathSegmentSchema,
    })
    .strict(),
  z
    .object({
      class: z.literal('accepted'),
      projectId: PathSegmentSchema,
      environmentId: PathSegmentSchema,
      /** ProjectVersion.id of the Promotion Commit. */
      projectVersionId: PathSegmentSchema,
    })
    .strict(),
  z
    .object({
      class: z.literal('manual-preview'),
      projectId: PathSegmentSchema,
      environmentId: PathSegmentSchema,
      /** Digest of the modified source's migrations; a change recreates the stack. */
      migrationDigest: Sha256Schema,
    })
    .strict(),
]);
export type EnvironmentIdentity = z.infer<typeof EnvironmentIdentitySchema>;

export const AppEnvironmentSchema = z
  .object({
    projectId: PathSegmentSchema,
    composeProjectName: z.string().min(1),
    workdir: z.string().min(1),
    network: z.string().min(1),
    volumes: z.array(z.string().min(1)).min(1),
    ports: z.record(z.string(), z.number().int().min(1).max(65535)),
    endpoints: z.record(z.string(), CredentialFreeEndpointSchema),
    health: z.object({
      state: z.enum(['unknown', 'healthy', 'unhealthy', 'stopped']),
      checkedAt: z.string().datetime(),
    }),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    /** Optional during the expand phase (#616): records written before explicit
     * identity existed carry none, and nothing may infer a class for them —
     * a stack labelled `accepted` is one Local Acceptance later treats as the
     * promoted Local Supabase Stack. Writers that know the identity persist it;
     * #617 migrates the callers that can determine it. */
    identity: EnvironmentIdentitySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.identity && value.identity.projectId !== value.projectId) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'projectId'],
        message: 'Environment identity must name the same project as the record.',
      });
    }
  });
export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;

/**
 * How a caller addresses one environment. A bare project id is the legacy
 * address ADR 0080 replaces: it names the single pre-#617 environment root and
 * stays valid because "remove legacy compatibility" is out of scope for #617.
 * The object form names the exact environment, which is what lets two classes
 * of the same project coexist without sharing a directory, compose project,
 * network, or volume.
 */
export type EnvironmentTarget = string | { projectId: string; environmentId: string };
