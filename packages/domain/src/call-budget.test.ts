import { describe, expect, it } from 'vitest';
import { CallBudgetExhaustedError } from './errors.js';
import { reserveTaskCallBudget, taskCallBudgetKey } from './call-budget.js';

describe('reserveTaskCallBudget', () => {
  it('grants the first implement unit and records the limit', () => {
    const ledger = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    expect(ledger[taskCallBudgetKey('task-execution', 'T1')]).toEqual({
      nodeId: 'task-execution',
      taskId: 'T1',
      implementUsed: 1,
      implementLimit: 1,
      repairUsed: 0,
      repairLimit: 0,
    });
  });

  it('denies a second implement reservation once the limit of 1 is used', () => {
    const first = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    expect(() =>
      reserveTaskCallBudget(first, 'run-1', 'task-execution', 'T1', 'implement', 1),
    ).toThrow(CallBudgetExhaustedError);
  });

  it('tracks implement and repair independently on the same task', () => {
    let ledger = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    ledger = reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T1', 'repair', 2);
    ledger = reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T1', 'repair', 2);
    expect(ledger[taskCallBudgetKey('task-execution', 'T1')]).toEqual({
      nodeId: 'task-execution',
      taskId: 'T1',
      implementUsed: 1,
      implementLimit: 1,
      repairUsed: 2,
      repairLimit: 2,
    });
    expect(() =>
      reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T1', 'repair', 2),
    ).toThrow(CallBudgetExhaustedError);
  });

  it('keeps two tasks on the same node in separate ledger entries', () => {
    let ledger = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    ledger = reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T2', 'implement', 1);
    expect(Object.keys(ledger).sort()).toEqual(['task-execution:T1', 'task-execution:T2']);
    expect(ledger['task-execution:T2']?.implementUsed).toBe(1);
  });

  it('names the run, task, and class on denial', () => {
    const ledger = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    try {
      reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T1', 'implement', 1);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CallBudgetExhaustedError);
      const budgetError = error as CallBudgetExhaustedError;
      expect(budgetError.runId).toBe('run-1');
      expect(budgetError.nodeId).toBe('task-execution');
      expect(budgetError.taskId).toBe('T1');
      expect(budgetError.callClass).toBe('implement');
    }
  });
});
