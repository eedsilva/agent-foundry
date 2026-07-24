import { describe, expect, it } from 'vitest';
import { NoopTransactionRunner } from './transaction-runner.js';

describe('NoopTransactionRunner', () => {
  it('invokes the callback once and returns its result without a real transaction', async () => {
    const runner = new NoopTransactionRunner();
    const calls: unknown[] = [];

    const result = await runner.run(async (tx) => {
      calls.push(tx);
      return 'done';
    });

    expect(result).toBe('done');
    expect(calls).toHaveLength(1);
  });

  it('propagates a thrown error from the callback', async () => {
    const runner = new NoopTransactionRunner();
    await expect(
      runner.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
