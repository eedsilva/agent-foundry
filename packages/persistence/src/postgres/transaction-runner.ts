import type { Tx, TransactionRunner } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';

export class PostgresTransactionRunner implements TransactionRunner {
  constructor(private readonly sql: PostgresDb) {}

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    // postgres.js's `begin<T>` return type is `Promise<UnwrapPromiseArray<T>>`, which
    // TS can't prove is assignable back to `Promise<T>` for an unconstrained generic --
    // this cast documents that the runtime value is identical.
    return this.sql.begin((tx) => fn(tx as unknown as Tx)) as Promise<T>;
  }
}
