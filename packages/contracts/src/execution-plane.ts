import { z } from 'zod';
import { AgentExecutionRequestSchema, AgentExecutionResultSchema } from './agent.js';
import { ExecutionNetworkPolicySchema } from './network-policy.js';

export * from './network-policy.js';

export const EXECUTION_PROTOCOL_VERSION = '1' as const;

export const ExecutionWorkspaceSnapshotSchema = z
  .object({
    projectId: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();
export type ExecutionWorkspaceSnapshot = z.infer<typeof ExecutionWorkspaceSnapshotSchema>;

export const ExecutionLimitsSchema = z
  .object({
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;

export const ExecutionSecretRefSchema = z
  .object({
    name: z.string().min(1),
    ref: z.string().min(1),
  })
  .strict();
export type ExecutionSecretRef = z.infer<typeof ExecutionSecretRefSchema>;

export const ExecutionAgentRequestSchema = AgentExecutionRequestSchema.omit({ cwd: true });
export type ExecutionAgentRequest = z.infer<typeof ExecutionAgentRequestSchema>;

export const ExecutionRequestSchema = z
  .object({
    protocolVersion: z.literal(EXECUTION_PROTOCOL_VERSION),
    executionId: z.string().min(1),
    agent: ExecutionAgentRequestSchema,
    workspace: ExecutionWorkspaceSnapshotSchema,
    tools: z.array(z.string()).default([]),
    limits: ExecutionLimitsSchema,
    networkPolicy: ExecutionNetworkPolicySchema,
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
