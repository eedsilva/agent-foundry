import { z } from 'zod';

export const PathSegmentSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Must contain only letters, numbers, dot, underscore, or hyphen')
  .refine((value) => value !== '.' && value !== '..', 'Reserved path segment');
export type PathSegment = z.infer<typeof PathSegmentSchema>;

export const ProviderSchema = z.enum(['codex', 'claude', 'agy', 'mock']);
export type Provider = z.infer<typeof ProviderSchema>;

export const AgentRoleSchema = z.enum([
  'planner',
  'plan-reviewer',
  'architect',
  'architecture-reviewer',
  'developer',
  'code-reviewer',
  'fixer',
  'tester',
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const TaskKindSchema = z.enum([
  'planning',
  'plan-review',
  'architecture',
  'architecture-review',
  'implementation',
  'code-review',
  'repair',
  'verification',
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const ProjectStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const RiskLevelSchema = z.number().int().min(1).max(5);
export const ComplexityLevelSchema = z.number().int().min(1).max(5);

export const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
