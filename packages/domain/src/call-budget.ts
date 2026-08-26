import type { TaskCallBudget } from '@agent-foundry/contracts';
import { CallBudgetExhaustedError } from './errors.js';

export type CallBudgetClass = 'implement' | 'repair';

/** `execution.callBudget` is keyed by this — one entry per task, shared by both call classes. */
export function taskCallBudgetKey(nodeId: string, taskId: string): string {
  return `${nodeId}:${taskId}`;
}

/**
 * Pure CAS-loop step for the ADR-0073 Call Budget ledger (#604): grants the
 * next unit of `callClass` for one task, or throws when the task already used
 * every unit. Read fresh inside `WorkflowOrchestrator#updateExecution`'s
 * retry loop, so two concurrent reservations on the last slot always resolve
 * to exactly one grant — the loser re-reads the post-grant ledger and denies.
 */
export function reserveTaskCallBudget(
  ledger: Readonly<Record<string, TaskCallBudget>>,
  runId: string,
  nodeId: string,
  taskId: string,
  callClass: CallBudgetClass,
  limit: number,
): Record<string, TaskCallBudget> {
  const key = taskCallBudgetKey(nodeId, taskId);
  const existing = ledger[key];
  const usedField = callClass === 'implement' ? 'implementUsed' : 'repairUsed';
  const limitField = callClass === 'implement' ? 'implementLimit' : 'repairLimit';
  const currentUsed = existing?.[usedField] ?? 0;
  if (currentUsed >= limit) {
    throw new CallBudgetExhaustedError(runId, nodeId, taskId, callClass);
  }
  const entry: TaskCallBudget = {
    nodeId,
    taskId,
    implementUsed: existing?.implementUsed ?? 0,
    implementLimit: existing?.implementLimit ?? (callClass === 'implement' ? limit : 1),
    repairUsed: existing?.repairUsed ?? 0,
    repairLimit: existing?.repairLimit ?? (callClass === 'repair' ? limit : 0),
    [usedField]: currentUsed + 1,
    [limitField]: limit,
  };
  return { ...ledger, [key]: entry };
}
