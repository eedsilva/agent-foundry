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

export const PackageManagerSchema = z.enum(['npm', 'pnpm', 'yarn', 'bun', 'unknown']);
export type PackageManager = z.infer<typeof PackageManagerSchema>;
export const ActorRefSchema = z
  .object({
    kind: z.enum(['user', 'system', 'worker', 'provider']),
    id: z.string().trim().min(1),
    displayName: z.string().trim().min(1).optional(),
  })
  .strict();
export type ActorRef = z.infer<typeof ActorRefSchema>;

// No architect / architecture-reviewer: ADR 0040 deleted the architecture gate,
// and no workflow may declare a role the harness has no fragment for.
// `plan-reviewer` survives only because `dogfood-plan-v1` benchmarks review
// quality with it; `web-app-v1` no longer runs any blocking model reviewer of
// another model's prose.
export const AgentRoleSchema = z.enum([
  'planner',
  'plan-reviewer',
  'developer',
  'code-reviewer',
  'fixer',
  'tester',
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const TaskKindSchema = z.enum([
  'planning',
  'plan-review',
  'implementation',
  'code-review',
  'repair',
  'verification',
]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const ProjectStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
  'rejected',
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const RiskLevelSchema = z.number().int().min(1).max(5);
export const ComplexityLevelSchema = z.number().int().min(1).max(5);

/** One-line rendering of Zod issues for error messages; `fallback` names root-level issues. */
export function formatZodIssues(error: z.ZodError, fallback = 'value'): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || fallback}: ${issue.message}`)
    .join('; ');
}

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
