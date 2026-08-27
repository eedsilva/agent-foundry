import { describe, expect, it } from 'vitest';
import { CallBudgetExhaustedError } from './errors.js';
import {
  confirmTaskCallBudget,
  releaseTaskCallBudget,
  reserveTaskCallBudget,
  taskCallBudgetKey,
} from './call-budget.js';

describe('reserveTaskCallBudget', () => {
  it('reserves the first implement unit without confirming it', () => {
    const ledger = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    expect(ledger[taskCallBudgetKey('task-execution', 'T1')]).toEqual({
      nodeId: 'task-execution',
      taskId: 'T1',
      implementUsed: 0,
      implementReserved: 1,
      implementLimit: 1,
      repairUsed: 0,
      repairReserved: 0,
      repairLimit: 0,
      technicalRetryUsed: 0,
      technicalRetryReserved: 0,
      technicalRetryLimit: 1,
    });
  });

  it('confirms one reserved implement unit exactly once', () => {
    const reserved = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    const confirmed = confirmTaskCallBudget(reserved, 'task-execution', 'T1', 'implement');
    expect(confirmed[taskCallBudgetKey('task-execution', 'T1')]).toMatchObject({
      implementUsed: 1,
      implementReserved: 0,
    });
  });

  it('denies a second implement reservation while the first is only reserved', () => {
    const first = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    expect(() =>
      reserveTaskCallBudget(first, 'run-1', 'task-execution', 'T1', 'implement', 1),
    ).toThrow(CallBudgetExhaustedError);
  });

  it('tracks implement and repair independently on the same task', () => {
    let ledger = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    ledger = confirmTaskCallBudget(ledger, 'task-execution', 'T1', 'implement');
    ledger = reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T1', 'repair', 2);
    ledger = confirmTaskCallBudget(ledger, 'task-execution', 'T1', 'repair');
    ledger = reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T1', 'repair', 2);
    ledger = confirmTaskCallBudget(ledger, 'task-execution', 'T1', 'repair');
    expect(ledger[taskCallBudgetKey('task-execution', 'T1')]).toEqual({
      nodeId: 'task-execution',
      taskId: 'T1',
      implementUsed: 1,
      implementReserved: 0,
      implementLimit: 1,
      repairUsed: 2,
      repairReserved: 0,
      repairLimit: 2,
      technicalRetryUsed: 0,
      technicalRetryReserved: 0,
      technicalRetryLimit: 1,
    });
    expect(() =>
      reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T1', 'repair', 2),
    ).toThrow(CallBudgetExhaustedError);
  });

  it('keeps two tasks on the same node in separate ledger entries', () => {
    let ledger = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    ledger = reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T2', 'implement', 1);
    expect(Object.keys(ledger).sort()).toEqual(['task-execution:T1', 'task-execution:T2']);
    expect(ledger['task-execution:T2']?.implementReserved).toBe(1);
  });

  it('releases a reservation without consuming it when dispatch is cancelled', () => {
    const reserved = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'implement', 1);
    const released = releaseTaskCallBudget(reserved, 'task-execution', 'T1', 'implement');
    expect(released[taskCallBudgetKey('task-execution', 'T1')]).toMatchObject({
      implementUsed: 0,
      implementReserved: 0,
    });
  });

  it('gives Technical Retry its own one-unit class and limit', () => {
    let ledger = reserveTaskCallBudget({}, 'run-1', 'task-execution', 'T1', 'technical-retry', 1);
    ledger = confirmTaskCallBudget(ledger, 'task-execution', 'T1', 'technical-retry');
    expect(ledger[taskCallBudgetKey('task-execution', 'T1')]).toMatchObject({
      technicalRetryUsed: 1,
      technicalRetryReserved: 0,
      technicalRetryLimit: 1,
    });
    expect(() =>
      reserveTaskCallBudget(ledger, 'run-1', 'task-execution', 'T1', 'technical-retry', 1),
    ).toThrow(CallBudgetExhaustedError);
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
