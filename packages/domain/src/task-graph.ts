import type { PlanTask } from '@agent-foundry/contracts';

/**
 * The next task whose blockers have all completed, in declaration order — the
 * frontier a `for-each-task` node walks. `TaskGraphSchema` already rejects
 * unknown dependencies and cycles, so a graph with work left always yields a
 * task; a caller that gets `undefined` with tasks outstanding is looking at a
 * graph that never passed validation.
 */
export function nextReadyTask(
  tasks: readonly PlanTask[],
  completed: ReadonlySet<string>,
): PlanTask | undefined {
  return tasks.find(
    (task) => !completed.has(task.id) && task.dependsOn.every((blocker) => completed.has(blocker)),
  );
}

/**
 * Step id one task runs under inside a `for-each-task` node. One format, one
 * place: the orchestrator writes it, the pin/retry guard reads it back.
 */
export function taskStepId(implementStepId: string, taskId: string): string {
  return `${implementStepId}.${taskId}`;
}

/** Whether `stepId` is the implement step itself or one of its per-task runs. */
export function isTaskStepId(stepId: string, implementStepId: string): boolean {
  return stepId === implementStepId || stepId.startsWith(`${implementStepId}.`);
}

/**
 * The declared repair id the per-task browser loop runs under (#325). Distinct
 * from the deterministic gate's repair id because both loops run for the same
 * task and would otherwise collide on step identity.
 */
export function browserRepairId(repairStepId: string): string {
  return `${repairStepId}-browser`;
}
