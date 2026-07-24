import type { Tx, TransactionRunner } from '@agent-foundry/domain';

/** File-mode TransactionRunner: no real transaction exists, so it just invokes
 * the callback with an unused Tx placeholder. Matches today's best-effort
 * sequential-write behavior exactly. */
export class NoopTransactionRunner implements TransactionRunner {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(undefined as unknown as Tx);
  }
}
