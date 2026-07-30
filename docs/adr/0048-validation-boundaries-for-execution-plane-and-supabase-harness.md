# ADR 0048: Validation boundaries for the local execution plane and the opt-in Supabase data-plane harness

- Status: Accepted
- Date: 2026-07-30
- Owners: Core
- Builds on ADR 0026 (Postgres metadata persistence), ADR 0025 (object storage), and ADR 0045 (deterministic verification)

## Context

This branch adds two validation-facing changes that outlive a pull request:

1. Issue #210 hardens the **local execution-plane boundary**. `LocalExecutionPlane.submit(...)`
   now validates its request/result contract at the boundary and supports observable local
   `status(...)` / `cancel(...)` behavior for in-flight work.
2. Issue #232 adds an **opt-in Supabase Postgres + S3 acceptance harness**. It creates a disposable
   local Supabase project or accepts explicit hosted `DATABASE_URL` + `S3_*` inputs, runs the
   repository migrations, boots the production composition in `PERSISTENCE_MODE=postgres` +
   `BLOB_STORE_MODE=s3`, and proves a representative workflow run plus a direct `BlobStore`
   round-trip against the same environment.

Both changes touch architectural/public-contract territory under `CONTRIBUTING.md`'s "Before
starting" rule 3: execution-plane boundary behavior is a runtime contract, and the Supabase harness
codifies persistence/provider validation policy.

The branch also has explicit non-goals that must stay true:

- no false local or hosted smoke claim when Docker or throwaway hosted Supabase credentials are
  unavailable;
- no widening into the separate architectural follow-up where `PostgresArtifactStore` moves `bytea`
  artifact bytes to object storage.

## Decision

- The local execution plane treats malformed execution-plane requests/results as boundary violations,
  not normal failed executions. They are rejected at the schema boundary instead of being flattened
  into provider-style failure payloads.
- Local execution-plane observability is explicit and in-memory only: `status(executionId)` reports
  running/completed/failed/cancelled for in-flight local work, and `cancel(executionId)` is
  best-effort for that same local scope.
- The Supabase data-plane harness remains **opt-in** and env-gated. It is not part of the default
  local fast loop, and it lives in the slow bucket because it binds ports, starts/stops processes,
  and can require Docker/Supabase.
- The harness is allowed to validate exactly two behaviors together:
  - Postgres-backed composition boot/migration/readiness/workflow completion.
  - Direct `runtime.blobStore` S3-compatible round-trip in the same validated environment.
- The harness must not overstate that coverage. In `PERSISTENCE_MODE=postgres`, artifact bytes owned
  by `PostgresArtifactStore` still live in Postgres `bytea`; this ADR does not reinterpret the
  harness as proof of a Postgres-artifacts-to-S3 migration.
- Cleanup is fail-visible. The harness still attempts object deletion, bucket deletion, local
  `supabase stop`, and temp-path removal in teardown, but any failure is aggregated and fails the
  suite instead of being swallowed as an apparent success.
- Hosted Supabase validation requires an explicit migration-capable connection string: direct
  Postgres or the session pooler on `5432`. The transaction pooler on `6543` is rejected for this
  harness because repository migrations depend on a session-scoped advisory lock.

## Alternatives considered

- **Rely on existing unit/integration coverage and docs alone.** Rejected because neither proves the
  production composition can boot against a Supabase-like Postgres + S3 environment.
- **Claim the harness proves Postgres artifacts now flow through S3.** Rejected because it is false:
  the harness exercises direct `BlobStore` I/O, while `PostgresArtifactStore` artifacts still live in
  `bytea`.
- **Make cleanup best-effort and silent.** Rejected because leaked buckets/containers/temp dirs are
  operationally significant and must not look like green validation.
- **Run the Supabase harness in the fast loop.** Rejected because AGENTS.md classifies port-binding,
  process-spawning, container-driven tests into the slow bucket.

## Consequences

- The execution-plane contract is stricter: malformed boundary payloads now fail immediately and are
  easier to diagnose than if they were remapped into ordinary provider failures.
- The Supabase harness is honest about host capability. A local environment without Docker, or a
  branch without throwaway hosted credentials, can still ship deterministic support/test evidence
  without pretending the real stack was exercised there.
- The slow-bucket partition must continue to classify env-gated e2e files like
  `supabase-data-plane.e2e.test.ts` outside the parallel fast loop.
- Docs and evidence have to distinguish:
  - direct blob-store S3 validation;
  - Postgres-backed composition validation;
  - the still-open architectural gap for Postgres artifact bytes.

## Validation and rollback

- Validation for this branch is:
  - focused execution-plane tests;
  - focused Supabase harness support tests;
  - env-gated Supabase harness entrypoint;
  - root typecheck / config checks as appropriate;
  - partition evidence that `test:unit:fast` + `test:unit:slow` still equals the repository-wide
    file count from `npx vitest list --filesOnly`.
- Local workstation limits remain explicit. If Docker or hosted credentials are missing, record the
  path as unavailable rather than green.
- Rollback is straightforward:
  - revert the local execution-plane boundary/status/cancel additions if the contract should shrink;
  - remove the opt-in Supabase harness and its CI job if the validation seam is replaced;
  - do **not** treat rollback as data migration, because this ADR does not move persisted artifact
    bytes between Postgres and object storage in the first place.
