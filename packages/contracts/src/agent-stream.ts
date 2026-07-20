import { z } from 'zod';
import { PathSegmentSchema } from './primitives.js';

/**
 * Payload-only shape a provider CLI's stdout stream can produce, before the
 * envelope (id/runId/stepRunId/attemptId/sequence/createdAt) is attached.
 * Executors and AgentExecutor/ExecutionPlane callbacks use this — it never
 * includes 'approval', which only the orchestrator's approval-gate code
 * emits directly (no executor is involved in that path).
 */
export type ExecutorStreamEvent =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_start'; toolName: string; summary: string }
  | { type: 'tool_end'; toolName: string; summary: string; ok: boolean; detail?: string }
  | { type: 'status'; phase: string }
  | { type: 'error'; message: string };

const streamEnvelope = {
  id: PathSegmentSchema,
  runId: PathSegmentSchema,
  stepRunId: PathSegmentSchema,
  // Absent for approval-gate stepRuns, which have no execution attempt.
  attemptId: PathSegmentSchema.optional(),
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
};

export const AgentStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ ...streamEnvelope, type: z.literal('assistant_delta'), text: z.string() }).strict(),
  z
    .object({
      ...streamEnvelope,
      type: z.literal('tool_start'),
      toolName: z.string(),
      summary: z.string(),
    })
    .strict(),
  z
    .object({
      ...streamEnvelope,
      type: z.literal('tool_end'),
      toolName: z.string(),
      summary: z.string(),
      ok: z.boolean(),
      // Redacted raw excerpt behind the "show details" toggle; capped so the
      // durable per-run event log never grows unbounded from one tool call.
      detail: z.string().max(4_000).optional(),
    })
    .strict(),
  z.object({ ...streamEnvelope, type: z.literal('status'), phase: z.string() }).strict(),
  z
    .object({
      ...streamEnvelope,
      type: z.literal('approval'),
      approvalRequestId: PathSegmentSchema,
    })
    .strict(),
  z.object({ ...streamEnvelope, type: z.literal('error'), message: z.string() }).strict(),
]);
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

/**
 * Plain `Omit<AgentStreamEvent, 'sequence'>` does NOT distribute over this
 * union (TS's Omit collapses to only the keys common across all members),
 * silently erasing every variant-specific field. This conditional form
 * distributes correctly and is the type `StepEventRepository.append()` takes.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type AgentStreamEventInput = DistributiveOmit<AgentStreamEvent, 'sequence'>;
