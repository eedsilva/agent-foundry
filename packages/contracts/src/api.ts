import { z } from 'zod';
import {
  ProjectSchema,
  StoredArtifactSchema,
  ProjectEventSchema,
  ExecutorHealthSchema,
} from './project.js';
import { ModelDefinitionSchema } from './model.js';
import { PathSegmentSchema, ProviderSchema } from './primitives.js';
import { StepAttemptSchema, StepRunSchema, WorkflowRunSchema } from './run.js';

export const CreateProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(120),
  prd: z.string().trim().min(50).max(500_000),
  workflowId: PathSegmentSchema.default('web-app-v1'),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const CreateProjectResponseSchema = z.object({
  project: ProjectSchema,
});
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;

export const ProjectDetailResponseSchema = z.object({
  project: ProjectSchema,
  artifacts: z.array(StoredArtifactSchema),
  events: z.array(ProjectEventSchema),
});
export type ProjectDetailResponse = z.infer<typeof ProjectDetailResponseSchema>;

export const CancelRunResponseSchema = z.object({
  run: WorkflowRunSchema,
});
export type CancelRunResponse = z.infer<typeof CancelRunResponseSchema>;

export const RunDetailResponseSchema = z.object({
  run: WorkflowRunSchema,
  steps: z.array(
    z.object({
      step: StepRunSchema,
      attempts: z.array(StepAttemptSchema),
    }),
  ),
});
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;

export const RetryStepRequestSchema = z.object({
  mode: z.enum(['preserve', 'invalidate']),
  override: z
    .object({
      provider: ProviderSchema.exclude(['mock']),
      model: z.string(),
    })
    .optional(),
});
export type RetryStepRequest = z.infer<typeof RetryStepRequestSchema>;

export const RetryPlanResponseSchema = z.object({
  target: StepRunSchema,
  downstream: z.array(StepRunSchema),
  artifacts: z.array(z.string()),
});
export type RetryPlanResponse = z.infer<typeof RetryPlanResponseSchema>;

export const ResumeBlockedResponseSchema = z.object({
  error: z.literal('ResumeBlockedError'),
  message: z.string(),
  diagnostics: z.array(
    z.object({
      field: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  ),
  options: z.object({ restart: z.string() }),
});
export type ResumeBlockedResponse = z.infer<typeof ResumeBlockedResponseSchema>;

export const RuntimeInfoResponseSchema = z.object({
  executorMode: z.enum(['real', 'mock']),
  models: z.array(ModelDefinitionSchema),
  executors: z.array(ExecutorHealthSchema),
});
export type RuntimeInfoResponse = z.infer<typeof RuntimeInfoResponseSchema>;
