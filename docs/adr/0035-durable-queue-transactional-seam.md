# ADR 0035: Durable queue transactional seam

- Status: Accepted
- Date: 2026-07-24
- Owners: Platform

## Context

Issue #55 adds a Postgres-backed job queue to replace the pre-existing file-backed queue, paired with a
new `TransactionRunner` domain port that allows Project/Run creation, event append, and job enqueue to
commit atomically in a single database transaction. This ADR records six architectural decisions that
shaped how the transactional seam works and what it encompasses.

Background: the platform workflow is: orchestrator creates a Project, appends an event (ProjectCreated),
enqueues a job (InitializeJob), and expects all three to be visible together when the worker wakes up.
Without transactions, a crash between any two writes leaves the system in an inconsistent state.
The file-backed queue had no transaction mechanism at all; Postgres enables one.

## Decision

### 1. Transactional seam, not outbox table

The implementation uses a single `sql.begin()` transaction around Project/Run creation, event append,
and job enqueue — one atomic commit per orchestrator operation. We rejected a transactional outbox
pattern (event/job in one table, relay poller scanning and forwarding to a separate queue).

**Rationale:** The orchestrator already has exactly one transport for project events: `project_events`
table, polled by SSE subscribers (`/projects/{id}/events`). An outbox pattern would add a second
transport and a relay poller to fan events into it, purely for the sake of symmetry with systems
that decouple from an external event bus. Since there is no external bus — events never leave the
platform's database — the outbox adds machinery without decoupling benefit. The transactional seam is
simpler: one transaction, one commit, one transport, and every event is immediately visible to
subscribers without a relay step.

### 2. `jobs` table is columns-canonical, not data jsonb

Every other domain table in the persistence layer (`projects`, `workflow_runs`, `step_runs`, etc.)
follows a pattern: a structured `data jsonb` column holds the full domain shape, with a few frequently
queried fields promoted to dedicated columns and kept in sync via triggers or application code.
The `jobs` table breaks this pattern: it is entirely columns-canonical. The `QueueJob` structure is
reconstructed from individual columns (`type`, `project_id`, `run_id`, `status`, `attempts`, etc.),
never from a blob.

**Rationale:** The jobs table is mutated on every state change: `claim` updates eight fields
(status, lease_epoch, worker_id, fencing_token, heartbeat_at, expires_at, etc.), `heartbeat` updates
three, `nack` updates six, and `reapExpired` updates five. A synced `data jsonb` blob would drift
immediately — the application would have to reconstruct it from columns anyway (or risk parsing
stale JSON), negating the blob's value. Columns-canonical sidesteps this drift by making columns the
single source of truth. The reconstructed `QueueJob` is built on the fly in `toQueueJob()`, paying a
small cost per read to avoid the larger cost of blob drift and consistency paranoia.

### 3. `Tx` is an opaque brand, threaded, never held

The `Tx` type is defined as a unique-symbol brand: `type Tx = { readonly __tx: unique symbol }`.
It is never held in an instance variable, never cached, never returned from a function to be used
later — it is threaded as a parameter through every write method (`create()`, `append()`, `enqueue()`)
that needs to join the transaction, and discarded after the transaction completes.

**Rationale:** postgres.js's `.begin()` returns an `Sql` client bound to that specific transaction.
`.begin()` only exists on the top-level pooled client; calling it on an `sql.reserve()` connection
(a reserved connection from the pool, used for explicit connection management) throws an error.
This means `PostgresTransactionRunner` must always be instantiated with the same `Sql` client that
all repositories use, and the `tx` handle must be passed into every write call so the repository can
cast it back to that `Sql` client (`const db = (tx as unknown as PostgresDb | undefined) ?? this.sql`).
Threading prevents any abstraction boundary that might try to hold a transaction across multiple
call sites or lose it in a cache; the parameter is temporary, local to the callback, and cannot
outlive the `begin()` scope.

### 4. `nack({ permanent })` option, not separate `deadLetter()` method

The `nack()` method takes an optional `{ permanent?: boolean }` field. When `permanent === true`,
the job transitions directly to `'failed'` status, skipping the attempt-count gate. We rejected
adding a separate `deadLetter()` method alongside `nack()`.

**Rationale:** `nack()` and a hypothetical `deadLetter()` would both:

- check the fencing token against the current lease
- clear the lease (worker_id, fencing_token, heartbeat_at, expires_at)
- update attempts and last_error

Duplicating this guard logic into two methods risks one being called in a context where the other
should have been, or an update to one not reaching the other. A single `nack()` method with a
`permanent` flag lets the method internals (fencing guard, lease clear) live in one place and be
reviewed once. The flag is orthogonal to the existing attempt-count logic — it just changes the
branch: `const dead = options?.permanent === true || attempts >= job.maxAttempts`.

### 5. Artifacts are not part of the transactional seam

The `ArtifactStore.put()` method (and `putBlob()`) are deliberately kept outside the transactional
seam: the orchestrator calls `transactionRunner.run(async (tx) => { ... })` to write state/event/job,
then, after it commits, calls `artifacts.put()`, which self-opens its own transaction and completes
independently.

**Rationale:** `PostgresArtifactStore.put()`/`putBlob()` each acquire a per-project advisory lock
(`acquireScopeLock`, a `pg_advisory_xact_lock` scoped to the project), held for the lifetime of
`put()`'s own `sql.begin()` transaction. Threading the outer `tx` into `put()` so it joined the
state/event/job transaction would hold that advisory lock for the whole outer transaction's
duration instead of just the artifact insert, widening the lock-contention window for every other
write targeting the same project. That is the load-bearing reason to keep artifacts out of the
seam — not the foreign key. (The FK to `projects(id)` is not actually a barrier to threading `tx`
through: a same-transaction insert can reference a row inserted earlier in that same,
still-uncommitted transaction — Postgres only requires cross-transaction visibility to wait for a
commit, and threading `tx` would make it a same-transaction insert. The FK only forces "write after
commit" given the separate-transaction design chosen here for the lock-scope reason above.)
Decoupling the two also keeps error handling simple: artifact failures do not roll back the
state/event/job commit, and the caller can handle them independently. (`putBlob()`'s stream
accumulation currently happens before its `sql.begin()` call, so today's artifact transaction is
two short inserts, not a blob-upload-duration span; a future move to true streaming, as issue #54
considers, would only strengthen the case for keeping artifacts out of the seam.)

### 6. Rollback: migration v2's `down` drops tables

The migration that introduces the jobs table and its enum type (`job_status`) includes a `down`
migration that drops both. There is no data migration needed because the table is new — no existing
jobs are carried over from the file-backed queue. Reverting the migration simply removes the
infrastructure; any in-flight jobs at the time of rollback are lost, which is acceptable for a
Personal-v1 local system with no durability SLA before the migration.

**Rationale:** Job data is not persisted in any backup or snapshot — the jobs table exists only for
in-process coordination, and every job is enqueued fresh from the orchestrator on each workflow run.
Rolling back the Postgres persistence mode (reverting to `PERSISTENCE_MODE=file`) would switch back
to the file-backed queue, and any jobs queued under Postgres would no longer be visible to file-based
workers anyway. The `down` migration is purely mechanical: remove the table, remove the enum type,
no data recovery needed.

## Alternatives considered

- **Outbox table + relay**: discussed above (Decision 1). Rejected for lack of external bus decoupling.
- **Single `data jsonb` column for jobs**: rejected due to field-by-field mutation patterns (Decision 2).
- **Hold and cache `Tx` in a context variable or instance field**: rejected due to postgres.js's
  `.begin()` limitation — transactions can only exist on the top-level pooled client, and threading
  as a parameter is the only pattern that fits that constraint (Decision 3).
- **Separate `deadLetter(job, workerId, reason)` method**: rejected to avoid duplicating fencing
  guard and lease-clear logic across two methods (Decision 4).
- **Thread `tx` through artifact writes**: rejected because it would widen the per-project advisory
  lock `put()`/`putBlob()` already hold to the whole outer transaction's duration, not because the
  foreign key to `projects(id)` requires a commit — same-transaction inserts don't need one (Decision 5).
- **Data migration or job replay on rollback**: rejected because jobs are ephemeral — they are
  enqueued fresh from the orchestrator each run, and rolling back to file-based mode would make
  Postgres-queued jobs invisible anyway (Decision 6).

## Consequences

The `TransactionRunner` port is now a first-class domain contract: every Project, WorkflowRun, and
ProjectEvent create call accepts an optional `tx?: Tx` parameter, and orchestrator operations
(`submitRun`, `beginWorkflowRun`, etc.) must use `transactionRunner.run()` to ensure Project,
Event, and Job are created in a single atomic commit. Code that calls these methods without a
transaction runner (e.g. file-backed mode) passes `undefined` for `tx`, which each repository
interprets as "use the default non-transactional SQL client" — the parameters are backward-compatible
with the file-backed queue, which has no transactions at all.

The jobs table structure is rigid: new fields require alter-table, not a schema migration on a data
blob. This is acceptable for v1 (the table is new and rarely changes) and has a clear upgrade path:
if a field is needed in the future, add it as a column and update the `toQueueJob()` reconstruction
logic.

Artifact writes are decoupled from state commits, which means an artifact failure (storage quota
exceeded, disk full, permission error) does not roll back the orchestrator's state/event/job transaction.
The orchestrator must handle artifact failures explicitly (log, alert, re-enqueue the job if needed);
this is a trade-off against end-to-end atomicity, justified by the separation of concerns
(long-lived I/O outside transaction scope) and the reality that artifact availability is not part of
workflow correctness — a missing artifact is a UX issue, not a data consistency issue.

The `nack({ permanent: true })` option is new API surface, but it is orthogonal to existing
`nack()` callers; all existing code continues to work, and only callers that explicitly detect a
permanent error (e.g. validation failure on a payload) need to pass the flag.

## Validation and rollback

The transactional seam is covered by:

- `packages/persistence/src/postgres/job-queue.test.ts`: claim, heartbeat, ack, nack, and
  reapExpired behavior with fencing token validation and lease mutation.
- `packages/persistence/src/postgres/transaction-runner.test.ts`: `run()` wraps a callback in
  `sql.begin()` and returns the callback's result.
- `packages/composition/src/runtime.test.ts`: when `PERSISTENCE_MODE=postgres`, the composition
  layer wires `PostgresTransactionRunner` and `PostgresJobQueue` together and verifies they are
  used in the orchestrator's submission paths.
- `packages/orchestrator/src/execution-service.test.ts`: orchestrator operations (`submitRun`,
  `beginWorkflowRun`) invoke the transaction runner and verify Project, Run, Event, and Job are
  all created in a single atomic write.
- End-to-end: `apps/api/e2e/durable-queue.spec.ts` (Postgres-gated, `durable-queue-e2e` CI job)
  boots a real Postgres database, enqueues jobs under a transaction, crashes a worker mid-claim,
  verifies reapExpired recovers the job, and drives a full job lifecycle (claim → heartbeat → ack).

Rollback: revert the migration (drop jobs table and job_status enum) and remove the `tx` parameters
from ProjectRepository, WorkflowRunRepository, and EventStore create/append calls. The
TransactionRunner port can remain (file-backed mode uses `NoopTransactionRunner`), or be removed
entirely if it is not used by any other domain. Reverting to file-backed queue simply means
no cross-repository transactions at all, which is the pre-existing baseline.
