# Issue #232: Supabase Postgres + Storage data-plane validation harness

## Acceptance

| Acceptance intent | Implementation | Evidence |
| --- | --- | --- |
| Opt-in real local Supabase data-plane harness | `packages/composition/src/supabase-data-plane.e2e.test.ts` starts a disposable local Supabase project, runs repository migrations, boots `createRuntime(...)` in `PERSISTENCE_MODE=postgres` + `BLOB_STORE_MODE=s3`, completes a representative workflow run, and round-trips a blob through the S3 endpoint | focused Vitest entrypoint + CI job |
| Hosted/manual smoke path uses the same seam | the same test accepts hosted `DATABASE_URL` + `S3_*` env vars when `SUPABASE_DATA_PLANE_USE_HOSTED=true` | exact hosted command below |
| CI is fail-closed and cleanup-safe | dedicated `supabase-data-plane-e2e` job pins Supabase CLI `2.62.5`, requires Docker up front, and the test always stops the local stack / deletes its bucket | `.github/workflows/ci.yml` |
| Current architectural limit remains explicit | docs state that Postgres-mode artifact blobs still live in `bytea`; this harness proves Postgres metadata + direct S3 blob I/O in one environment, not a new Postgres-artifact-to-S3 architecture | `docs/OPERATIONS.md` and concerns below |

## Exact commands

Local disposable stack (the test creates and destroys its own isolated Supabase workdir and bucket):

```bash
RUN_SUPABASE_DATA_PLANE_E2E=true \
npx vitest run packages/composition/src/supabase-data-plane.e2e.test.ts --pool=threads --maxWorkers=1
```

Hosted throwaway Supabase project (use a direct connection or the session pooler on port `5432`, not the transaction pooler on `6543`, because this harness runs repository migrations before boot):

```bash
DATABASE_URL='postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres' \
S3_ENDPOINT='https://<project-ref>.storage.supabase.co/storage/v1/s3' \
S3_REGION='<region>' \
S3_ACCESS_KEY_ID='<storage-access-key-id>' \
S3_SECRET_ACCESS_KEY='<storage-secret-access-key>' \
SUPABASE_DATA_PLANE_USE_HOSTED=true \
RUN_SUPABASE_DATA_PLANE_E2E=true \
npx vitest run packages/composition/src/supabase-data-plane.e2e.test.ts --pool=threads --maxWorkers=1
```

## Current result limits

- This local workstation has no Docker daemon and no hosted throwaway Supabase credentials, so this issue's real-stack harness was not executed here; only the deterministic support tests and the skipped entrypoint load were run locally.
- The new CI job is the authoritative automated path for the disposable local stack.
- Hosted smoke is still manual/opt-in. Do not claim hosted success unless the exact hosted command above is run against a real throwaway project.
- The harness intentionally does **not** implement the separate architectural follow-up where Postgres-mode artifact bytes move out of `bytea` into object storage. Today, in `PERSISTENCE_MODE=postgres`, artifact blobs still live in Postgres; this test proves the production runtime can use Postgres metadata while also talking to Supabase's S3 endpoint in the same validated environment.
