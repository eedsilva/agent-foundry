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
  })
  .strict();
export type AppEnvironment = z.infer<typeof AppEnvironmentSchema>;
