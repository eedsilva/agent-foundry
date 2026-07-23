import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';

const CredentialFreeEndpointSchema = z
  .string()
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      [...url.searchParams.keys()].every(
        (key) =>
          !/(?:^|[_-])(?:api[_-]?key|key|token|secret|password|credential)(?:$|[_-])/i.test(key),
      )
    );
  }, 'Endpoint URLs must not include credentials');

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
