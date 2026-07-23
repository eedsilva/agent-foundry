import { z } from 'zod';
import { ExecutionNetworkPolicySchema } from './execution-plane.js';

export const SandboxResourcesSchema = z
  .object({
    cpuMillis: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
    diskMiB: z.number().int().positive(),
    pids: z.number().int().positive(),
  })
  .strict();
export type SandboxResources = z.infer<typeof SandboxResourcesSchema>;

export const SandboxMountSchema = z
  .object({
    source: z.string().min(1),
    target: z.string().min(1).startsWith('/'),
    readOnly: z.boolean(),
  })
  .strict();
export type SandboxMount = z.infer<typeof SandboxMountSchema>;

export const SandboxSpecSchema = z
  .object({
    image: z.string().min(1),
    resources: SandboxResourcesSchema,
    network: ExecutionNetworkPolicySchema,
    mounts: z.array(SandboxMountSchema),
    ttlMs: z.number().int().positive(),
    user: z.string().min(1),
  })
  .strict();
export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

export const SandboxExecSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    timeoutMs: z.number().int().positive(),
    cwd: z
      .string()
      .startsWith('/')
      .refine(
        (cwd) =>
          cwd === '/' ||
          cwd
            .split('/')
            .slice(1)
            .every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
        'Sandbox cwd must be an absolute normalized path',
      )
      .optional(),
  })
  .strict();
export type SandboxExec = z.infer<typeof SandboxExecSchema>;

export const SandboxSnapshotPathSchema = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'Sandbox snapshot paths must be relative and cannot traverse directories',
  );
export type SandboxSnapshotPath = z.infer<typeof SandboxSnapshotPathSchema>;

export const SandboxSnapshotFileSchema = z
  .object({ path: SandboxSnapshotPathSchema, content: z.instanceof(Uint8Array) })
  .strict();
export type SandboxSnapshotFile = z.infer<typeof SandboxSnapshotFileSchema>;

export const SandboxSnapshotSchema = z
  .object({ files: z.array(SandboxSnapshotFileSchema) })
  .strict();
export type SandboxSnapshot = z.infer<typeof SandboxSnapshotSchema>;
