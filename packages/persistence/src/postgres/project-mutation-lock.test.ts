import { describe, expect, it } from 'vitest';
import type { PostgresDb } from './client.js';
import { PostgresProjectMutationLock } from './project-mutation-lock.js';

/**
 * Records the SQL the lock issues without a server. The contract under test is
 * textual on purpose: `docs/OPERATIONS.md` promises the runtime adapters stay
 * pooler-safe on 6543, and only a transaction-scoped advisory lock is.
 */
function recordingSql(order: string[]) {
  const tx = (strings: TemplateStringsArray) => {
    order.push(strings.join('?').trim());
    return Promise.resolve([]);
  };
  return {
    begin: async (fn: (tx: unknown) => Promise<unknown>) => {
      order.push('begin');
      const result = await fn(tx);
      order.push('commit');
      return result;
    },
    reserve: () => {
      throw new Error('reserve() pins the pooler socket, not the backend');
    },
  } as unknown as PostgresDb;
}

describe('PostgresProjectMutationLock', () => {
  it('takes a transaction-scoped advisory lock around the section', async () => {
    const order: string[] = [];
    const lock = new PostgresProjectMutationLock(recordingSql(order));

    const result = await lock.runExclusive('project-1', () => {
      order.push('section');
      return Promise.resolve('done');
    });

    expect(result).toBe('done');
    expect(order).toEqual([
      'begin',
      'select pg_advisory_xact_lock(hashtext(?))',
      'section',
      'commit',
    ]);
    // A session lock would unlock on whichever backend the pooler hands back.
    expect(order.some((entry) => /pg_advisory_lock|pg_advisory_unlock/.test(entry))).toBe(false);
  });
});
