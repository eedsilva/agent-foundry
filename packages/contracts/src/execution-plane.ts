import { z } from 'zod';
import {
  AgentExecutionRequestBaseSchema,
  AgentExecutionResultSchema,
  validateLunaReasoningEffort,
} from './agent.js';
import { ExecutionSecretRefSchema } from './execution-secret-ref.js';
import { PathSegmentSchema } from './primitives.js';

export { ExecutionSecretRefSchema } from './execution-secret-ref.js';
export type { ExecutionSecretRef } from './execution-secret-ref.js';

export const EXECUTION_PROTOCOL_VERSION = '1' as const;

export const ExecutionWorkspaceSnapshotSchema = z
  .object({
    projectId: z.string().min(1),
    ref: z.string().min(1),
    /**
     * The isolation-unit label (#520), never a host path: only
     * `FileWorkspaceManager` knows a label resolves to
     * `<projectRoot>/worktrees/<worktree>`. A future remote execution plane
     * is free to interpret it its own way.
     */
    worktree: PathSegmentSchema.optional(),
  })
  .strict();
export type ExecutionWorkspaceSnapshot = z.infer<typeof ExecutionWorkspaceSnapshotSchema>;

export const ExecutionLimitsSchema = z
  .object({
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;

export const ExecutionAgentRequestSchema = AgentExecutionRequestBaseSchema.omit({
  cwd: true,
}).superRefine(validateLunaReasoningEffort);
export type ExecutionAgentRequest = z.infer<typeof ExecutionAgentRequestSchema>;

export const ExecutionRequestSchema = z
  .object({
    protocolVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    executionId: z.string().min(1),
    agent: ExecutionAgentRequestSchema,
    workspace: ExecutionWorkspaceSnapshotSchema,
    tools: z.array(z.string()).default([]),
    limits: ExecutionLimitsSchema,
    secrets: z.array(ExecutionSecretRefSchema).default([]),
  })
  .strict();
export type ExecutionRequest = z.infer<typeof ExecutionRequestSchema>;

export const ExecutionStateSchema = z.enum(['completed', 'failed', 'cancelled']);
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

export const ExecutionFailureSchema = z
  .object({
    message: z.string().min(1),
    exitCode: z.number().int().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    /**
     * Why the failure is an environment fault rather than a model one — the
     * error class does not survive this boundary. An enum, not a boolean per
     * cause, so the next such kind extends it without a protocol change.
     */
    kind: z.enum(['auth']).optional(),
  })
  .strict();
export type ExecutionFailure = z.infer<typeof ExecutionFailureSchema>;

export const ExecutionResultSchema = z
  .object({
    protocolVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    executionId: z.string().min(1),
    state: ExecutionStateSchema,
    agent: AgentExecutionResultSchema.optional(),
    error: ExecutionFailureSchema.optional(),
  })
  .strict()
  .refine((value) => (value.state !== 'completed' ? true : value.agent !== undefined), {
    message: 'A completed ExecutionResult must include the agent result',
    path: ['agent'],
  })
  .refine((value) => (value.state !== 'failed' ? true : value.error !== undefined), {
    message: 'A failed ExecutionResult must include the error detail',
    path: ['error'],
  });
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
