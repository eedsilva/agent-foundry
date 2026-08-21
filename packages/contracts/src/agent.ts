import { z } from 'zod';
import { AgentRoleSchema, JsonValueSchema, ProviderSchema, TaskKindSchema } from './primitives.js';
import { ECONOMY_PROFILE_LUNA_MODEL, ReasoningEffortSchema } from './model.js';
import { ExecutionUsageSchema } from './run.js';
import { ArtifactReferenceSchema } from './run.js';

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
    // `type` alongside `const`/`enum` is not redundant here: provider
    // schema→tool-input conversion drops an untyped property, so the model
    // never learns the field exists and omits it — the CLI then rejects the
    // turn with "root: must have required property 'schemaVersion'" (#563).
    // Every other artifact schema in this package is z.toJSONSchema-generated
    // and already emits `{ type: 'string', const: '1' }`; this hand-written
    // one must match. `agent.test.ts` pins the equivalence.
    schemaVersion: { type: 'string', const: '1' },
    status: { type: 'string', enum: ['completed', 'needs-revision', 'blocked'] },
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

/**
 * Deterministic in-process repairs applied to an agent response before it is
 * accepted (#563). Each kind is applied at most once per response, so the
 * repair budget is the size of this enum — there is no re-prompt and no loop.
 * A response still invalid after them is a terminal failure, never a retry.
 */
export const AgentOutputRepairSchema = z.enum(['schema-version-defaulted']);
export type AgentOutputRepair = z.infer<typeof AgentOutputRepairSchema>;

export const AgentExecutionRequestBaseSchema = z.object({
  runId: z.string().min(1),
  stepRunId: z.string().min(1),
  attemptId: z.string().min(1),
  projectId: z.string().min(1),
  stepId: z.string().min(1),
  role: AgentRoleSchema,
  taskKind: TaskKindSchema,
  provider: ProviderSchema,
  model: z.string(),
  reasoningEffort: ReasoningEffortSchema.optional(),
  prompt: z.string().min(1),
  cwd: z.string().min(1),
  mutatesWorkspace: z.boolean(),
  timeoutMs: z.number().int().positive(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  inputArtifacts: z.array(ArtifactReferenceSchema).optional(),
  /**
   * Role system-prompt content (harness/system-prompts/<role>.md), delivered via
   * each CLI's system-prompt-append surface rather than folded into `prompt`.
   * Content only — the loader's version is a run-metadata/evidence concern.
   * Absent when the role has no system-prompt template.
   */
  systemPrompt: z.string().optional(),
});

export const AgentExecutionRequestSchema = AgentExecutionRequestBaseSchema.superRefine(
  validateLunaReasoningEffort,
);
export type AgentExecutionRequest = z.infer<typeof AgentExecutionRequestSchema>;

export function validateLunaReasoningEffort(
  request: Pick<AgentExecutionRequest, 'model' | 'reasoningEffort'>,
  ctx: z.RefinementCtx,
): void {
  if (request.model === ECONOMY_PROFILE_LUNA_MODEL && request.reasoningEffort !== 'high') {
    ctx.addIssue({
      code: 'custom',
      path: ['reasoningEffort'],
      message: 'GPT Luna requires explicit reasoning effort high',
    });
  }
}

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
  /** Deterministic repairs `output` needed to become contract-valid (#563). */
  outputRepairs: z.array(AgentOutputRepairSchema).optional(),
  usage: ExecutionUsageSchema.optional(),
});
export type AgentExecutionResult = z.infer<typeof AgentExecutionResultSchema>;
