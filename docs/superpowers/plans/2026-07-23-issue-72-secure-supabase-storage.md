# Issue 72 Secure Supabase Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision one private, policy-limited Supabase Storage bucket in every generated project's isolated local stack, with owner RLS, signed access, quarantine scanning hooks, and retention-safe export/cleanup.

**Architecture:** Extend the existing `SupabaseGeneratedProjectRuntime.initialize()` path instead of adding another runtime or storage adapter. A small pure platform module adds the native Supabase bucket block and a forward-only SQL migration; generated apps use the already-mandated `@supabase/supabase-js` client and the generated RPC/RLS contract. Unit tests verify exact generated artifacts and commands, while one opt-in real-Supabase test proves the security behavior against Docker in CI.

**Tech Stack:** TypeScript, Vitest, Supabase CLI 2.62.5, native Supabase Storage config, Postgres RLS/RPC, GitHub Actions.

## Global Constraints

- Work only on `agent/issue-72-secure-storage` in `/Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-72-secure-storage`; never write implementation code to `main`.
- Reuse `SupabaseGeneratedProjectRuntime`, the isolated workdir/Compose stack from issue #69, and forward-only migrations from issue #70.
- Do not add a second generated-project runtime, control-plane `BlobStore` adapter, upload proxy, public bucket, malware engine, or npm dependency.
- Bucket name is exactly `uploads`, private, and scoped by the already-isolated Supabase Compose project/environment.
- Per-bucket limit is exactly `10MiB`; allowed MIME types are exactly `image/png`, `image/jpeg`, and `application/pdf`.
- Object names are exactly `<auth.uid()>/<opaque file name>`; owner checks use the authenticated JWT subject.
- Scan states are exactly `quarantine`, `clean`, and `rejected`; every prepared upload starts in `quarantine`.
- Signed upload/download URLs are bearer credentials: never persist or log their value; download signing requires `storage.objects` `SELECT`, which remains denied until scan state is `clean`.
- The scanner boundary is a service-role-only queue/completion contract. Implement no antivirus engine; issue #73 owns the function runtime.
- Export is two-phase: create/copy a manifest, then confirm export. Automated cleanup may select only expired rejected objects or expired clean objects with confirmed export, deletes bytes through the Storage API/CLI first, and removes metadata only after byte deletion succeeds.
- Treat the Supabase `storage` schema as read-only except for supported RLS policies; never SQL-delete `storage.objects`.
- Keep `ANON_KEY`, `SERVICE_ROLE_KEY`, JWTs, database URLs, and signed URLs transient and absent from metadata, logs, fixtures, screenshots, and evidence.
- Every production behavior follows TDD: write a focused failing test, observe the expected failure, write minimum code, observe green, then refactor.
- Run `npm run graphify:refresh` after code changes and `graphify update .` after documentation changes; never commit `graphify-out/`.

---

## File Structure

- Create `packages/platform/src/supabase-storage.ts`: pure constants plus deterministic config and SQL generation.
- Create `packages/platform/src/supabase-storage.test.ts`: unit contract for bucket policy, owner RLS, quarantine, signed-read gate, export, and cleanup.
- Create `packages/platform/src/supabase-storage.e2e.test.ts`: opt-in real local Supabase security proof.
- Modify `packages/platform/src/supabase-runtime.ts`: write the generated migration during configuration and seed the bucket after start.
- Modify `packages/platform/src/supabase-runtime.test.ts`: prove runtime integration and exact CLI command order.
- Modify `packages/platform/src/index.ts`: export the storage artifact module.
- Modify `.github/workflows/ci.yml`: add a pinned real-Supabase storage E2E job.
- Modify `harness/stacks/nextjs.md`: generated-app usage rules.
- Create `docs/adr/0032-secure-generated-project-storage.md`: durable decision, security, migration, and rollback.
- Modify `docs/adr/README.md`, `docs/OPERATIONS.md`, and `docs/VALIDATION.md`: operator and validation contract.
- Create `docs/evidence/issue-72-secure-storage.md`: acceptance mapping and final command results.

### Task 1: Generate the private bucket and security schema

**Files:**

- Create: `packages/platform/src/supabase-storage.ts`
- Create: `packages/platform/src/supabase-storage.test.ts`
- Modify: `packages/platform/src/index.ts`

**Interfaces:**

- Consumes: validated project isolation supplied by `SupabaseGeneratedProjectRuntime`.
- Produces:
  - `GENERATED_STORAGE_BUCKET: "uploads"`
  - `GENERATED_STORAGE_MAX_BYTES: 10485760`
  - `GENERATED_STORAGE_MIGRATION: "00000000000000_agent_foundry_storage.sql"`
  - `configureGeneratedStorage(config: string): string`
  - `generatedStorageMigration(): string`

- [ ] **Step 1: Write the failing config and SQL contract tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  GENERATED_STORAGE_BUCKET,
  GENERATED_STORAGE_MAX_BYTES,
  GENERATED_STORAGE_MIGRATION,
  configureGeneratedStorage,
  generatedStorageMigration,
} from './supabase-storage.js';

describe('generated Supabase Storage artifacts', () => {
  it('adds one private uploads bucket with exact size and MIME limits', () => {
    const configured = configureGeneratedStorage('project_id = "supabase_project-a"\n');

    expect(GENERATED_STORAGE_BUCKET).toBe('uploads');
    expect(GENERATED_STORAGE_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(GENERATED_STORAGE_MIGRATION).toBe('00000000000000_agent_foundry_storage.sql');
    expect(configured).toContain('[storage.buckets.uploads]');
    expect(configured).toContain('public = false');
    expect(configured).toContain('file_size_limit = "10MiB"');
    expect(configured).toContain(
      'allowed_mime_types = ["image/png", "image/jpeg", "application/pdf"]',
    );
    expect(configureGeneratedStorage(configured)).toBe(configured);
  });

  it('generates owner RLS, quarantine, signed-read, export, and cleanup contracts', () => {
    const sql = generatedStorageMigration();

    for (const required of [
      "create type public.storage_scan_status as enum ('quarantine', 'clean', 'rejected')",
      'create table public.storage_uploads',
      "scan_status public.storage_scan_status not null default 'quarantine'",
      'retain_until timestamptz not null',
      'exported_at timestamptz',
      'alter table public.storage_uploads enable row level security',
      'create function public.prepare_storage_upload',
      "(storage.foldername(name))[1] = (select auth.jwt()->>'sub')",
      'create policy storage_upload_insert',
      'create policy storage_clean_owner_select',
      "scan_status = 'clean'",
      'create view public.storage_scan_queue',
      'create function public.complete_storage_scan',
      'create function public.storage_export_manifest',
      'create function public.confirm_storage_export',
      'create function public.storage_cleanup_candidates',
      'create function public.confirm_storage_cleanup',
      'grant execute on function public.complete_storage_scan',
      'to service_role',
    ]) {
      expect(sql.toLowerCase()).toContain(required.toLowerCase());
    }
    expect(sql).not.toMatch(/delete\s+from\s+storage\.objects/i);
    expect(sql).not.toMatch(/public\s*=\s*true/i);
  });
});
```

- [ ] **Step 2: Run the tests and observe the missing-module failure**

Run:

```bash
npx vitest run packages/platform/src/supabase-storage.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because `./supabase-storage.js` does not exist.

- [ ] **Step 3: Implement the smallest pure artifact generator**

Implement the exact exports above. `configureGeneratedStorage` appends this block once and preserves the original config byte-for-byte before the appended newline:

```toml
[storage.buckets.uploads]
public = false
file_size_limit = "10MiB"
allowed_mime_types = ["image/png", "image/jpeg", "application/pdf"]
```

`generatedStorageMigration()` must return one forward-only migration with these concrete behaviors:

```sql
create type public.storage_scan_status as enum ('quarantine', 'clean', 'rejected');

create table public.storage_uploads (
  object_name text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  media_type text not null check (
    media_type in ('image/png', 'image/jpeg', 'application/pdf')
  ),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  scan_status public.storage_scan_status not null default 'quarantine',
  retain_until timestamptz not null,
  exported_at timestamptz,
  created_at timestamptz not null default now(),
  check (object_name like owner_id::text || '/%')
);

alter table public.storage_uploads enable row level security;

create policy storage_upload_owner_select
  on public.storage_uploads for select to authenticated
  using (owner_id = (select auth.uid()));

create policy storage_upload_owner_insert
  on public.storage_uploads for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and object_name like (select auth.uid())::text || '/%'
  );

create policy storage_upload_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'uploads'
    and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
    and exists (
      select 1
      from public.storage_uploads upload
      where upload.object_name = name
        and upload.owner_id = (select auth.uid())
        and upload.scan_status = 'quarantine'
    )
  );

create policy storage_clean_owner_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'uploads'
    and owner_id = (select auth.jwt()->>'sub')
    and exists (
      select 1
      from public.storage_uploads upload
      where upload.object_name = name
        and upload.owner_id = (select auth.uid())
        and upload.scan_status = 'clean'
    )
  );
```

Add these functions without dynamic SQL:

- `prepare_storage_upload(p_object_name text, p_media_type text, p_size_bytes bigint, p_retention_seconds integer default 2592000)` inserts `owner_id = auth.uid()`, validates `1 <= retention <= 31536000`, and returns the inserted row.
- `storage_scan_queue` exposes only quarantined rows and grants `SELECT` only to `service_role`.
- `complete_storage_scan(p_object_name text, p_status storage_scan_status)` accepts only `clean` or `rejected`, grants execute only to `service_role`, and updates exactly one row.
- `storage_export_manifest()` returns the authenticated owner's clean, unexpired rows without mutating them.
- `confirm_storage_export(p_object_names text[])` sets `exported_at = now()` only for the authenticated owner's clean rows.
- `storage_cleanup_candidates()` returns only `retain_until <= now()` rows where `scan_status = 'rejected' OR exported_at IS NOT NULL`, grants execute only to `service_role`, and performs no deletion.
- `confirm_storage_cleanup(p_object_name text)` deletes only the metadata row after the caller has deleted bytes through Storage API/CLI; grant execute only to `service_role`.

Every `SECURITY DEFINER` function must set `search_path = ''`, revoke execution from `public`, `anon`, and `authenticated`, and grant only the stated role.

- [ ] **Step 4: Run focused tests and format**

Run:

```bash
npx vitest run packages/platform/src/supabase-storage.test.ts --pool=threads --maxWorkers=1
npx prettier --check packages/platform/src/supabase-storage.ts packages/platform/src/supabase-storage.test.ts packages/platform/src/index.ts
```

Expected: both commands PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/platform/src/supabase-storage.ts packages/platform/src/supabase-storage.test.ts packages/platform/src/index.ts
git commit -m "feat(platform): generate secure Supabase storage policy"
```

### Task 2: Provision storage during runtime initialization

**Files:**

- Modify: `packages/platform/src/supabase-runtime.ts`
- Modify: `packages/platform/src/supabase-runtime.test.ts`

**Interfaces:**

- Consumes: `configureGeneratedStorage`, `generatedStorageMigration`, and `GENERATED_STORAGE_MIGRATION` from Task 1.
- Produces: `initialize()` writes the migration before `supabase start`, then invokes `supabase seed buckets` after start.

- [ ] **Step 1: Write the failing runtime integration test**

Extend the existing initialization test:

```ts
const firstConfig = await readFile(join(first.workdir, 'supabase', 'config.toml'), 'utf8');
const firstMigration = await readFile(
  join(first.workdir, 'supabase', 'migrations', '00000000000000_agent_foundry_storage.sql'),
  'utf8',
);

expect(firstConfig).toContain('[storage.buckets.uploads]');
expect(firstConfig).toContain('public = false');
expect(firstMigration).toContain('create policy storage_upload_insert');
expect(firstMigration).toContain('create policy storage_clean_owner_select');
expect(command.mock.calls).toContainEqual(['seed', 'buckets', '--workdir', first.workdir]);
```

Update the controlled `statusCommand` fixture so `init` creates `supabase/migrations/` as well as `config.toml`.

- [ ] **Step 2: Run the test and observe the missing artifacts**

Run:

```bash
npx vitest run packages/platform/src/supabase-runtime.test.ts --pool=threads --maxWorkers=1
```

Expected: FAIL because the migration and bucket-seed command do not exist.

- [ ] **Step 3: Wire the existing runtime**

In `configureProject`, transform the configured TOML with `configureGeneratedStorage`, create `supabase/migrations/`, and atomically write `generatedStorageMigration()` at `GENERATED_STORAGE_MIGRATION`.

Immediately after the existing successful `start` command in `initialize()`, execute:

```ts
await this.#execute('initialize', 'seed', 'buckets', '--workdir', workdir);
```

Do not persist CLI output or add storage credentials to `AppEnvironment`.

- [ ] **Step 4: Run platform regression tests**

Run:

```bash
npx vitest run packages/platform/src/supabase-storage.test.ts packages/platform/src/supabase-runtime.test.ts --pool=threads --maxWorkers=1
npm run typecheck --workspace @agent-foundry/platform
npm run build --workspace @agent-foundry/platform
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/platform/src/supabase-runtime.ts packages/platform/src/supabase-runtime.test.ts
git commit -m "feat(platform): provision storage with generated runtimes"
```

### Task 3: Prove RLS, limits, quarantine, signed access, export, and cleanup on real Supabase

**Files:**

- Create: `packages/platform/src/supabase-storage.e2e.test.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: real `SupabaseGeneratedProjectRuntime`, native Auth/Storage/PostgREST HTTP APIs, and Task 1's schema.
- Produces: one opt-in test enabled by `RUN_SUPABASE_STORAGE_E2E=true`; no production API.

- [ ] **Step 1: Write the opt-in failing real-stack test**

The test must:

1. Create a temporary `dataDir`.
2. Initialize `project-a` using the default real CLI command.
3. Read transient `API_URL`, `ANON_KEY`, and `SERVICE_ROLE_KEY` from `supabase status --output json --workdir <workdir>` without logging them.
4. Create authenticated users A and B through local Auth.
5. Call `prepare_storage_upload` as A for `${userA.id}/allowed.png`, `image/png`, and its exact byte count.
6. Upload through Storage as A.
7. Assert signed download creation is denied while quarantined.
8. Complete scan as `service_role`, assert A can create/fetch a 60-second signed download, and assert B cannot sign/read it.
9. Assert a `10MiB + 1` upload is rejected.
10. Assert a `text/plain` upload is rejected.
11. Assert `storage_export_manifest` returns the clean object, copy/fetch the bytes, call `confirm_storage_export`, expire the row with service role, and assert `storage_cleanup_candidates` returns it.
12. Delete bytes through Storage as service role, call `confirm_storage_cleanup`, and assert metadata is gone.
13. Stop/cleanup the real stack in `finally`.

Run:

```bash
RUN_SUPABASE_STORAGE_E2E=true npx vitest run packages/platform/src/supabase-storage.e2e.test.ts --pool=threads --maxWorkers=1
```

Expected before Task 1/2 implementation: FAIL during bucket/schema use. On a host without Docker, record that local environmental limitation; do not convert an explicitly enabled run into a skip.

- [ ] **Step 2: Add the pinned CI job**

Add a separate `storage-e2e` job after `preflight`, with Node setup, `npm ci`, and:

```yaml
- uses: supabase/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520 # v3
  with:
    version: 2.62.5
- run: RUN_SUPABASE_STORAGE_E2E=true npx vitest run packages/platform/src/supabase-storage.e2e.test.ts --pool=threads --maxWorkers=1
```

Use `ubuntu-latest` and `timeout-minutes: 15`. Do not expose secrets: the local stack supplies temporary keys.

- [ ] **Step 3: Verify the opt-in boundary locally**

Run:

```bash
npx vitest run packages/platform/src/supabase-storage.e2e.test.ts --pool=threads --maxWorkers=1
npm run github-config:check
```

Expected: the first command reports the suite skipped because opt-in is absent; GitHub config PASS. The enabled command must run later in GitHub CI and cannot be claimed locally if Docker is unavailable.

- [ ] **Step 4: Commit**

```bash
git add packages/platform/src/supabase-storage.e2e.test.ts .github/workflows/ci.yml
git commit -m "test(platform): prove secure storage against Supabase"
```

### Task 4: Publish the generated-app, operations, and rollback contract

**Files:**

- Modify: `harness/stacks/nextjs.md`
- Create: `docs/adr/0032-secure-generated-project-storage.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/VALIDATION.md`
- Create: `docs/evidence/issue-72-secure-storage.md`

**Interfaces:**

- Consumes: exact constants, RPC names, state names, and commands from Tasks 1-3.
- Produces: operator/generator guidance and issue evidence.

- [ ] **Step 1: Add the generated-app rules**

Add these rules to `harness/stacks/nextjs.md`:

- Use only private bucket `uploads`.
- Prepare metadata with `prepare_storage_upload`, then use the authenticated Supabase client to create/use a signed upload URL for `<user.id>/<opaque-name>`.
- Never use `getPublicUrl`, service-role keys in browser code, or S3 credentials.
- Treat signed URLs as short-lived bearer credentials; do not log/persist them.
- Render/download only after `scan_status = clean`; `quarantine` and `rejected` are unavailable.
- Scanner workers use the service-role-only queue/completion contract; no browser may mark scan results.
- Export bytes first, then call `confirm_storage_export`.
- Cleanup only `storage_cleanup_candidates`, deletes bytes through Storage API first, then calls `confirm_storage_cleanup`.

- [ ] **Step 2: Write ADR 0032 and update the ADR index**

The ADR must state:

- #69 provides stack isolation; a fixed `uploads` bucket is still project-scoped.
- Bucket limits are native config, ownership/download are RLS, and signed URLs remain bearer credentials.
- Public metadata records quarantine/retention; no mutations or SQL deletes alter Storage-owned metadata.
- The scanner is a hook, not an AV implementation.
- Export confirmation prevents cleanup after an incomplete copy.
- Rollback removes runtime generation only for new projects; existing forward-applied schema stays and must be rolled forward or explicitly removed after exported bytes are preserved.

- [ ] **Step 3: Add operations, validation, and evidence**

Document exact upload, scan, export, cleanup, and rollback flows. In `docs/evidence/issue-72-secure-storage.md`, add this acceptance table:

| Acceptance intent                 | Implementation                                                                                       | Evidence                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Compose/environment scoped bucket | private `uploads` bucket inside #69 isolated workdir/stack                                           | runtime two-project isolation + config test |
| Size/type policy and signed URL   | native 10MiB/MIME bucket limits; signed upload/download                                              | real storage E2E                            |
| Ownership and authorization       | owner path plus metadata and `storage.objects` RLS                                                   | real A/B denial E2E                         |
| Malware hook and quarantine       | service-role queue/completion; clean-only read policy                                                | unit SQL contract + real quarantine denial  |
| Retention export and cleanup      | manifest, explicit export confirmation, expired-candidate selection, API byte delete before metadata | real lifecycle E2E                          |

Leave final command counts/results blank only until verification runs; fill them before commit.

- [ ] **Step 4: Validate documentation and refresh Graphify**

Run:

```bash
npx prettier --check harness/stacks/nextjs.md docs/adr/0032-secure-generated-project-storage.md docs/adr/README.md docs/OPERATIONS.md docs/VALIDATION.md docs/evidence/issue-72-secure-storage.md
npm run roadmap:check
graphify update .
```

Expected: formatting and roadmap PASS; Graphify refreshes ignored local graph state.

- [ ] **Step 5: Commit**

```bash
git add harness/stacks/nextjs.md docs/adr/0032-secure-generated-project-storage.md docs/adr/README.md docs/OPERATIONS.md docs/VALIDATION.md docs/evidence/issue-72-secure-storage.md
git commit -m "docs: define secure generated-project storage"
```

### Task 5: Final verification, review, evidence, and PR

**Files:**

- Modify only files already in this plan when review finds a task-related issue.
- Generate uncommitted screenshots under `test-results/` for PR evidence.

**Interfaces:**

- Consumes: complete branch from Tasks 1-4.
- Produces: green local gates, green authoritative GitHub checks including `storage-e2e`, reviewed/simplified branch, PR linked to #72, screenshots, and issue evidence.

- [ ] **Step 1: Run focused and full local verification**

```bash
npx vitest run packages/platform/src/supabase-storage.test.ts packages/platform/src/supabase-runtime.test.ts --pool=threads --maxWorkers=1
npx playwright test --config apps/api/e2e/playwright.config.ts
npm run check
npm run doctor
git diff --check origin/main...HEAD
npm run graphify:refresh
git status --short
```

Expected: all deterministic commands PASS. Record the pre-existing baseline browser timing test separately if it reproduces; do not hide or misattribute it.

- [ ] **Step 2: Run whole-branch correctness and simplification reviews**

Use `superpowers:requesting-code-review`, then `ponytail:ponytail-review` and `code-simplifier-v2` over `origin/main...HEAD`. Fix every Critical/Important/correctness finding and every safe behavior-preserving simplification finding; rerun each affected test.

- [ ] **Step 3: Push and open one PR**

```bash
git push -u origin agent/issue-72-secure-storage
gh pr create --repo eedsilva/agent-foundry --base main --head agent/issue-72-secure-storage --title "feat(platform): provision secure local Supabase Storage" --body $'Closes #72\n\n## Summary\n- provision a private, policy-limited local Supabase Storage bucket per generated project\n- enforce owner RLS, quarantine scanning hooks, signed access, and retention-safe export/cleanup\n- verify the security contract with unit and real-Supabase acceptance tests\n\n## Validation\nSee docs/evidence/issue-72-secure-storage.md for the acceptance matrix and command results.'
```

The PR body must include `Closes #72`, acceptance mapping, security/migration/rollback, local command evidence, and the real storage E2E CI requirement.

- [ ] **Step 4: Wait for and fix GitHub checks**

```bash
gh pr checks --repo eedsilva/agent-foundry --watch
```

Do not call the work complete until `storage-e2e`, build, typecheck, lint, format, test, architecture, roadmap, dependency review, and CodeQL are successful. Fix branch failures and push normally; never force-push unless separately authorized.

- [ ] **Step 5: Capture and attach screenshots**

Create two screenshots with no tokens/keys/URLs:

1. Focused test report showing authorized upload, oversize/type rejection, cross-user denial, quarantine gate, signed clean read, export, and cleanup.
2. Generated bucket/schema evidence showing private bucket limits and the RLS/quarantine/retention contract.

Upload with the installed `gh image` extension and post one PR comment containing both images plus the exact commands/check links. Also add the PR URL and evidence comment URL to issue #72.

## Self-Review

- Spec coverage: all five acceptance criteria, the four mandatory upload/access cases, security, migration, rollback, CI, existing Playwright E2E, screenshots, and issue/PR evidence map to Tasks 1-5.
- Placeholder scan: no implementation step defers required code, tests, error behavior, or delivery details.
- Type consistency: Task 2 consumes only the three exact exports declared by Task 1; Task 3 exercises generated SQL/RPC names declared in Task 1; docs repeat the same bucket, MIME, size, states, and RPC names.
- Simplicity: no new npm dependency, public upload API, duplicate storage adapter, AV engine, or unused domain abstraction.
