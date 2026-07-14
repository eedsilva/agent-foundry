import { z } from 'zod';
import { AgentRoleSchema, JsonValueSchema, ProviderSchema, TaskKindSchema } from './primitives.js';
import { ExecutionUsageSchema } from './run.js';

export const DecisionSchema = z.object({
  title: z.string().min(1),
  choice: z.string().min(1),
  rationale: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
  consequences: z.array(z.string()).default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const AgentArtifactSchema = z.object({
  schemaVersion: z.literal('1'),
  status: z.enum(['completed', 'needs-revision', 'blocked']),
  summary: z.string().min(1),
  approved: z.boolean().optional(),
  data: JsonValueSchema.default({}),
  decisions: z.array(DecisionSchema).default([]),
  assumptions: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([]),
});
export type AgentArtifact = z.infer<typeof AgentArtifactSchema>;

export const AGENT_ARTIFACT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: '1' },
    status: { enum: ['completed', 'needs-revision', 'blocked'] },
    summary: { type: 'string', minLength: 1 },
    approved: { type: 'boolean' },
    data: {},
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1 },
          choice: { type: 'string', minLength: 1 },
          rationale: { type: 'string', minLength: 1 },
          alternatives: { type: 'array', items: { type: 'string' } },
          consequences: { type: 'array', items: { type: 'string' } },
        },
        required: ['title', 'choice', 'rationale', 'alternatives', 'consequences'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    nextActions: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'schemaVersion',
    'status',
    'summary',
    'data',
    'decisions',
    'assumptions',
    'risks',
    'nextActions',
  ],
} as const;

export const AgentExecutionRequestSchema = z.object({
  runId: z.string().min(1),
  stepRunId: z.string().min(1),
  attemptId: z.string().min(1),
  projectId: z.string().min(1),
  stepId: z.string().min(1),
  role: AgentRoleSchema,
  taskKind: TaskKindSchema,
  provider: ProviderSchema,
  model: z.string(),
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  mutatesWorkspace: z.boolean(),
  timeoutMs: z.number().int().positive(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type AgentExecutionRequest = z.infer<typeof AgentExecutionRequestSchema>;

export const AgentExecutionResultSchema = z.object({
  runId: z.string(),
  stepRunId: z.string().optional(),
  attemptId: z.string().optional(),
  provider: ProviderSchema,
  model: z.string(),
  executedModel: z.string().min(1).optional(),
  exitCode: z.number().int(),
  durationMs: z.number().nonnegative(),
  stdout: z.string(),
  stderr: z.string(),
  output: AgentArtifactSchema,
  usage: ExecutionUsageSchema.optional(),
});
export type AgentExecutionResult = z.infer<typeof AgentExecutionResultSchema>;
