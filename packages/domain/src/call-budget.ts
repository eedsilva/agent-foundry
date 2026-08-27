import type { TaskCallBudget } from '@agent-foundry/contracts';
import { CallBudgetExhaustedError } from './errors.js';

export type CallBudgetClass = 'implement' | 'repair' | 'technical-retry';

type BudgetFields = {
  used: keyof TaskCallBudget;
  reserved: keyof TaskCallBudget;
  limit: keyof TaskCallBudget;
};

function budgetFields(callClass: CallBudgetClass): BudgetFields {
  switch (callClass) {
    case 'implement':
      return { used: 'implementUsed', reserved: 'implementReserved', limit: 'implementLimit' };
    case 'repair':
      return { used: 'repairUsed', reserved: 'repairReserved', limit: 'repairLimit' };
    case 'technical-retry':
      return {
        used: 'technicalRetryUsed',
        reserved: 'technicalRetryReserved',
        limit: 'technicalRetryLimit',
      };
  }
}

function numericField(entry: TaskCallBudget | undefined, field: keyof TaskCallBudget): number {
  const value = entry?.[field];
  return typeof value === 'number' ? value : 0;
}

/** `execution.callBudget` is keyed by this — one entry per task, shared by both call classes. */
export function taskCallBudgetKey(nodeId: string, taskId: string): string {
  return `${nodeId}:${taskId}`;
}

/**
 * Pure CAS-loop step for the ADR-0073 Call Budget ledger (#604): reserves the
 * next unit of `callClass` for one task. Confirmation consumes it; release
 * returns it without consumption. Read fresh inside the orchestrator's CAS
 * retry loop so concurrent reservations cannot oversubscribe a task.
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
  const fields = budgetFields(callClass);
  const currentUsed = numericField(existing, fields.used);
  const currentReserved = numericField(existing, fields.reserved);
  const currentLimit = numericField(existing, fields.limit);
  const nextLimit = Math.max(currentLimit, limit);
  if (currentUsed + currentReserved >= nextLimit) {
    throw new CallBudgetExhaustedError(runId, nodeId, taskId, callClass);
  }
  const entry: TaskCallBudget = {
    nodeId,
    taskId,
    implementUsed: existing?.implementUsed ?? 0,
    implementReserved: existing?.implementReserved ?? 0,
    implementLimit: existing?.implementLimit ?? (callClass === 'implement' ? limit : 1),
    repairUsed: existing?.repairUsed ?? 0,
    repairReserved: existing?.repairReserved ?? 0,
    repairLimit: existing?.repairLimit ?? (callClass === 'repair' ? limit : 0),
    technicalRetryUsed: existing?.technicalRetryUsed ?? 0,
    technicalRetryReserved: existing?.technicalRetryReserved ?? 0,
    technicalRetryLimit: existing?.technicalRetryLimit ?? 1,
  };
  switch (callClass) {
    case 'implement':
      entry.implementReserved = currentReserved + 1;
      entry.implementLimit = nextLimit;
      break;
    case 'repair':
      entry.repairReserved = currentReserved + 1;
      entry.repairLimit = nextLimit;
      break;
    case 'technical-retry':
      entry.technicalRetryReserved = currentReserved + 1;
      entry.technicalRetryLimit = nextLimit;
      break;
  }
  return { ...ledger, [key]: entry };
}

function settleTaskCallBudget(
  ledger: Readonly<Record<string, TaskCallBudget>>,
  nodeId: string,
  taskId: string,
  callClass: CallBudgetClass,
  confirmed: boolean,
): Record<string, TaskCallBudget> {
  const key = taskCallBudgetKey(nodeId, taskId);
  const existing = ledger[key];
  const fields = budgetFields(callClass);
  const currentReserved = numericField(existing, fields.reserved);
  if (!existing || currentReserved < 1) {
    throw new Error(`No pending ${callClass} call reservation for ${key}`);
  }
  return {
    ...ledger,
    [key]: {
      ...existing,
      [fields.reserved]: currentReserved - 1,
      [fields.used]: confirmed
        ? numericField(existing, fields.used) + 1
        : numericField(existing, fields.used),
    },
  };
}

export function confirmTaskCallBudget(
  ledger: Readonly<Record<string, TaskCallBudget>>,
  nodeId: string,
  taskId: string,
  callClass: CallBudgetClass,
): Record<string, TaskCallBudget> {
  return settleTaskCallBudget(ledger, nodeId, taskId, callClass, true);
}

export function releaseTaskCallBudget(
  ledger: Readonly<Record<string, TaskCallBudget>>,
  nodeId: string,
  taskId: string,
  callClass: CallBudgetClass,
): Record<string, TaskCallBudget> {
  return settleTaskCallBudget(ledger, nodeId, taskId, callClass, false);
}
