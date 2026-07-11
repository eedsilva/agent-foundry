import { z } from 'zod';
import {
  ProjectSchema,
  StoredArtifactSchema,
  ProjectEventSchema,
  ExecutorHealthSchema,
} from './project.js';
import { ModelDefinitionSchema } from './model.js';
import { PathSegmentSchema } from './primitives.js';

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

export const RuntimeInfoResponseSchema = z.object({
  executorMode: z.enum(['real', 'mock']),
  models: z.array(ModelDefinitionSchema),
  executors: z.array(ExecutorHealthSchema),
});
export type RuntimeInfoResponse = z.infer<typeof RuntimeInfoResponseSchema>;
