# Durable Postgres Queue (Issue #55) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production job queue durable under `PERSISTENCE_MODE=postgres` (leases, fencing, retry, dead-letter — already built for the file queue — now backed by Postgres with `FOR UPDATE SKIP LOCKED`), and let enqueue join the same DB transaction that creates a Project/Run so a crash can never leave a queued project with no job or a job with no event.

**Architecture:** A new `PostgresJobQueue implements JobQueue` (mirrors `FileJobQueue`'s semantics using SQL instead of file renames). A new domain port `TransactionRunner` + opaque `Tx` handle lets `ProjectService` run `projects.create/update`, `runs.create`, `events.append`, and `queue.enqueue` inside one `sql.begin` in Postgres mode (`NoopTransactionRunner` in file mode — unchanged sequential behavior). A pure `classifyJobOutcome` in the worker maps thrown errors to ack (cancelled) / dead-letter (permanent) / backoff-retry (transient). No outbox table, no relay poller — confirmed with the user: `project_events` is already the only transport (SSE polls it), so one transaction is the whole "no dual write" story.

**Tech Stack:** TypeScript, Zod, `postgres` (postgres.js), Vitest, `@testcontainers/postgresql` (Docker-gated Postgres integration tests via the existing `describePostgres` harness).

## Global Constraints

- Do not touch `FileProjectRepository`, `FileWorkflowRunRepository`, `FileEventStore`, or any `InMemory*` test fake for the new optional `tx?`/`options?` parameters — TypeScript allows an implementation to declare _fewer_ parameters than its interface when the extra ones are optional, so these all satisfy the updated ports unmodified. Verify this with `tsc -b` after Task 1, don't assume it.
- `ArtifactStore.put` is **not** touched and gets **no** `tx` param — artifact writes move to _after_ the transaction commits (see Task 7), avoiding the FK-visibility problem entirely instead of threading a transaction through artifact storage.
- Every Postgres-touching test uses `describePostgres` from `packages/persistence/src/postgres/testing.ts` (Docker-gated; CI refuses to skip — `testing.ts:16`).
- Run `tsc -b` after every task that touches a `.ts` file (not just at the end) — this repo has bitten itself on `exactOptionalPropertyTypes` before.
- One PR for issue #55. Do not push to `main`. Work stays on `feat/issue-55-durable-queue`.

---

## File Structure

| File                                                               | Responsibility                                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/domain/src/ports.ts` (modify)                            | Add `Tx`, `TransactionRunner`; widen `JobQueue.enqueue`/`nack`, `ProjectRepository.create/update`, `WorkflowRunRepository.create`, `EventStore.append` signatures with optional trailing params. |
| `packages/persistence/src/transaction-runner.ts` (new)             | `NoopTransactionRunner` — file-mode `TransactionRunner`.                                                                                                                                         |
| `packages/persistence/src/job-queue.ts` (modify)                   | `FileJobQueue.nack` gains `options?: { permanent?: boolean }`.                                                                                                                                   |
| `packages/persistence/src/postgres/migrations.ts` (modify)         | Migration v2: `jobs` table.                                                                                                                                                                      |
| `packages/persistence/src/postgres/job-queue.ts` (new)             | `PostgresJobQueue implements JobQueue`.                                                                                                                                                          |
| `packages/persistence/src/postgres/transaction-runner.ts` (new)    | `PostgresTransactionRunner` — `sql.begin` wrapper.                                                                                                                                               |
| `packages/persistence/src/postgres/project-repository.ts` (modify) | `create`/`update` accept optional `tx`.                                                                                                                                                          |
| `packages/persistence/src/postgres/run-repositories.ts` (modify)   | `PostgresWorkflowRunRepository.create` accepts optional `tx`.                                                                                                                                    |
| `packages/persistence/src/postgres/event-store.ts` (modify)        | `append` accepts optional `tx`.                                                                                                                                                                  |
| `packages/orchestrator/src/worker-loop.ts` (modify)                | `classifyJobOutcome` + rewired catch block.                                                                                                                                                      |
| `packages/orchestrator/src/project-service.ts` (modify)            | Inject `TransactionRunner`; wrap `create()`, manual re-run, `requeueProject()`.                                                                                                                  |
| `packages/orchestrator/src/testing/harness.ts` (modify)            | Pass a `NoopTransactionRunner` into the test `ProjectService`.                                                                                                                                   |
| `packages/composition/src/runtime.ts` (modify)                     | Branch queue on `persistenceMode`; return `sql`/`transactionRunner` from `createMetadataStores`; loosen `Runtime.queue` type.                                                                    |
| `docs/adr/0035-durable-queue-transactional-seam.md` (new)          | Decision record.                                                                                                                                                                                 |

---

## Task 1: Domain ports — `Tx`/`TransactionRunner`, widened signatures, `NoopTransactionRunner`

**Files:**

- Modify: `packages/domain/src/ports.ts:63-70` (ProjectRepository), `:123-128` (WorkflowRunRepository), `:202-205` (EventStore), `:217-224` (JobQueue)
- Create: `packages/persistence/src/transaction-runner.ts`
- Test: `packages/persistence/src/transaction-runner.test.ts`

**Interfaces:**

- Produces: `Tx` (opaque brand), `TransactionRunner.run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>`, `NoopTransactionRunner` — all consumed by Tasks 4, 5, 7, 8.

- [ ] **Step 1: Write the failing test for `NoopTransactionRunner`**

```typescript
// packages/persistence/src/transaction-runner.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/transaction-runner.test.ts`
Expected: FAIL — `Cannot find module './transaction-runner.js'`

- [ ] **Step 3: Add the port to `packages/domain/src/ports.ts`**

Insert immediately after the `JobQueue` interface (currently ends at line 224, right before `export interface WorkflowRepository {`):

```typescript
/**
 * Opaque transaction handle threaded through write methods that must join a
 * shared database transaction. Never held past the callback that produced it
 * -- Postgres impls cast it back to their Sql client; file impls ignore it
 * (file mode has no cross-repository transactions).
 */
export type Tx = { readonly __tx: unique symbol };

export interface TransactionRunner {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}
```

Then widen these four existing signatures (add the trailing optional param only — nothing else changes):

`ProjectRepository` (lines 63-70):

```typescript
export interface ProjectRepository {
  create(project: Project, tx?: Tx): Promise<void>;
  get(projectId: string): Promise<Project | null>;
  update(project: Project, expectedVersion: number, tx?: Tx): Promise<Project>;
  list(limit?: number): Promise<Project[]>;
  /** Every project, unpaged — for sweeps (e.g. blob GC) that must see the whole set. */
  listAll(): Promise<Project[]>;
}
```

`WorkflowRunRepository` (lines 123-128):

```typescript
export interface WorkflowRunRepository {
  create(run: WorkflowRun, tx?: Tx): Promise<void>;
  get(runId: string): Promise<WorkflowRun | null>;
  list(projectId: string, limit?: number): Promise<WorkflowRun[]>;
  update(run: WorkflowRun, expectedVersion: number): Promise<WorkflowRun>;
}
```

`EventStore` (lines 202-205):

```typescript
export interface EventStore {
  append(event: ProjectEvent, tx?: Tx): Promise<void>;
  list(projectId: string, limit?: number, afterId?: string): Promise<ProjectEvent[]>;
}
```

`JobQueue` (lines 217-224):

```typescript
export interface JobQueue {
  enqueue(job: QueueJob, tx?: Tx): Promise<void>;
  claim(workerId: string): Promise<QueueJob | null>;
  heartbeat(job: QueueJob, workerId: string): Promise<QueueJob>;
  ack(job: QueueJob, workerId: string): Promise<void>;
  nack(
    job: QueueJob,
    workerId: string,
    error: Error,
    options?: { permanent?: boolean },
  ): Promise<void>;
  reapExpired(): Promise<QueueJob[]>;
}
```

- [ ] **Step 4: Create `packages/persistence/src/transaction-runner.ts`**

```typescript
import type { Tx, TransactionRunner } from '@agent-foundry/domain';

/** File-mode TransactionRunner: no real transaction exists, so it just invokes
 * the callback with an unused Tx placeholder. Matches today's best-effort
 * sequential-write behavior exactly. */
export class NoopTransactionRunner implements TransactionRunner {
  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return fn(undefined as unknown as Tx);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/transaction-runner.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5b: Export it from the package barrel**

Add one line to `packages/persistence/src/index.ts`, after line 19 (`export * from './project-version-repository.js';`) and before line 20 (`export * from './postgres/client.js';`):

```typescript
export * from './transaction-runner.js';
```

- [ ] **Step 6: Typecheck the whole workspace**

Run: `npx tsc -b`
Expected: no errors. This is the step that proves `FileProjectRepository`, `FileWorkflowRunRepository`, `FileEventStore`, `FileJobQueue`, and every `InMemory*` fake in `packages/orchestrator/src/testing/harness.ts` still satisfy their (now wider) interfaces without any changes — TypeScript permits an implementation with fewer parameters than an interface whose extra parameters are optional. If this fails, STOP and report which type errors appeared before continuing — that would mean an assumption in this plan is wrong.

- [ ] **Step 7: Commit**

```bash
git add packages/domain/src/ports.ts packages/persistence/src/transaction-runner.ts packages/persistence/src/transaction-runner.test.ts
git commit -m "feat(domain): add TransactionRunner port and widen write-method signatures for issue #55"
```

---

## Task 2: `FileJobQueue.nack` gains `permanent` dead-letter option

**Files:**

- Modify: `packages/persistence/src/job-queue.ts:109-136`
- Test: `packages/persistence/src/job-queue.test.ts` (extend)

**Interfaces:**

- Consumes: `JobQueue.nack(job, workerId, error, options?: { permanent?: boolean })` from Task 1.
- Produces: `FileJobQueue.nack` now dead-letters immediately when `options?.permanent === true`, regardless of `attempts`. Consumed by Task 6 (worker-loop) in file mode.

- [ ] **Step 1: Write the failing test**

Add to `packages/persistence/src/job-queue.test.ts` (mirror the existing `'moves a job to failed once maxAttempts is exhausted...'` test style — `baseJob`, `FakeClock`, `temporaryDataDir` are already defined in this file):

```typescript
it('dead-letters immediately when nack is called with permanent: true, even on the first attempt', async () => {
  const dataDir = await temporaryDataDir();
  const clock = new FakeClock(new Date(createdAt));
  const queue = new FileJobQueue(dataDir, { leaseMs: 60_000, clock });
  await queue.enqueue(baseJob());
  const claimed = await queue.claim('worker-a');

  await queue.nack(claimed!, 'worker-a', new Error('unrecoverable'), { permanent: true });

  expect(await queue.claim('worker-b')).toBeNull();
  const failedPath = join(dataDir, 'queue', 'failed', 'job-1.json');
  const failed = JSON.parse(await readFile(failedPath, 'utf8'));
  expect(failed.attempts).toBe(1);
  expect(failed.lastError).toBe('unrecoverable');
});
```

(`join` and `readFile` are already imported at the top of this test file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/job-queue.test.ts -t "dead-letters immediately"`
Expected: FAIL — the job goes back to `pending` (attempts 1 < maxAttempts 3), so `claim('worker-b')` returns the job instead of `null`.

- [ ] **Step 3: Implement — widen `nack` and dead-letter on `permanent`**

Replace `nack` (`packages/persistence/src/job-queue.ts:109-136`):

```typescript
  async nack(
    job: QueueJob,
    workerId: string,
    error: Error,
    options?: { permanent?: boolean },
  ): Promise<void> {
    const current = await this.readLeasedJob(job.id, workerId);
    this.assertFencingToken(current, job, workerId);
    const from = this.processingPath(job.id, workerId);
    const attempts = current.attempts + 1;
    const updated = QueueJobSchema.parse({
      ...current,
      attempts,
      lastError: error.message,
      availableAt: new Date(
        this.clock.now().getTime() + Math.min(30_000, 1_000 * 2 ** attempts),
      ).toISOString(),
      lease: undefined,
    });

    if (options?.permanent === true || attempts >= job.maxAttempts) {
      const failed = this.dir('failed');
      await ensureDir(failed);
      await rm(join(this.dir('pending'), `${safeSegment(job.id)}.json`), { force: true });
      await atomicWriteJson(join(failed, `${safeSegment(job.id)}.json`), updated);
      await rm(from, { force: true });
      return;
    }

    await ensureDir(this.dir('pending'));
    await atomicWriteJson(join(this.dir('pending'), `${safeSegment(job.id)}.json`), updated);
    await rm(from, { force: true });
  }
```

(Only the method signature and the `if` condition changed — the body is otherwise identical to today's implementation.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/job-queue.test.ts`
Expected: PASS (all existing tests plus the new one)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/persistence/src/job-queue.ts packages/persistence/src/job-queue.test.ts
git commit -m "feat(queue): let FileJobQueue.nack dead-letter immediately via permanent option"
```

---

## Task 3: Migration v2 — durable `jobs` table

**Files:**

- Modify: `packages/persistence/src/postgres/migrations.ts`
- Test: `packages/persistence/src/postgres/migrator.test.ts` (no new test needed — its existing `'applies all migrations up, is idempotent, and reverts down'` and `'has strictly increasing versions...'` tests already iterate `MIGRATIONS` generically and will cover version 2 automatically)

**Interfaces:**

- Produces: a `jobs` table (columns listed below) that Task 4's `PostgresJobQueue` reads/writes directly — no ORM, no `data` blob (deliberate deviation from the house pattern; every other table stores `data jsonb` + projected columns, but `jobs` mutates field-by-field on every claim/heartbeat/nack/reap, so a synced blob would just drift — documented in the ADR, Task 9).

- [ ] **Step 1: Run the existing generic migration test to confirm current baseline**

Run: `npx vitest run packages/persistence/src/postgres/migrator.test.ts -t "has strictly increasing versions"`
Expected: PASS (baseline: 1 migration)

- [ ] **Step 2: Append migration v2 to `packages/persistence/src/postgres/migrations.ts`**

Add a second element to the `MIGRATIONS` array (after the closing `},` of the version-1 entry, before the closing `];`):

```typescript
  {
    version: 2,
    name: 'durable-queue',
    up: /* sql */ `
create type job_status as enum ('pending','processing','completed','failed');

create table jobs (
  id path_segment primary key,
  type text not null check (type in ('run-project','run-conversation-operation')),
  project_id path_segment not null,
  workflow_id path_segment not null,
  run_id path_segment,
  operation_id path_segment,
  status job_status not null default 'pending',
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null check (max_attempts >= 1),
  created_at timestamptz not null,
  available_at timestamptz not null,
  last_error text,
  lease_epoch integer not null default 0 check (lease_epoch >= 0),
  worker_id text,
  fencing_token integer,
  heartbeat_at timestamptz,
  expires_at timestamptz,
  trace_context jsonb
);
create index jobs_claim_idx on jobs (available_at, id) where status = 'pending';
create index jobs_reap_idx  on jobs (expires_at)       where status = 'processing';
`,
    down: /* sql */ `
drop table if exists jobs;
drop type if exists job_status;
`,
  },
```

(No foreign keys on `project_id`/`workflow_id`/`run_id`: queue lifetime must not be cascade-coupled to project deletion, and `requeueProject` enqueues with a synthetic `run-project-${runId}` id that doesn't necessarily match a live row at enqueue time.)

- [ ] **Step 3: Run the migrator test suite (requires Docker)**

Run: `npx vitest run packages/persistence/src/postgres/migrator.test.ts`
Expected: PASS — `'has strictly increasing versions...'` now asserts `latestVersion()` is 2; `'applies all migrations up, is idempotent, and reverts down'` creates a real container, runs `migrateUp` (both versions), asserts the `projects` table exists, runs `migrateDown(sql, 0)`, asserts it's gone, re-runs `migrateUp`. This exercises the v2 `up`/`down` round-trip automatically. If Docker isn't available locally this suite is skipped (not failed) — see Task 4 for how to check Docker availability before relying on a "PASS".

- [ ] **Step 4: Commit**

```bash
git add packages/persistence/src/postgres/migrations.ts
git commit -m "feat(persistence): add durable-queue migration (jobs table)"
```

---

## Task 4: `PostgresJobQueue implements JobQueue`

**Files:**

- Create: `packages/persistence/src/postgres/job-queue.ts`
- Test: `packages/persistence/src/postgres/job-queue.test.ts` (new)

**Interfaces:**

- Consumes: `jobs` table from Task 3; `JobQueue`, `Tx`, `Clock`, `LeaseLostError` from `@agent-foundry/domain`; `QueueJobSchema`/`QueueJob` from `@agent-foundry/contracts`; `PostgresDb` from `./client.js`.
- Produces: `PostgresJobQueue` class, consumed by Task 8 (`runtime.ts` wiring) and Task 5 (its `enqueue` is the one call in the transactional seam).

- [ ] **Step 1: Write the failing tests**

Create `packages/persistence/src/postgres/job-queue.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { QueueJob, Clock } from '@agent-foundry/contracts';
import { LeaseLostError } from '@agent-foundry/domain';
import { describePostgres } from './testing.js';
import { PostgresJobQueue } from './job-queue.js';

class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const createdAt = '2026-07-14T12:00:00.000Z';

function baseJob(id = 'job-1'): QueueJob {
  return {
    id,
    type: 'run-project',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    attempts: 0,
    maxAttempts: 3,
    createdAt,
    availableAt: createdAt,
    leaseEpoch: 0,
  };
}

describePostgres('PostgresJobQueue', (ctx) => {
  it('claim returns null when there are no pending jobs', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    expect(await queue.claim('worker-a')).toBeNull();
  });

  it('enqueues and claims the earliest available job, granting a lease with fencing token 1', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());

    const claimed = await queue.claim('worker-a');

    expect(claimed?.id).toBe('job-1');
    expect(claimed?.lease?.workerId).toBe('worker-a');
    expect(claimed?.lease?.fencingToken).toBe(1);
    expect(claimed?.leaseEpoch).toBe(1);
  });

  it('does not claim a job whose availableAt is in the future', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue({
      ...baseJob(),
      availableAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    });

    expect(await queue.claim('worker-a')).toBeNull();
  });

  it('two workers claiming concurrently get disjoint jobs (FOR UPDATE SKIP LOCKED)', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob('job-1'));
    await queue.enqueue(baseJob('job-2'));

    const [a, b] = await Promise.all([queue.claim('worker-a'), queue.claim('worker-b')]);

    const ids = [a?.id, b?.id].sort();
    expect(ids).toEqual(['job-1', 'job-2']);
    expect(await queue.claim('worker-c')).toBeNull();
  });

  it('enqueue is idempotent on a duplicate id', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    await queue.enqueue(baseJob());

    await queue.claim('worker-a');
    expect(await queue.claim('worker-b')).toBeNull();
  });

  it('heartbeat renews the lease and rejects a stale fencing token with LeaseLostError', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    clock.advanceMs(1_000);
    const renewed = await queue.heartbeat(claimed!, 'worker-a');
    expect(renewed.lease?.heartbeatAt).not.toBe(claimed!.lease?.heartbeatAt);

    await expect(queue.heartbeat(claimed!, 'worker-b')).rejects.toThrow(LeaseLostError);
  });

  it('ack marks the job completed and rejects a lost lease', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    await expect(queue.ack(claimed!, 'worker-b')).rejects.toThrow(LeaseLostError);
    await queue.ack(claimed!, 'worker-a');

    const [row] = await ctx.db()<{ status: string }[]>`select status from jobs where id = 'job-1'`;
    expect(row?.status).toBe('completed');
  });

  it('nack increments attempts, reschedules with backoff, and clears the lease', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    await queue.nack(claimed!, 'worker-a', new Error('transient'));

    const [row] = await ctx.db()<{ status: string; attempts: number; worker_id: string | null }[]>`
      select status, attempts, worker_id from jobs where id = 'job-1'`;
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.worker_id).toBeNull();
  });

  it('nack dead-letters once maxAttempts is exhausted', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue({ ...baseJob(), attempts: 2, maxAttempts: 3 });
    const claimed = await queue.claim('worker-a');

    await queue.nack(claimed!, 'worker-a', new Error('final failure'));

    const [row] = await ctx.db()<{ status: string }[]>`select status from jobs where id = 'job-1'`;
    expect(row?.status).toBe('failed');
  });

  it('nack({ permanent: true }) dead-letters immediately regardless of attempts', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    await queue.nack(claimed!, 'worker-a', new Error('unrecoverable'), { permanent: true });

    const [row] = await ctx.db()<{ status: string }[]>`select status from jobs where id = 'job-1'`;
    expect(row?.status).toBe('failed');
  });

  it('reapExpired reclaims a processing job past its lease and bumps the epoch so the old worker is fenced out', async () => {
    const clock = new FakeClock(new Date(createdAt));
    const queue = new PostgresJobQueue(ctx.db(), { leaseMs: 60_000, clock });
    await queue.enqueue(baseJob());
    const claimed = await queue.claim('worker-a');

    clock.advanceMs(61_000);
    const recovered = await queue.reapExpired();
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.id).toBe('job-1');

    const reclaimed = await queue.claim('worker-b');
    expect(reclaimed?.lease?.fencingToken).toBe(2);
    await expect(queue.heartbeat(claimed!, 'worker-a')).rejects.toThrow(LeaseLostError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `docker info >/dev/null 2>&1 && npx vitest run packages/persistence/src/postgres/job-queue.test.ts || echo "Docker unavailable — see note below"`
Expected: FAIL — `Cannot find module './job-queue.js'`. If Docker is unavailable, this suite is skipped rather than failed; note that in the task output and proceed (CI has Docker and will run it for real — `testing.ts:16` refuses to skip under `CI=true`).

- [ ] **Step 3: Implement `packages/persistence/src/postgres/job-queue.ts`**

```typescript
import { QueueJobSchema, type QueueJob } from '@agent-foundry/contracts';
import { LeaseLostError, type Clock, type JobQueue, type Tx } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';
import { toJsonb } from './versioned.js';

export interface PostgresJobQueueOptions {
  leaseMs: number;
  clock: Clock;
}

interface JobRow {
  id: string;
  type: string;
  project_id: string;
  workflow_id: string;
  run_id: string | null;
  operation_id: string | null;
  attempts: number;
  max_attempts: number;
  created_at: Date;
  available_at: Date;
  last_error: string | null;
  lease_epoch: number;
  worker_id: string | null;
  fencing_token: number | null;
  heartbeat_at: Date | null;
  expires_at: Date | null;
  trace_context: Record<string, string> | null;
}

export class PostgresJobQueue implements JobQueue {
  constructor(
    private readonly sql: PostgresDb,
    private readonly options: PostgresJobQueueOptions,
  ) {}

  async enqueue(job: QueueJob, tx?: Tx): Promise<void> {
    const parsed = QueueJobSchema.parse(job);
    const db = (tx as unknown as PostgresDb | undefined) ?? this.sql;
    await db`
      insert into jobs (
        id, type, project_id, workflow_id, run_id, operation_id, status,
        attempts, max_attempts, created_at, available_at, last_error,
        lease_epoch, trace_context
      ) values (
        ${parsed.id}, ${parsed.type}, ${parsed.projectId}, ${parsed.workflowId},
        ${parsed.runId ?? null}, ${parsed.operationId ?? null}, 'pending',
        ${parsed.attempts}, ${parsed.maxAttempts}, ${parsed.createdAt}, ${parsed.availableAt},
        ${parsed.lastError ?? null}, ${parsed.leaseEpoch},
        ${parsed.traceContext ? toJsonb(db, parsed.traceContext) : null}
      )
      on conflict (id) do nothing`;
  }

  async claim(workerId: string): Promise<QueueJob | null> {
    const now = this.options.clock.now();
    const expires = new Date(now.getTime() + this.options.leaseMs);
    const rows = await this.sql<JobRow[]>`
      update jobs set
        status = 'processing',
        lease_epoch = lease_epoch + 1,
        worker_id = ${workerId},
        fencing_token = lease_epoch + 1,
        heartbeat_at = ${now},
        expires_at = ${expires}
      where id = (
        select id from jobs
        where status = 'pending' and available_at <= ${now}
        order by available_at, id
        for update skip locked
        limit 1
      )
      returning *`;
    return rows[0] ? this.toQueueJob(rows[0]) : null;
  }

  async heartbeat(job: QueueJob, workerId: string): Promise<QueueJob> {
    if (!job.lease) throw new LeaseLostError(job.id, workerId);
    const now = this.options.clock.now();
    const expires = new Date(now.getTime() + this.options.leaseMs);
    const rows = await this.sql<JobRow[]>`
      update jobs set heartbeat_at = ${now}, expires_at = ${expires}
      where id = ${job.id} and status = 'processing'
        and worker_id = ${workerId} and lease_epoch = ${job.lease.fencingToken}
      returning *`;
    if (!rows[0]) throw new LeaseLostError(job.id, workerId);
    return this.toQueueJob(rows[0]);
  }

  async ack(job: QueueJob, workerId: string): Promise<void> {
    if (!job.lease) throw new LeaseLostError(job.id, workerId);
    const result = await this.sql`
      update jobs set status = 'completed', worker_id = null, fencing_token = null,
        heartbeat_at = null, expires_at = null
      where id = ${job.id} and status = 'processing'
        and worker_id = ${workerId} and lease_epoch = ${job.lease.fencingToken}`;
    if (result.count === 0) throw new LeaseLostError(job.id, workerId);
  }

  async nack(
    job: QueueJob,
    workerId: string,
    error: Error,
    options?: { permanent?: boolean },
  ): Promise<void> {
    if (!job.lease) throw new LeaseLostError(job.id, workerId);
    const now = this.options.clock.now();
    const attempts = job.attempts + 1;
    const backoffMs = Math.min(30_000, 1_000 * 2 ** attempts);
    const dead = options?.permanent === true || attempts >= job.maxAttempts;
    const result = await this.sql`
      update jobs set
        attempts = ${attempts},
        last_error = ${error.message},
        status = ${dead ? 'failed' : 'pending'},
        available_at = ${new Date(now.getTime() + backoffMs)},
        worker_id = null, fencing_token = null, heartbeat_at = null, expires_at = null
      where id = ${job.id} and status = 'processing'
        and worker_id = ${workerId} and lease_epoch = ${job.lease.fencingToken}`;
    if (result.count === 0) throw new LeaseLostError(job.id, workerId);
  }

  async reapExpired(): Promise<QueueJob[]> {
    const now = this.options.clock.now();
    const rows = await this.sql<JobRow[]>`
      update jobs set status = 'pending', worker_id = null, fencing_token = null,
        heartbeat_at = null, expires_at = null
      where status = 'processing' and expires_at < ${now}
      returning *`;
    return rows.map((row) => this.toQueueJob(row));
  }

  private toQueueJob(row: JobRow): QueueJob {
    return QueueJobSchema.parse({
      id: row.id,
      type: row.type,
      projectId: row.project_id,
      workflowId: row.workflow_id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.operation_id ? { operationId: row.operation_id } : {}),
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      createdAt: row.created_at.toISOString(),
      availableAt: row.available_at.toISOString(),
      ...(row.last_error ? { lastError: row.last_error } : {}),
      leaseEpoch: row.lease_epoch,
      ...(row.worker_id && row.fencing_token !== null && row.heartbeat_at && row.expires_at
        ? {
            lease: {
              workerId: row.worker_id,
              fencingToken: row.fencing_token,
              heartbeatAt: row.heartbeat_at.toISOString(),
              expiresAt: row.expires_at.toISOString(),
            },
          }
        : {}),
      ...(row.trace_context ? { traceContext: row.trace_context } : {}),
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/postgres/job-queue.test.ts`
Expected: PASS (12 tests). Requires Docker; the suite pulls `postgres:17-alpine` via testcontainers on first run.

- [ ] **Step 4b: Export it from the package barrel**

Add one line to `packages/persistence/src/index.ts`, after `export * from './postgres/client.js';` (line 20):

```typescript
export * from './postgres/job-queue.js';
```

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/persistence/src/postgres/job-queue.ts packages/persistence/src/postgres/job-queue.test.ts packages/persistence/src/index.ts
git commit -m "feat(persistence): add PostgresJobQueue with lease/fencing/backoff/dead-letter semantics"
```

---

## Task 5: `PostgresTransactionRunner` + thread `tx` through Postgres repos + atomicity test

**Files:**

- Create: `packages/persistence/src/postgres/transaction-runner.ts`
- Modify: `packages/persistence/src/postgres/project-repository.ts`, `packages/persistence/src/postgres/run-repositories.ts` (only `PostgresWorkflowRunRepository`), `packages/persistence/src/postgres/event-store.ts`
- Test: `packages/persistence/src/postgres/transactional-atomicity.test.ts` (new)

**Interfaces:**

- Consumes: `Tx`/`TransactionRunner` (Task 1), `PostgresJobQueue.enqueue(job, tx?)` (Task 4), `insertVersioned`/`updateVersioned` (already accept a `sql: PostgresDb` first arg — a transaction handle from `sql.begin` is itself assignable to `PostgresDb`, so no changes needed there).
- Produces: `PostgresTransactionRunner`, consumed by Task 8 (`runtime.ts`) and used implicitly by Task 7 (`project-service.ts`).

- [ ] **Step 1: Write the failing atomicity test**

Create `packages/persistence/src/postgres/transactional-atomicity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import type { Project, QueueJob, WorkflowRun } from '@agent-foundry/contracts';
import { describePostgres } from './testing.js';
import { PostgresTransactionRunner } from './transaction-runner.js';
import { PostgresProjectRepository } from './project-repository.js';
import { PostgresWorkflowRunRepository } from './run-repositories.js';
import { PostgresEventStore } from './event-store.js';
import { PostgresJobQueue } from './job-queue.js';

const now = '2026-07-14T12:00:00.000Z';

function project(): Project {
  return {
    id: 'project-1',
    name: 'Test Project',
    workflowId: 'web-app-v1',
    policyId: 'default',
    status: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
    currentRunId: 'run-1',
  };
}

function run(): WorkflowRun {
  return {
    id: 'run-1',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    status: 'queued',
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function job(): QueueJob {
  return {
    id: 'job-1',
    type: 'run-project',
    projectId: 'project-1',
    workflowId: 'web-app-v1',
    runId: 'run-1',
    attempts: 0,
    maxAttempts: 2,
    createdAt: now,
    availableAt: now,
    leaseEpoch: 0,
  };
}

describePostgres('transactional seam atomicity', (ctx) => {
  it('a failure mid-transaction persists no project, no run, no event, and no job', async () => {
    const sql = ctx.db();
    const runner = new PostgresTransactionRunner(sql);
    const projects = new PostgresProjectRepository(sql);
    const runs = new PostgresWorkflowRunRepository(sql);
    const events = new PostgresEventStore(sql);
    const queue = new PostgresJobQueue(sql, {
      leaseMs: 60_000,
      clock: { now: () => new Date(now) },
    });

    await expect(
      runner.run(async (tx) => {
        await projects.create(project(), tx);
        await runs.create(run(), tx);
        await events.append(
          {
            id: 'event-1',
            projectId: 'project-1',
            type: 'project.created',
            createdAt: now,
            message: 'created',
            data: {},
          },
          tx,
        );
        await queue.enqueue(job(), tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await projects.get('project-1')).toBeNull();
    expect(await events.list('project-1')).toHaveLength(0);
    const [jobRow] = await sql<{ id: string }[]>`select id from jobs where id = 'job-1'`;
    expect(jobRow).toBeUndefined();
  });

  it('a committed transaction persists the project, run, event, and job atomically', async () => {
    const sql = ctx.db();
    const runner = new PostgresTransactionRunner(sql);
    const projects = new PostgresProjectRepository(sql);
    const runs = new PostgresWorkflowRunRepository(sql);
    const events = new PostgresEventStore(sql);
    const queue = new PostgresJobQueue(sql, {
      leaseMs: 60_000,
      clock: { now: () => new Date(now) },
    });

    await runner.run(async (tx) => {
      await projects.create(project(), tx);
      await runs.create(run(), tx);
      await events.append(
        {
          id: 'event-1',
          projectId: 'project-1',
          type: 'project.created',
          createdAt: now,
          message: 'created',
          data: {},
        },
        tx,
      );
      await queue.enqueue(job(), tx);
    });

    expect(await projects.get('project-1')).not.toBeNull();
    expect(await events.list('project-1')).toHaveLength(1);
    const [jobRow] = await sql<{ id: string }[]>`select id from jobs where id = 'job-1'`;
    expect(jobRow?.id).toBe('job-1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/persistence/src/postgres/transactional-atomicity.test.ts`
Expected: FAIL — `Cannot find module './transaction-runner.js'`

- [ ] **Step 3: Create `packages/persistence/src/postgres/transaction-runner.ts`**

```typescript
import type { Tx, TransactionRunner } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';

export class PostgresTransactionRunner implements TransactionRunner {
  constructor(private readonly sql: PostgresDb) {}

  run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.sql.begin((tx) => fn(tx as unknown as Tx));
  }
}
```

Add one line to `packages/persistence/src/index.ts`, after `export * from './postgres/job-queue.js';` (added in Task 4):

```typescript
export * from './postgres/transaction-runner.js';
```

- [ ] **Step 4: Thread `tx` through `PostgresProjectRepository`**

In `packages/persistence/src/postgres/project-repository.ts`, change `create` and `update`:

```typescript
  async create(project: Project, tx?: Tx): Promise<void> {
    const parsed = ProjectSchema.parse(project);
    await insertVersioned((tx as unknown as PostgresDb | undefined) ?? this.sql, {
      table: 'projects',
      entity: 'project',
      id: parsed.id,
      version: parsed.version,
      columns: columnsFor(parsed),
      data: parsed,
    });
  }
```

```typescript
  async update(project: Project, expectedVersion: number, tx?: Tx): Promise<Project> {
    if (project.version !== expectedVersion) {
      throw new VersionConflictError('project', project.id, expectedVersion, project.version);
    }
    const next = ProjectSchema.parse({ ...project, version: expectedVersion + 1 });
    await updateVersioned((tx as unknown as PostgresDb | undefined) ?? this.sql, {
      table: 'projects',
      entity: 'project',
      id: project.id,
      keyColumns: { id: project.id },
      expectedVersion,
      nextData: next,
      columns: columnsFor(next),
    });
    return next;
  }
```

Add `Tx` to the import from `@agent-foundry/domain` at the top of the file: `import { VersionConflictError, type Tx } from '@agent-foundry/domain';`.

- [ ] **Step 5: Thread `tx` through `PostgresWorkflowRunRepository.create`**

In `packages/persistence/src/postgres/run-repositories.ts`, change only `PostgresWorkflowRunRepository.create` (leave `update`, and every `StepRunRepository`/`StepAttemptRepository` method, untouched — they're not part of the seam):

```typescript
  async create(run: WorkflowRun, tx?: Tx): Promise<void> {
    const parsed = WorkflowRunSchema.parse(run);
    await insertVersioned((tx as unknown as PostgresDb | undefined) ?? this.sql, {
      table: 'workflow_runs',
      entity: 'workflow-run',
      id: parsed.id,
      version: parsed.version,
      columns: runColumns(parsed),
      data: parsed,
    });
  }
```

Add `type Tx` to the `@agent-foundry/domain` import at the top: `import { VersionConflictError, type Tx } from '@agent-foundry/domain';`.

- [ ] **Step 6: Thread `tx` through `PostgresEventStore.append`**

In `packages/persistence/src/postgres/event-store.ts`:

```typescript
import { ProjectEventSchema, type ProjectEvent } from '@agent-foundry/contracts';
import { redactEvent, type EventStore, type Tx } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';
import { toJsonb } from './versioned.js';

export class PostgresEventStore implements EventStore {
  constructor(private readonly sql: PostgresDb) {}

  async append(event: ProjectEvent, tx?: Tx): Promise<void> {
    const parsed = redactEvent(ProjectEventSchema.parse(event));
    const db = (tx as unknown as PostgresDb | undefined) ?? this.sql;
    await db`
      insert into project_events (id, project_id, run_id, type, dedupe_key, created_at, data)
      values (
        ${parsed.id}, ${parsed.projectId}, ${parsed.runId ?? null}, ${parsed.type},
        ${parsed.dedupeKey ?? null}, ${parsed.createdAt}, ${toJsonb(db, parsed)}
      )
      on conflict (project_id, dedupe_key) where dedupe_key is not null do nothing`;
  }

  async list(projectId: string, limit = 500, afterId?: string): Promise<ProjectEvent[]> {
    if (afterId === undefined) {
      const rows = await this.sql<{ data: unknown }[]>`
        select data from project_events
        where project_id = ${projectId}
        order by id desc
        limit ${limit}`;
      return rows.map((row) => ProjectEventSchema.parse(row.data)).reverse();
    }
    const rows = await this.sql<{ data: unknown }[]>`
      select data from project_events
      where project_id = ${projectId} and id > ${afterId}
      order by id asc
      limit ${limit}`;
    return rows.map((row) => ProjectEventSchema.parse(row.data));
  }
}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run packages/persistence/src/postgres/transactional-atomicity.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 8: Run the full Postgres suite to check nothing regressed**

Run: `npx vitest run packages/persistence/src/postgres/`
Expected: PASS (all `postgres/` suites, including Task 3's and Task 4's)

- [ ] **Step 9: Typecheck**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add packages/persistence/src/postgres/transaction-runner.ts packages/persistence/src/postgres/project-repository.ts packages/persistence/src/postgres/run-repositories.ts packages/persistence/src/postgres/event-store.ts packages/persistence/src/postgres/transactional-atomicity.test.ts packages/persistence/src/index.ts
git commit -m "feat(persistence): thread transaction through project/run/event/queue writes"
```

---

## Task 6: Retry classification in the worker (transient / permanent / cancelled)

**Files:**

- Modify: `packages/orchestrator/src/worker-loop.ts:1-9` (imports), `:89-99` (catch block)
- Test: `packages/orchestrator/src/worker-loop.test.ts` (extend + fix one existing assertion)

**Interfaces:**

- Consumes: `RunCancelledError` (`packages/domain/src/errors.ts:171`), `EmergencyCeilingError` (`packages/domain/src/errors.ts:93`), `JobQueue.nack(..., options?)` (Task 1/2/4).
- Produces: `classifyJobOutcome(error: unknown): 'cancelled' | 'permanent' | 'transient'` — exported for direct unit testing.

- [ ] **Step 1: Write the failing tests**

Add to `packages/orchestrator/src/worker-loop.test.ts` (this file already defines `job()`, `deferred()`, `fakeQueue()`, `fakeOperationRunner()` — reuse them):

```typescript
import { classifyJobOutcome, WorkerLoop, type JobLogger } from './worker-loop.js';
```

(add `classifyJobOutcome` to the existing `import { WorkerLoop, type JobLogger } from './worker-loop.js';` line at the top of the file)

```typescript
describe('classifyJobOutcome', () => {
  it('classifies RunCancelledError as cancelled', async () => {
    const { RunCancelledError } = await import('@agent-foundry/domain');
    expect(classifyJobOutcome(new RunCancelledError('run-1'))).toBe('cancelled');
  });

  it('classifies EmergencyCeilingError as permanent', async () => {
    const { EmergencyCeilingError } = await import('@agent-foundry/domain');
    expect(classifyJobOutcome(new EmergencyCeilingError('run-1', 'active-time'))).toBe('permanent');
  });

  it('classifies a generic Error as transient', () => {
    expect(classifyJobOutcome(new Error('boom'))).toBe('transient');
  });
});

describe('WorkerLoop retry classification end-to-end', () => {
  it('acks (does not nack) when the run fails with RunCancelledError', async () => {
    const { RunCancelledError } = await import('@agent-foundry/domain');
    const claimedJob = job();
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(claimedJob) });
    const orchestrator = {
      runProject: vi.fn().mockRejectedValue(new RunCancelledError('run-1')),
    } as unknown as WorkflowOrchestrator;
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
    });

    await worker.runOnce();

    expect(queue.ack).toHaveBeenCalledWith(claimedJob, 'worker-a');
    expect(queue.nack).not.toHaveBeenCalled();
  });

  it('nacks with permanent: true when the run fails with EmergencyCeilingError', async () => {
    const { EmergencyCeilingError } = await import('@agent-foundry/domain');
    const claimedJob = job();
    const error = new EmergencyCeilingError('run-1', 'active-time');
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(claimedJob) });
    const orchestrator = {
      runProject: vi.fn().mockRejectedValue(error),
    } as unknown as WorkflowOrchestrator;
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
    });

    await worker.runOnce();

    expect(queue.nack).toHaveBeenCalledWith(claimedJob, 'worker-a', error, { permanent: true });
    expect(queue.ack).not.toHaveBeenCalled();
  });

  it('nacks with permanent: false for a generic run failure', async () => {
    const claimedJob = job();
    const error = new Error('generic failure');
    const queue = fakeQueue({ claim: vi.fn().mockResolvedValue(claimedJob) });
    const orchestrator = {
      runProject: vi.fn().mockRejectedValue(error),
    } as unknown as WorkflowOrchestrator;
    const worker = new WorkerLoop(queue, orchestrator, fakeOperationRunner(), {
      workerId: 'worker-a',
      pollIntervalMs: 1_000,
    });

    await worker.runOnce();

    expect(queue.nack).toHaveBeenCalledWith(claimedJob, 'worker-a', error, { permanent: false });
  });
});
```

Also **fix the existing test** at line ~247-277 (`'nacks with the run error and the latest heartbeat-renewed job when the run fails'`) — its `expect(queue.nack).toHaveBeenCalledWith(...)` currently has 3 arguments; add the 4th:

```typescript
expect(queue.nack).toHaveBeenCalledWith(
  renewedJob,
  'worker-a',
  expect.objectContaining({ message: 'boom' }),
  { permanent: false },
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/orchestrator/src/worker-loop.test.ts`
Expected: FAIL — `classifyJobOutcome` is not exported; the fixed existing test also fails until Step 3 lands (arity mismatch on `nack`).

- [ ] **Step 3: Implement — add `classifyJobOutcome` and rewire the catch block**

In `packages/orchestrator/src/worker-loop.ts`, change the import block (lines 1-9):

```typescript
import type { QueueJob } from '@agent-foundry/contracts';
import type { JobQueue } from '@agent-foundry/domain';
import {
  EmergencyCeilingError,
  LeaseLostError,
  RunCancelledError,
  errorMessage,
  recordQueueWait,
  withExtractedContext,
  withSpan,
} from '@agent-foundry/domain';
import type { ConversationOperationRunner } from './conversation-operation-runner.js';
import type { WorkflowOrchestrator } from './workflow-orchestrator.js';
```

Add this exported function above the `WorkerLoop` class (after the `HeartbeatState` interface, before `export class WorkerLoop`):

```typescript
export type JobOutcome = 'cancelled' | 'permanent' | 'transient';

/** Maps a thrown run error to a queue outcome. Cancellation is consumed (ack,
 * no retry); EmergencyCeilingError is terminal (dead-letter now); everything
 * else defaults to transient (nack with backoff) -- the safe default for an
 * error type this classifier doesn't recognize. */
export function classifyJobOutcome(error: unknown): JobOutcome {
  if (error instanceof RunCancelledError) return 'cancelled';
  if (error instanceof EmergencyCeilingError) return 'permanent';
  return 'transient';
}
```

Replace the `catch` block in `runOnce()` (lines 89-99):

```typescript
    } catch (error) {
      await stopHeartbeat();
      if (!state.leaseLost) {
        const err = error instanceof Error ? error : new Error(errorMessage(error));
        const outcome = classifyJobOutcome(error);
        if (outcome === 'cancelled') {
          await this.queue.ack(state.job, this.options.workerId);
        } else {
          await this.queue.nack(state.job, this.options.workerId, err, {
            permanent: outcome === 'permanent',
          });
        }
      }
      log?.error({ err: error }, 'job failed');
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/orchestrator/src/worker-loop.test.ts`
Expected: PASS (all existing tests + 6 new ones)

- [ ] **Step 5: Typecheck**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/orchestrator/src/worker-loop.ts packages/orchestrator/src/worker-loop.test.ts
git commit -m "feat(orchestrator): classify job outcomes as cancelled/permanent/transient in the worker"
```

---

## Task 7: `ProjectService` — transactional `create()`, manual re-run, and `requeueProject()`

**Files:**

- Modify: `packages/orchestrator/src/project-service.ts` (constructor at line 69, `create()` at lines 122-200, manual re-run at lines ~277-325, `requeueProject()` at lines 973-999, `appendEvent` helper at lines 1059-~1075)
- Modify: `packages/orchestrator/src/testing/harness.ts` (the one `new ProjectService(...)` call site, ~line 1329)
- Test: `packages/orchestrator/src/project-service.test.ts` (run existing suite; fix any test asserting exact mock-call ordering between artifacts and events — see Step 5)

**Interfaces:**

- Consumes: `TransactionRunner` (Task 1), widened `ProjectRepository`/`WorkflowRunRepository`/`EventStore`/`JobQueue` signatures (Task 1).
- Produces: `ProjectService` constructor gains one new required parameter, `transactionRunner: TransactionRunner`, inserted immediately after `queue`.

**Design note carried over from planning:** artifacts (`prd`, `scaffold-manifest`) are **not** threaded through the transaction. `artifacts.project_id references projects(id)`, so if `projects.create` runs inside an uncommitted transaction, a separate-connection artifact write can't see that row yet (FK violation or block). Rather than thread `ArtifactStore.put` through the seam (it self-opens `sql.begin` and would need a parallel non-transactional code path), **artifacts move to after the transaction commits** — the project row is already durable and visible by then, and nothing downstream in `create()` depends on the artifacts existing before events/enqueue fire.

- [ ] **Step 1: Add `transactionRunner` to the constructor**

In `packages/orchestrator/src/project-service.ts`, add `TransactionRunner` to the `@agent-foundry/domain` type import (top of file, alongside the existing `JobQueue`, `ProjectRepository`, etc.):

```typescript
import type {
  ApprovalDecisionRepository,
  ApprovalRequestRepository,
  ArtifactStore,
  Clock,
  EventStore,
  GeneratedProjectRuntime,
  HarnessRepository,
  IdGenerator,
  JobQueue,
  ModelRouter,
  ModelOverrideRepository,
  PolicyRepository,
  ProjectRepository,
  ResumeDiagnostic,
  StepAttemptRepository,
  StepRunRepository,
  TransactionRunner,
  WorkspaceManager,
  WorkflowRunRepository,
  WorkflowRepository,
} from '@agent-foundry/domain';
```

Insert `transactionRunner` right after `queue` in the constructor (line 79):

```typescript
export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly runs: WorkflowRunRepository,
    private readonly stepRuns: StepRunRepository,
    private readonly stepAttempts: StepAttemptRepository,
    private readonly approvalRequests: ApprovalRequestRepository,
    private readonly approvalDecisions: ApprovalDecisionRepository,
    private readonly artifacts: ArtifactStore,
    private readonly events: EventStore,
    private readonly queue: JobQueue,
    private readonly transactionRunner: TransactionRunner,
    private readonly workflows: WorkflowRepository,
    private readonly policies: PolicyRepository,
    private readonly harness: HarnessRepository,
    private readonly router: ModelRouter,
    private readonly workspaces: WorkspaceManager,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly modelOverrides?: ModelOverrideRepository,
    private readonly qualityObservations?: QualityObservationService,
    private readonly generatedProjectRuntime?: GeneratedProjectRuntime,
  ) {}
```

- [ ] **Step 2: Rewrite `create()` to use the transaction and move artifacts after commit**

Replace lines 150-199 (from `await this.workspaces.ensure(...)` through the end of `create()`) with:

```typescript
    await this.workspaces.ensure(project.id);
    await this.generatedProjectRuntime?.initialize({ projectId: project.id });
    await this.workspaces.writePrd(project.id, input.prd);
    const scaffoldFiles = await this.harness.scaffoldFiles(workflow.stack);
    if (scaffoldFiles.length > 0) {
      await this.workspaces.applyScaffold(project.id, scaffoldFiles);
    }

    const job: QueueJob = {
      id: this.ids.next(),
      type: 'run-project',
      projectId: project.id,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: RUN_PROJECT_MAX_ATTEMPTS,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
      ...traceContextField(),
    };

    await this.transactionRunner.run(async (tx) => {
      await this.projects.create(project, tx);
      await this.runs.create(run, tx);
      await this.appendEvent(project.id, 'project.created', 'Project and workspace created.', undefined, {}, undefined, tx);
      if (scaffoldFiles.length > 0) {
        await this.appendEvent(
          project.id,
          'scaffold.applied',
          `Applied ${scaffoldFiles.length} scaffold file(s) for stack '${workflow.stack}'.`,
          undefined,
          {},
          undefined,
          tx,
        );
      }
      await this.queue.enqueue(job, tx);
      await this.appendEvent(project.id, 'project.queued', 'Project queued for orchestration.', undefined, {}, undefined, tx);
    });

    // Artifacts are written after the transaction commits: `artifacts.project_id`
    // has a FK to `projects(id)`, and ArtifactStore.put isn't part of the
    // transactional seam (see the design note at the top of this task in the
    // plan) -- the project row must already be visible on its own connection.
    await this.artifacts.put({
      projectId: project.id,
      name: 'prd',
      content: input.prd,
      contentType: 'text/markdown',
      createdBy: 'user',
    });
    if (scaffoldFiles.length > 0) {
      await this.artifacts.put({
        projectId: project.id,
        name: 'scaffold-manifest',
        content: scaffoldFiles.map((file) => file.path),
        contentType: 'application/json',
        createdBy: `scaffold:${workflow.stack}`,
      });
    }

    return project;
  }
```

- [ ] **Step 3: Widen `appendEvent` to accept an optional `tx`**

Replace the `appendEvent` helper (currently lines 1059-1077):

```typescript
  private async appendEvent(
    projectId: string,
    type: ProjectEvent['type'],
    message: string,
    runId?: string,
    data: Record<string, unknown> = {},
    dedupeKey?: string,
    tx?: Tx,
  ): Promise<void> {
    await this.events.append(
      {
        id: this.ids.next(),
        projectId,
        type,
        createdAt: this.clock.now().toISOString(),
        ...(runId ? { runId } : {}),
        message,
        data,
        ...(dedupeKey ? { dedupeKey } : {}),
      },
      tx,
    );
  }
```

(Only the trailing `tx?: Tx` parameter and passing it as the second arg to `this.events.append` are new — every other line is unchanged from today.) Add `type Tx` to the `@agent-foundry/domain` import list from Step 1.

- [ ] **Step 4: Wrap the manual re-run path (`ProjectService.retry`, currently lines 279-325)**

**Important constraint found while planning this task:** `createModelOverride` (lines 92-120) calls `this.requireRun(runId)`, which does `this.runs.get(runId)` and throws `NotFoundError` if the row isn't there yet. That means `runs.create` **must already be committed** before `createModelOverride` runs — it cannot move inside the same uncommitted transaction as the override lookup. So `runs.create` stays exactly where it is today (a standalone, immediately-committed write), and only `projects.update` + `queue.enqueue` + the final `appendEvent` move into the transaction. This closes the dual-write gap the issue actually cares about (project state flips to `queued` and a job is enqueued, atomically) while leaving `runs.create` as a separate write — an orphaned run row with no matching state change or job is a harmless inert row, not silent job loss or double-execution.

Replace the full `retry` method (lines 279-325) with:

```typescript
  async retry(projectId: string, input?: RetryProjectRequest): Promise<Project> {
    const project = await this.requireProject(projectId);
    if (project.status === 'running') return project;
    if (input?.prompt) await this.workspaces.writePrd(projectId, input.prompt);
    const now = this.clock.now().toISOString();
    const runId = this.ids.next();
    const run: WorkflowRun = {
      id: runId,
      projectId,
      workflowId: project.workflowId,
      status: 'queued',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.runs.create(run);
    // Created before the job is enqueued so the override is already visible
    // to the router by the time any worker could possibly claim the job —
    // no race window like there would be creating it after the fact.
    // createModelOverride reads the run back via requireRun, so runs.create
    // above must already be committed -- this call cannot move inside the
    // transaction below.
    if (input?.override) {
      await this.createModelOverride(runId, { ...input.override, scope: { kind: 'run' } });
    }
    const updated: Project = {
      ...project,
      status: 'queued',
      updatedAt: now,
      currentRunId: runId,
    };
    delete updated.currentNodeId;
    delete updated.error;

    const job: QueueJob = {
      id: this.ids.next(),
      type: 'run-project',
      projectId,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: RUN_PROJECT_MAX_ATTEMPTS,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
      ...traceContextField(),
    };

    return this.transactionRunner.run(async (tx) => {
      const saved = await this.projects.update(updated, project.version, tx);
      await this.queue.enqueue(job, tx);
      await this.appendEvent(
        projectId,
        'project.queued',
        'Project manually re-queued.',
        undefined,
        {},
        undefined,
        tx,
      );
      return saved;
    });
  }
```

- [ ] **Step 5: Wrap `requeueProject()` (lines 973-999)**

```typescript
  private async requeueProject(projectId: string, runId: string, jobId?: string): Promise<void> {
    const project = await this.requireProject(projectId);
    const now = this.clock.now().toISOString();
    const job: QueueJob = {
      id: jobId ?? `run-project-${runId}`,
      type: 'run-project',
      projectId,
      workflowId: project.workflowId,
      runId,
      attempts: 0,
      maxAttempts: RUN_PROJECT_MAX_ATTEMPTS,
      createdAt: now,
      availableAt: now,
      leaseEpoch: 0,
      ...traceContextField(),
    };
    await this.transactionRunner.run(async (tx) => {
      if (project.status !== 'queued' || project.currentRunId !== runId) {
        const updated: Project = {
          ...project,
          status: 'queued',
          updatedAt: now,
          currentRunId: runId,
        };
        delete updated.error;
        await this.projects.update(updated, project.version, tx);
      }
      await this.queue.enqueue(job, tx);
    });
  }
```

- [ ] **Step 6: Update the test harness constructor call**

In `packages/orchestrator/src/testing/harness.ts`, add `NoopTransactionRunner` to the imports (near the top, alongside other `@agent-foundry/persistence` imports — check the existing import block for the right specifier), and insert it into the `new ProjectService(...)` call (~line 1329) at the same constructor position as Step 1:

```typescript
const service = new ProjectService(
  stores.projects,
  stores.runs,
  stores.stepRuns,
  stores.stepAttempts,
  stores.approvalRequests,
  stores.approvalDecisions,
  stores.artifacts,
  stores.events,
  queue,
  new NoopTransactionRunner(),
  workflows,
  policies,
  harness,
  router,
  stores.workspaces,
  stores.clock,
  ids,
  stores.modelOverrides,
  undefined,
  opts.generatedProjectRuntime,
);
```

- [ ] **Step 7: Run the existing project-service test suite**

Run: `npx vitest run packages/orchestrator/src/project-service.test.ts`
Expected: mostly PASS. If any test asserts the _order_ of mock calls between `artifacts.put` and `events.append`/`queue.enqueue` (not just that each was called), it will fail because artifacts now happen last. Fix those specific assertions to match the new order (state → event → enqueue → artifacts) — do not weaken assertions that check _values_, only ones that check _call order_ between artifacts and the rest.

- [ ] **Step 8: Run the full orchestrator suite**

Run: `npx vitest run packages/orchestrator/`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `npx tsc -b`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
git add packages/orchestrator/src/project-service.ts packages/orchestrator/src/testing/harness.ts
git commit -m "feat(orchestrator): make project create/re-run/requeue enqueue atomically with state and events"
```

---

## Task 8: Composition wiring — branch the queue on `persistenceMode`

**Files:**

- Modify: `packages/composition/src/runtime.ts` (lines 107, 190, 317-337, 436-484)
- Test: existing `packages/composition/src/runtime.postgres.test.ts` (run to confirm no regression; add one assertion)

**Interfaces:**

- Consumes: `PostgresJobQueue` (Task 4), `PostgresTransactionRunner`/`NoopTransactionRunner` (Tasks 1, 5).
- Produces: `Runtime.queue: JobQueue` (was `FileJobQueue`); `Runtime` now follows `PERSISTENCE_MODE` for the queue too.

- [ ] **Step 1: Loosen the `Runtime.queue` type and widen `createMetadataStores`'s return type**

In `packages/composition/src/runtime.ts`, add `JobQueue` and `TransactionRunner` to the existing `import type { ... } from '@agent-foundry/domain';` block (lines 74-88):

```typescript
import type {
  ApprovalDecisionRepository,
  ApprovalRequestRepository,
  ArtifactStore,
  BlobStore,
  BrowserVerifier,
  ConversationRepository,
  EventStore,
  JobQueue,
  ProjectRepository,
  StepAttemptRepository,
  StepEventRepository,
  StepRunRepository,
  TransactionRunner,
  WorkflowRunRepository,
  GeneratedProjectRuntime,
} from '@agent-foundry/domain';
```

Add `PostgresDb`, `PostgresJobQueue`, `PostgresTransactionRunner`, and `NoopTransactionRunner` to the existing `@agent-foundry/persistence` import (lines 18-56) — insert `PostgresDb` (as a type) and the three classes alphabetically alongside the other `Postgres*`/`File*` names already there, e.g.:

```typescript
  FileJobQueue,
  ...
  NoopTransactionRunner,
  PostgresApprovalDecisionRepository,
  PostgresApprovalRequestRepository,
  PostgresArtifactStore,
  PostgresConversationRepository,
  type PostgresDb,
  PostgresEventStore,
  PostgresJobQueue,
  PostgresProjectRepository,
  PostgresStepAttemptRepository,
  PostgresStepEventRepository,
  PostgresStepRunRepository,
  PostgresTransactionRunner,
  PostgresWorkflowRunRepository,
```

Then change line 107:

```typescript
queue: JobQueue;
```

Change `createMetadataStores`'s return type (lines 439-450) and its two branches (451-484) to also return `sql` and `transactionRunner`:

```typescript
async function createMetadataStores(
  config: RuntimeConfig,
  blobStore: BlobStore,
): Promise<{
  projects: ProjectRepository;
  runs: WorkflowRunRepository;
  stepRuns: StepRunRepository;
  stepAttempts: StepAttemptRepository;
  approvalRequests: ApprovalRequestRepository;
  approvalDecisions: ApprovalDecisionRepository;
  artifacts: ArtifactStore;
  conversations: ConversationRepository;
  events: EventStore;
  stepEvents: StepEventRepository;
  sql?: PostgresDb;
  transactionRunner: TransactionRunner;
}> {
  if (config.persistenceMode === 'file') {
    return {
      projects: new FileProjectRepository(config.dataDir),
      runs: new FileWorkflowRunRepository(config.dataDir),
      stepRuns: new FileStepRunRepository(config.dataDir),
      stepAttempts: new FileStepAttemptRepository(config.dataDir),
      approvalRequests: new FileApprovalRequestRepository(config.dataDir),
      approvalDecisions: new FileApprovalDecisionRepository(config.dataDir),
      artifacts: new FileArtifactStore(config.dataDir, blobStore),
      conversations: new FileConversationRepository(config.dataDir),
      events: new FileEventStore(config.dataDir),
      stepEvents: new FileStepEventRepository(config.dataDir),
      transactionRunner: new NoopTransactionRunner(),
    };
  }
  // loadRuntimeConfig already enforces DATABASE_URL when PERSISTENCE_MODE=postgres; this guards
  // a RuntimeConfig built by hand (e.g. directly in a test) bypassing that check.
  if (!config.databaseUrl) {
    throw new Error('PERSISTENCE_MODE=postgres requires DATABASE_URL');
  }
  const sql = createPostgresClient(config.databaseUrl);
  await assertSchemaCurrent(sql);
  return {
    projects: new PostgresProjectRepository(sql),
    runs: new PostgresWorkflowRunRepository(sql),
    stepRuns: new PostgresStepRunRepository(sql),
    stepAttempts: new PostgresStepAttemptRepository(sql),
    approvalRequests: new PostgresApprovalRequestRepository(sql),
    approvalDecisions: new PostgresApprovalDecisionRepository(sql),
    artifacts: new PostgresArtifactStore(sql),
    conversations: new PostgresConversationRepository(sql),
    events: new PostgresEventStore(sql),
    stepEvents: new PostgresStepEventRepository(sql),
    sql,
    transactionRunner: new PostgresTransactionRunner(sql),
  };
}
```

Update the doc comment directly above the function (currently lines 433-435):

```typescript
/** Metadata stores (and, since issue #55, the queue and transaction seam) swap between file and
 * Postgres backends by PERSISTENCE_MODE; everything else (metrics, quality, previews, model
 * overrides, project versions, workflows, policies, workspaces) stays file-based regardless. */
```

- [ ] **Step 2: Branch the queue construction**

Change the destructuring at line 177-188 to also pull `sql` and `transactionRunner`, and change line 190:

```typescript
const {
  projects,
  runs,
  stepRuns,
  stepAttempts,
  approvalRequests,
  approvalDecisions,
  artifacts,
  conversations,
  events,
  stepEvents,
  sql,
  transactionRunner,
} = await createMetadataStores(config, blobStore);
const knowledgeFiles = new FileKnowledgeFileRepository(config.dataDir);
const queue: JobQueue =
  config.persistenceMode === 'postgres'
    ? new PostgresJobQueue(sql!, { leaseMs: config.queueLeaseMs, clock })
    : new FileJobQueue(config.dataDir, { leaseMs: config.queueLeaseMs, clock });
```

- [ ] **Step 3: Pass `transactionRunner` into `ProjectService`**

At the `new ProjectService(...)` call (lines 317-337), insert `transactionRunner` right after `queue`:

```typescript
const projectService = new ProjectService(
  projects,
  runs,
  stepRuns,
  stepAttempts,
  approvalRequests,
  approvalDecisions,
  artifacts,
  events,
  queue,
  transactionRunner,
  workflows,
  policies,
  harness,
  router,
  workspaces,
  clock,
  ids,
  modelOverrides,
  qualityObservationService,
  generatedProjectRuntime,
);
```

- [ ] **Step 4: Run the composition test suite**

Run: `npx vitest run packages/composition/`
Expected: PASS. `runtime.postgres.test.ts` builds a real Postgres runtime (Docker-gated) — this is where a wiring mistake (e.g. `sql` undefined in postgres mode) would surface as a runtime error, not just a type error.

- [ ] **Step 5: Add one assertion confirming the queue is Postgres-backed in postgres mode**

Read `packages/composition/src/runtime.postgres.test.ts` first to find an existing `createRuntime` call under postgres mode, then add near it:

```typescript
const { PostgresJobQueue } = await import('@agent-foundry/persistence');
expect(runtime.queue).toBeInstanceOf(PostgresJobQueue);
```

- [ ] **Step 6: Run the full test suite**

Run: `npm test`
Expected: PASS across every package

- [ ] **Step 7: Typecheck, lint, format**

Run: `npx tsc -b && npm run lint && npm run format:check`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add packages/composition/src/runtime.ts packages/composition/src/runtime.postgres.test.ts
git commit -m "feat(composition): wire PostgresJobQueue and the transaction seam when PERSISTENCE_MODE=postgres"
```

---

## Task 9: ADR + Definition of Done evidence

**Files:**

- Create: `docs/adr/0035-durable-queue-transactional-seam.md`

**Interfaces:**

- None (documentation only).

- [ ] **Step 1: Write the ADR**

Read one existing ADR first (e.g. `docs/adr/0034-generated-app-supabase-credential-bridge.md`) to match the house format/frontmatter, then write `docs/adr/0035-durable-queue-transactional-seam.md` covering:

1. **Decision:** transactional seam (single `sql.begin` around state + event + enqueue) instead of a transactional outbox table + relay poller, because `project_events` is already the only transport (SSE polls it directly — no external bus to decouple from).
2. **`jobs` table is columns-canonical**, not `data jsonb` + projected columns like every other table — queue rows mutate field-by-field on every claim/heartbeat/nack/reap, so a synced blob would drift.
3. **`Tx` is an opaque brand, threaded not held** — postgres.js `.begin()` only exists on the top-level pooled client (not on `sql.reserve()`), so `PostgresTransactionRunner` is always built from the same client the repos use; a `tx` handle must be passed into every write call, never cached.
4. **`nack({ permanent })` extends the existing method instead of adding `deadLetter()`** — `permanent` is just "skip the attempt-count gate"; a separate method would duplicate nack's fencing-guard and lease-clear logic.
5. **Artifacts are not part of the transactional seam** — `ArtifactStore.put` has an FK to `projects(id)` and self-opens its own transaction; rather than thread `tx` through it, artifact writes simply happen after the state/event/queue transaction commits, when the project row is already visible.
6. **Rollback:** migration v2's `down` drops `jobs`/`job_status`; no data migration needed since the table is new.

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0035-durable-queue-transactional-seam.md
git commit -m "docs(adr): record the durable-queue transactional-seam decision"
```

---

## Task 10: Full verification + evidence for the PR

**Files:** none (verification only)

- [ ] **Step 1: Full check**

Run: `npm run check` (typecheck, lint, format, test, build — confirm the exact script name in `package.json` first; run each individually if `check` doesn't exist as a single script)
Expected: all green

- [ ] **Step 2: End-to-end against real Postgres**

Start a local Postgres (`docker-compose up -d postgres` or equivalent — check `docker-compose.yml`), set `PERSISTENCE_MODE=postgres` and `DATABASE_URL`, run `npm run db:migrate`, start `apps/worker` and `apps/api`, create a project via the API, and confirm:

- a row appears in `jobs` (not on disk)
- the worker claims it (lease/fencing columns populate)
- killing the worker mid-run and waiting past `QUEUE_LEASE_MS` causes the reaper to return the job to `pending`
- a second worker re-claims it with a bumped `fencing_token`
- the dead worker's next heartbeat attempt throws `LeaseLostError` (visible in logs)

Capture this as the PR's evidence (logs/output), per `docs/DEFINITION_OF_DONE.md`.

- [ ] **Step 3: Migration round-trip evidence**

Run: `npx vitest run packages/persistence/src/postgres/migrator.test.ts --reporter=verbose`
Capture output showing v1+v2 apply, `migrateDown(sql, 0)` succeeds, `assertSchemaCurrent` throws when behind, re-`migrateUp` succeeds.

- [ ] **Step 4: Open the PR**

Link issue #55. Include: the atomicity test output (rollback → zero rows across projects/events/jobs), the SKIP LOCKED contention test, the reap+fencing test, the migration round-trip, and the e2e evidence from Step 2. Map each to the issue's five acceptance criteria explicitly in the PR description.

- [ ] **Step 5: Post-PR review pass**

Run `/ponytail:ponytail-review` and `/simplify` against the diff, address findings, push additional commits to the same branch/PR.
