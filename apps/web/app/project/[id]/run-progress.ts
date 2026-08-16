import type {
  RunDetailResponse,
  StepRunStatus,
  WorkflowDefinition,
} from '@agent-foundry/contracts';

// Mirrors the terminal set `StepRunSchema`'s lifecycle refinement enforces in
// packages/contracts/src/run.ts (no exported helper exists for step status,
// unlike `isWorkflowRunStatusTerminal` for run status).
const TERMINAL_STEP_STATUSES = new Set<StepRunStatus>([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

/** "2m 14s", "45s", "1h 03m" — no seconds once an hour has passed. Not a
 * duplicate of `format-usage.ts`'s `formatSeconds`: that one is the raw "134s"
 * form for one attempt's duration in dense mono metadata, this one is a
 * human-readable wall clock for a run that can last hours. Both stay. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export function runProgress(
  runDetail: RunDetailResponse | null,
  workflowDef: WorkflowDefinition | null,
): { done: number; total: number | null; currentStepTitle: string | null } {
  const total = workflowDef ? workflowDef.nodes.length : null;
  if (!runDetail) return { done: 0, total, currentStepTitle: null };

  const activeSteps = runDetail.steps.filter(({ step }) => !step.invalidatedAt);
  const done = activeSteps.filter(({ step }) => TERMINAL_STEP_STATUSES.has(step.status)).length;
  const inFlight = activeSteps.filter(({ step }) => !TERMINAL_STEP_STATUSES.has(step.status));
  const currentStepTitle =
    inFlight.length === 1
      ? (workflowDef?.nodes.find((node) => node.id === inFlight[0]!.step.nodeId)?.title ?? null)
      : null;

  return { done, total, currentStepTitle };
}
