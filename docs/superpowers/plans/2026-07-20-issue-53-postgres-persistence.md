# Issue #53 — PostgreSQL schema + domain-port adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Postgres-backed implementations of the metadata persistence ports (projects, runs, steps, attempts, approvals, events, step events, conversations, artifacts) behind a `PERSISTENCE_MODE=postgres` switch, with versioned migrations, real constraints/enums/indexes, optimistic concurrency, cursor pagination, and Testcontainers coverage. File mode stays the default; nothing changes for Personal v1.

**Architecture:** Hybrid row layout — every table promotes the relational skeleton (ids, FKs, status enums, version, sequence, timestamps) to real columns with constraints, and stores the full zod-validated entity in a `data jsonb` column. Adapters write both, read by `schema.parse(row.data)` — the same validation gate file adapters use. CAS = `UPDATE … WHERE id=$id AND version=$expected RETURNING`; 0 rows → re-select → `VersionConflictError`/`NotFoundError`. Per-scope serialization that file adapters get from directory locks is done with `pg_advisory_xact_lock` (conversation appends, step-event sequence, artifact revisions). Migrations are numbered SQL strings embedded in TS (no build-time asset copying), applied by a tiny runner under an advisory lock; boot in postgres mode fails fast if the schema is behind (no auto-apply, no ORM sync).

**Tech Stack:** `postgres` (porsager v3) driver in `packages/persistence`; `@testcontainers/postgresql` (root devDep) for tests; zod schemas from `@agent-foundry/contracts` as the single entity validator.

## Global Constraints

- Work from the worktree `/Users/edsilva/Documents/ed/agent-foundry/.claude/worktrees/issue-53-postgres` on branch `agent/issue-53-postgres`. **First step of every task: `cd` there and verify with `git rev-parse --abbrev-ref HEAD` → `agent/issue-53-postgres`.** Absolute file paths in this plan are all under this worktree root.
- `packages/persistence` may import ONLY `@agent-foundry/contracts` and `@agent-foundry/domain` internally (enforced by `npm run lint:architecture`). External deps (`postgres`) are fine.
- TypeScript: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`. Never write `{ foo: maybeUndefined }` into a typed optional — use conditional spread `...(x !== undefined ? { x } : {})`.
- ESM only (`"type": "module"`); intra-package imports use `.js` extension.
- After each task: `npm run typecheck` and the task's tests must pass. Before the final PR: full `npm run check` and `npm run e2e --workspace @agent-foundry/api`.
- Existing file adapters + their tests are the behavioral oracle. When this plan says "mirror `FileXRepository`", read that file and its `.test.ts` first and reproduce observable behavior exactly (same errors, same ordering, same idempotency).
- Postgres tests: use the `describePostgres` helper from Task 1. It must SKIP when Docker is unavailable locally and NEVER skip when `process.env.CI` is set (fail loudly instead).
- Vitest runs with `--maxWorkers=1`; keep all Postgres suites sharing the one container via the Task 1 harness (one container per test file is acceptable, but reuse within a file is mandatory).
- Do not modify `planning/roadmap-spec.json` or any file under `planning/`.
- Do not touch the file adapters' behavior; this PR is purely additive plus composition wiring.
- Commit after each task with a conventional-commit message referencing issue #53.

---

### Task 1: Postgres test harness, migration runner, initial schema

**Files:**
- Modify: `packages/persistence/package.json` (add `"postgres": "^3.4.7"` to dependencies)
- Modify: root `package.json` (add `"@testcontainers/postgresql": "^11.5.0"` to devDependencies)
- Create: `packages/persistence/src/postgres/migrations.ts`
- Create: `packages/persistence/src/postgres/migrator.ts`
- Create: `packages/persistence/src/postgres/client.ts`
- Create: `packages/persistence/src/postgres/testing.ts`
- Test: `packages/persistence/src/postgres/migrator.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (relied on by every later task):
  - `client.ts`: `createPostgresClient(url: string): Sql` and `export type PostgresDb = Sql` (porsager `Sql` type re-export).
  - `migrator.ts`: `migrateUp(sql: PostgresDb): Promise<number[]>` (applied versions), `migrateDown(sql: PostgresDb, toVersion: number): Promise<number[]>` (reverted versions), `assertSchemaCurrent(sql: PostgresDb): Promise<void>` (throws `Error` with message containing `db:migrate` when behind), `latestVersion(): number`.
  - `migrations.ts`: `export interface Migration { version: number; name: string; up: string; down: string }`, `export const MIGRATIONS: readonly Migration[]`.
  - `testing.ts`: `describePostgres(name: string, fn: (ctx: { db: () => PostgresDb }) => void): void` — starts one `PostgreSQLContainer` in `beforeAll` (120s timeout), runs `migrateUp`, exposes a connected client, truncates all tables between tests (`afterEach`), stops container in `afterAll`. Skips via `describe.skip` when Docker is unreachable AND `process.env.CI` is unset; when `CI` is set it must not skip.

- [ ] **Step 1: Install deps**

```bash
cd /Users/edsilva/Documents/ed/agent-foundry/.claude/worktrees/issue-53-postgres
npm install postgres@^3.4.7 --workspace @agent-foundry/persistence
npm install -D @testcontainers/postgresql@^11.5.0 -w .
```
(`-w .` targets the root workspace; verify both package.json diffs and a single root `package-lock.json` update.)

- [ ] **Step 2: Write the failing migrator test**

`packages/persistence/src/postgres/migrator.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from './migrations.js';
import { latestVersion, migrateDown, migrateUp } from './migrator.js';
import { describePostgres, probeDocker } from './testing.js';

describe('migrations manifest', () => {
  it('has strictly increasing versions starting at 1', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
    expect(latestVersion()).toBe(MIGRATIONS.length);
  });
});

describePostgres('postgres migrator', (ctx) => {
  it('applies all migrations up, is idempotent, and reverts down', async () => {
    const sql = ctx.db();
    // describePostgres already ran migrateUp; a second run applies nothing.
    expect(await migrateUp(sql)).toEqual([]);
    const [{ count }] = await sql`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name = 'projects'`;
    expect(count).toBe(1);
    const reverted = await migrateDown(sql, 0);
    expect(reverted).toEqual(MIGRATIONS.map((m) => m.version).reverse());
    const [{ count: after }] = await sql`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name = 'projects'`;
    expect(after).toBe(0);
    expect(await migrateUp(sql)).toEqual(MIGRATIONS.map((m) => m.version));
  });

  it('assertSchemaCurrent throws when behind and passes when current', async () => {
    const sql = ctx.db();
    const { assertSchemaCurrent } = await import('./migrator.js');
    await expect(assertSchemaCurrent(sql)).resolves.toBeUndefined();
    await migrateDown(sql, 0);
    await expect(assertSchemaCurrent(sql)).rejects.toThrow(/db:migrate/);
    await migrateUp(sql);
  });
});
```

- [ ] **Step 3: Run test, expect FAIL** — `npx vitest run packages/persistence/src/postgres/migrator.test.ts` → module-not-found for `./migrations.js`.

- [ ] **Step 4: Implement**

`packages/persistence/src/postgres/migrations.ts` — the complete initial schema as migration 1. Use exactly this DDL (single migration; later issues add their own):

```ts
export interface Migration {
  version: number;
  name: string;
  up: string;
  down: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-metadata-schema',
    up: /* sql */ `
create domain path_segment as text
  check (value ~ '^[A-Za-z0-9._-]{1,200}$' and value not in ('.', '..'));

create type project_status as enum
  ('queued','running','paused','awaiting_approval','completed','failed','cancelled','rejected');
create type workflow_run_status as enum
  ('queued','running','pause_requested','paused','awaiting_approval','cancel_requested','cancelled','completed','failed','rejected');
create type step_run_status as enum
  ('pending','running','completed','failed','cancelled','skipped');
create type step_attempt_status as enum
  ('running','succeeded','failed','cancelled');

create table projects (
  id path_segment primary key,
  status project_status not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null
);
create index projects_created_at_idx on projects (created_at desc, id desc);

create table workflow_runs (
  id path_segment primary key,
  project_id path_segment not null references projects (id) on delete cascade,
  status workflow_run_status not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null
);
create index workflow_runs_project_idx on workflow_runs (project_id, created_at desc, id desc);

create table step_runs (
  id path_segment not null,
  run_id path_segment not null references workflow_runs (id) on delete cascade,
  status step_run_status not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null,
  primary key (run_id, id)
);

create table step_attempts (
  id path_segment not null,
  run_id path_segment not null,
  step_run_id path_segment not null,
  sequence integer not null check (sequence >= 1),
  status step_attempt_status not null,
  version integer not null check (version >= 1),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  data jsonb not null,
  primary key (run_id, step_run_id, id),
  foreign key (run_id, step_run_id) references step_runs (run_id, id) on delete cascade
);

create table approval_requests (
  request_id path_segment not null,
  run_id path_segment not null references workflow_runs (id) on delete cascade,
  step_run_id path_segment not null,
  created_at timestamptz not null,
  data jsonb not null,
  primary key (run_id, request_id)
);
create index approval_requests_step_idx on approval_requests (run_id, step_run_id);

create table approval_decisions (
  request_id path_segment not null,
  run_id path_segment not null,
  created_at timestamptz not null,
  data jsonb not null,
  primary key (run_id, request_id),
  foreign key (run_id, request_id) references approval_requests (run_id, request_id) on delete cascade
);

create table project_events (
  id path_segment primary key,
  project_id path_segment not null references projects (id) on delete cascade,
  run_id path_segment,
  type text not null,
  dedupe_key text,
  created_at timestamptz not null,
  data jsonb not null
);
create index project_events_project_id_idx on project_events (project_id, id);
create unique index project_events_dedupe_idx
  on project_events (project_id, dedupe_key) where dedupe_key is not null;

create table step_events (
  run_id path_segment not null,
  sequence integer not null check (sequence >= 1),
  data jsonb not null,
  primary key (run_id, sequence)
);

create table conversations (
  project_id path_segment primary key references projects (id) on delete cascade,
  data jsonb not null
);

create table conversation_messages (
  project_id path_segment not null references conversations (project_id) on delete cascade,
  sequence integer not null check (sequence >= 1),
  id path_segment not null unique,
  data jsonb not null,
  primary key (project_id, sequence)
);

create table conversation_attachments (
  id path_segment primary key,
  project_id path_segment not null references conversations (project_id) on delete cascade,
  created_at timestamptz not null,
  data jsonb not null
);
create index conversation_attachments_project_idx on conversation_attachments (project_id, created_at, id);

create table conversation_operations (
  id path_segment primary key,
  project_id path_segment not null references conversations (project_id) on delete cascade,
  idempotency_key text not null,
  created_at timestamptz not null,
  data jsonb not null
);
create index conversation_operations_project_idx on conversation_operations (project_id, created_at, id);
create index conversation_operations_idem_idx on conversation_operations (project_id, idempotency_key);

create table conversation_change_requests (
  id path_segment primary key,
  project_id path_segment not null references conversations (project_id) on delete cascade,
  created_at timestamptz not null,
  data jsonb not null
);
create index conversation_change_requests_project_idx on conversation_change_requests (project_id, created_at, id);

create table artifacts (
  project_id path_segment not null references projects (id) on delete cascade,
  name path_segment not null,
  revision integer not null check (revision >= 1),
  sha256 text not null,
  idempotency_key text,
  source_decision_id text,
  storage text not null default 'inline' check (storage in ('inline','blob')),
  blob_deleted boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null,
  content jsonb,
  data jsonb not null,
  primary key (project_id, name, revision)
);
create index artifacts_expiry_idx on artifacts (expires_at)
  where storage = 'blob' and blob_deleted = false and expires_at is not null;

create table artifact_blobs (
  project_id path_segment not null,
  name path_segment not null,
  revision integer not null,
  bytes bytea not null,
  primary key (project_id, name, revision),
  foreign key (project_id, name, revision)
    references artifacts (project_id, name, revision) on delete cascade
);
`,
    down: /* sql */ `
drop table if exists artifact_blobs;
drop table if exists artifacts;
drop table if exists conversation_change_requests;
drop table if exists conversation_operations;
drop table if exists conversation_attachments;
drop table if exists conversation_messages;
drop table if exists conversations;
drop table if exists step_events;
drop table if exists project_events;
drop table if exists approval_decisions;
drop table if exists approval_requests;
drop table if exists step_attempts;
drop table if exists step_runs;
drop table if exists workflow_runs;
drop table if exists projects;
drop type if exists step_attempt_status;
drop type if exists step_run_status;
drop type if exists workflow_run_status;
drop type if exists project_status;
drop domain if exists path_segment;
`,
  },
];
```

`packages/persistence/src/postgres/client.ts`:

```ts
import postgres, { type Sql } from 'postgres';

export type PostgresDb = Sql;

export function createPostgresClient(url: string): PostgresDb {
  // ponytail: fixed small pool; tune via env only when a real workload demands it.
  return postgres(url, { max: 10, onnotice: () => {} });
}
```

`packages/persistence/src/postgres/migrator.ts`:

```ts
import { MIGRATIONS } from './migrations.js';
import type { PostgresDb } from './client.js';

const MIGRATION_LOCK_KEY = 724_853_001; // arbitrary stable app-wide key

export function latestVersion(): number {
  return MIGRATIONS.at(-1)?.version ?? 0;
}

async function withMigrationLock<T>(sql: PostgresDb, fn: () => Promise<T>): Promise<T> {
  await sql`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
  try {
    return await fn();
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
  }
}

async function ensureLedger(sql: PostgresDb): Promise<void> {
  await sql`create table if not exists schema_migrations (
    version integer primary key,
    name text not null,
    applied_at timestamptz not null default now()
  )`;
}

async function appliedVersions(sql: PostgresDb): Promise<Set<number>> {
  const rows = await sql<{ version: number }[]>`select version from schema_migrations`;
  return new Set(rows.map((row) => row.version));
}

export async function migrateUp(sql: PostgresDb): Promise<number[]> {
  return withMigrationLock(sql, async () => {
    await ensureLedger(sql);
    const applied = await appliedVersions(sql);
    const ran: number[] = [];
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.up);
        await tx`insert into schema_migrations (version, name)
          values (${migration.version}, ${migration.name})`;
      });
      ran.push(migration.version);
    }
    return ran;
  });
}

export async function migrateDown(sql: PostgresDb, toVersion: number): Promise<number[]> {
  return withMigrationLock(sql, async () => {
    await ensureLedger(sql);
    const applied = await appliedVersions(sql);
    const ran: number[] = [];
    for (const migration of [...MIGRATIONS].reverse()) {
      if (migration.version <= toVersion || !applied.has(migration.version)) continue;
      await sql.begin(async (tx) => {
        await tx.unsafe(migration.down);
        await tx`delete from schema_migrations where version = ${migration.version}`;
      });
      ran.push(migration.version);
    }
    return ran;
  });
}

export async function assertSchemaCurrent(sql: PostgresDb): Promise<void> {
  await ensureLedger(sql);
  const applied = await appliedVersions(sql);
  const missing = MIGRATIONS.filter((m) => !applied.has(m.version)).map((m) => m.version);
  if (missing.length > 0) {
    throw new Error(
      `Postgres schema is behind: missing migrations [${missing.join(', ')}]. Run: npm run db:migrate`,
    );
  }
}
```

`packages/persistence/src/postgres/testing.ts`:

```ts
import { execSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, describe } from 'vitest';
import { createPostgresClient, type PostgresDb } from './client.js';
import { migrateUp } from './migrator.js';

export function probeDocker(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = probeDocker();
if (process.env.CI && !dockerAvailable) {
  throw new Error('CI requires Docker for Postgres tests; refusing to skip.');
}

export function describePostgres(
  name: string,
  fn: (ctx: { db: () => PostgresDb }) => void,
): void {
  const suite = dockerAvailable ? describe : describe.skip;
  suite(name, () => {
    let sql: PostgresDb | undefined;
    let stop: (() => Promise<unknown>) | undefined;

    beforeAll(async () => {
      const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
      const container = await new PostgreSqlContainer('postgres:17-alpine').start();
      stop = () => container.stop();
      sql = createPostgresClient(container.getConnectionUri());
      await migrateUp(sql);
    }, 120_000);

    afterEach(async () => {
      if (!sql) return;
      const tables = await sql<{ table_name: string }[]>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name <> 'schema_migrations'`;
      if (tables.length > 0) {
        await sql.unsafe(
          `truncate table ${tables.map((t) => `"${t.table_name}"`).join(', ')} cascade`,
        );
      }
    });

    afterAll(async () => {
      await sql?.end({ timeout: 5 });
      await stop?.();
    }, 60_000);

    fn({
      db: () => {
        if (!sql) throw new Error('postgres container not started');
        return sql;
      },
    });
  });
}
```

Note for the migrator test's down-then-up case: `afterEach` truncation tolerates zero tables (the `if` guard). The second migrator test restores the schema (`migrateUp`) before finishing so `afterEach` and later tests see a current schema.

- [ ] **Step 5: Run test, expect PASS** — `npx vitest run packages/persistence/src/postgres/migrator.test.ts` (locally with Docker running; otherwise the container-backed suites skip and only the manifest test runs — state which happened in the task report).

- [ ] **Step 6: Typecheck** — `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(persistence): add postgres migration runner, initial schema, testcontainers harness (#53)"
```

---

### Task 2: Versioned CRUD helpers + project/run/step/attempt repositories

**Files:**
- Create: `packages/persistence/src/postgres/versioned.ts`
- Create: `packages/persistence/src/postgres/project-repository.ts`
- Create: `packages/persistence/src/postgres/run-repositories.ts`
- Test: `packages/persistence/src/postgres/project-repository.test.ts`
- Test: `packages/persistence/src/postgres/run-repositories.test.ts`

**Interfaces:**
- Consumes: `PostgresDb` from `./client.js`; `describePostgres` from `./testing.js`.
- Produces:
  - `versioned.ts`:
    - `insertVersioned(sql, opts: { table: string; entity: string; id: string; version: number; columns: Record<string, unknown>; data: unknown }): Promise<void>` — throws `Error(\`\${entity} \${id} already exists\`)` on PK conflict and `Error` when `version !== 1` (mirror `createVersioned` in `packages/persistence/src/run-repositories.ts`).
    - `updateVersioned<T>(sql, opts: { table: string; entity: string; id: string; keyColumns: Record<string, string>; expectedVersion: number; nextData: unknown; columns: Record<string, unknown> }): Promise<void>` — single `UPDATE … WHERE <keys> AND version = expected` setting `version = expected + 1`; on 0 rows re-select by keys → missing → `NotFoundError(entity, id)`; present → `VersionConflictError(entity, id, expectedVersion, actualVersion)` (import both from `@agent-foundry/domain`).
  - `PostgresProjectRepository implements ProjectRepository` — constructor `(sql: PostgresDb)`.
  - `PostgresWorkflowRunRepository`, `PostgresStepRunRepository`, `PostgresStepAttemptRepository` implementing their ports, constructor `(sql: PostgresDb)`.
  - CAS/version behavior identical to the file adapters: `create` rejects `version !== 1`; `update` returns the parsed updated entity with `version = expectedVersion + 1`.

Behavioral oracle: `packages/persistence/src/project-repository.ts`, `run-repositories.ts` and their tests. Entity (de)serialization: `ProjectSchema.parse(row.data)` etc. — schemas from `@agent-foundry/contracts` (`ProjectSchema`, `WorkflowRunSchema`, `StepRunSchema`, `StepAttemptSchema`). The `update` methods must persist `next.version = expectedVersion + 1` inside `data` too (file adapters store the bumped version in the JSON document; keep column and `data->>'version'` equal).

Key SQL shapes (use these):
- `ProjectRepository.list(limit=50)`: `select data from projects order by created_at desc, id desc limit ${limit}`.
- `WorkflowRunRepository.list(projectId, limit=50)`: same ordering filtered by `project_id` — mirrors file adapter's `createdAt` desc sort.
- `StepAttemptRepository.list(runId, stepRunId)`: `order by sequence asc`.
- All `get` return `null` on no row.

- [ ] **Step 1: Write failing tests.** Cover, with real Postgres via `describePostgres`:
  - create + get + list ordering for projects (3 projects, distinct `createdAt`, assert desc order and `limit`).
  - create with `version: 2` rejects (`/version 1/i`), duplicate create rejects (`/already exists/i`).
  - update happy path bumps version to 2 (both returned entity and a fresh `get`).
  - CAS: two sequential updates with the same `expectedVersion: 1` — second throws `VersionConflictError` with `actualVersion: 2`.
  - concurrent CAS: `Promise.allSettled` of 5 parallel `update(project, 1)` — exactly one fulfilled, four rejected with `VersionConflictError`.
  - update of a missing id throws `NotFoundError`.
  - FK violation: creating a `WorkflowRun` whose `projectId` doesn't exist rejects (assert the error message mentions `workflow_runs` FK; wrap driver errors as-is, no translation needed beyond CAS/NotFound).
  - step/attempt: create run → step → 2 attempts with sequences 2,1 → `list` returns ascending sequence.

Use the same fixture-builder style as `packages/persistence/src/run-repositories.test.ts` (copy its `makeProject`/`makeRun`-style builders, adjusting imports). Write complete test code — no TODOs.

- [ ] **Step 2: Run tests, expect FAIL** (module not found).
- [ ] **Step 3: Implement** `versioned.ts` then the repositories. Implementation notes:
  - porsager: `sql`insert into projects ${sql(columns)}`` inserts from an object; catch error with `.code === '23505'` for PK conflict, rethrow others untouched.
  - `updateVersioned` example (reference implementation — reuse for all four repos):

```ts
import { NotFoundError, VersionConflictError } from '@agent-foundry/domain';
import type { PostgresDb } from './client.js';

export async function updateVersioned(
  sql: PostgresDb,
  opts: {
    table: string;
    entity: string;
    id: string;
    keyColumns: Record<string, string>;
    expectedVersion: number;
    columns: Record<string, unknown>;
    data: unknown;
  },
): Promise<void> {
  const keys = Object.entries(opts.keyColumns);
  const where = keys.map(([col]) => col).join(' = ? and ') + ' = ?';
  const result = await sql.unsafe(
    `update ${opts.table}
       set version = version + 1,
           data = $${keys.length + 1},
           ${Object.keys(opts.columns)
             .map((col, i) => `${col} = $${keys.length + 2 + i}`)
             .join(', ')}
     where ${keys.map(([col], i) => `${col} = $${i + 1}`).join(' and ')}
       and version = $${keys.length + 2 + Object.keys(opts.columns).length}`,
    [
      ...keys.map(([, value]) => value),
      JSON.stringify(opts.data),
      ...Object.values(opts.columns),
      opts.expectedVersion,
    ],
  );
  if (result.count === 1) return;
  const existing = await sql.unsafe(
    `select version from ${opts.table} where ${keys
      .map(([col], i) => `${col} = $${i + 1}`)
      .join(' and ')}`,
    keys.map(([, value]) => value),
  );
  const row = existing[0] as { version: number } | undefined;
  if (!row) throw new NotFoundError(opts.entity, opts.id);
  throw new VersionConflictError(opts.entity, opts.id, opts.expectedVersion, row.version);
}
```

  (If `NotFoundError`'s constructor signature differs, match `packages/domain/src/errors.ts` exactly — check before writing.) `sql.unsafe` with parameter placeholders `$1…$n` is safe here: table/column names come from our own code, never from input; values are always parameterized. Keep JSON writes as `JSON.stringify(...)::jsonb` via parameter (porsager serializes objects for jsonb columns automatically when using tagged templates — for `unsafe`, pass the string and cast in SQL: `data = $k::jsonb`; verify against porsager docs in node_modules README and adjust — whichever compiles and passes tests, keep consistent everywhere).
  - Column duplication per entity: `projects` → `{status, created_at, updated_at}`; `workflow_runs` → `{project_id, status, created_at, updated_at}`; `step_runs` → `{run_id, status, created_at, updated_at}` (key = `(run_id, id)`); `step_attempts` → `{run_id, step_run_id, sequence, status, created_at, updated_at}` (key = `(run_id, step_run_id, id)`).
- [ ] **Step 4: Run tests, expect PASS.**
- [ ] **Step 5: Typecheck** — `npm run typecheck`.
- [ ] **Step 6: Commit** — `feat(persistence): postgres project/run/step/attempt repositories with CAS (#53)`.

---

### Task 3: Event store + step-event repository (cursor pagination, dedupe, sequence)

**Files:**
- Create: `packages/persistence/src/postgres/event-store.ts`
- Create: `packages/persistence/src/postgres/step-event-repository.ts`
- Test: `packages/persistence/src/postgres/event-store.test.ts`
- Test: `packages/persistence/src/postgres/step-event-repository.test.ts`

**Interfaces:**
- Consumes: `PostgresDb`, `describePostgres` (Task 1). Requires a project row to exist (FK): tests insert a minimal project via `PostgresProjectRepository` (Task 2) or raw SQL.
- Produces: `PostgresEventStore implements EventStore` (`append`, `list(projectId, limit=500, afterId?)`), `PostgresStepEventRepository implements StepEventRepository` (`append(input): Promise<AgentStreamEvent>`, `list(runId, {cursor, limit})`). Constructors `(sql: PostgresDb)`.

Behavioral oracle: `packages/persistence/src/event-store.ts` (+ test) and `packages/persistence/src/step-event-repository.ts` (+ test). Critical behaviors to reproduce exactly:
- `EventStore.append` redacts BEFORE persisting: `redactEvent` from `@agent-foundry/domain` (same call the file store makes), then inserts. With `dedupeKey`: `insert … on conflict (project_id, dedupe_key) where dedupe_key is not null do nothing` — the partial unique index replaces the file store's full-file scan. Appending a duplicate dedupeKey is a silent no-op.
- `EventStore.list` without `afterId`: LAST `limit` events in ascending id order (`select data from project_events where project_id = ${p} order by id desc limit ${limit}` then reverse in JS). With `afterId`: `where project_id = ${p} and id > ${afterId} order by id asc limit ${limit}` (ULID string comparison — matches file fallback semantics; exact-id-position lookup and string `>` coincide for ULIDs, and the file adapter's fallback is `>` anyway).
- `StepEventRepository.append` assigns `sequence = max(existing)+1` transactionally and applies the SAME redaction as the file impl (reuse the `redactPayload` logic — copy the function; it is 25 lines, private in the file adapter). Serialize per run with `sql.begin` + `select pg_advisory_xact_lock(hashtext('step_events:' || ${runId}))` then `insert … sequence = (select coalesce(max(sequence), 0) + 1 from step_events where run_id = ${runId})` via a `returning data` insert-select. Parse result through `AgentStreamEventSchema` and return it.
- `StepEventRepository.list(runId, {cursor=0, limit})`: `where run_id and sequence > cursor order by sequence asc`, `limit` only when provided.

Tests (write full code): dedupe no-op; list-tail vs list-after-cursor pagination (append 7, limit 3 → last 3 ascending; afterId at #2 with limit 3 → #3-#5); redaction (append event whose `message` contains `Bearer abc123token456xyz789` → stored/listed message contains `[REDACTED]`); step-event sequence assignment under `Promise.all` of 10 concurrent appends → sequences exactly 1..10, no gaps/dupes; step-event cursor list; FK violation appending to unknown project rejects.

Steps: failing tests → implement → pass → `npm run typecheck` → commit `feat(persistence): postgres event store and step-event repository (#53)`.

---

### Task 4: Conversation + approval repositories

**Files:**
- Create: `packages/persistence/src/postgres/conversation-repository.ts`
- Create: `packages/persistence/src/postgres/approval-repositories.ts`
- Test: `packages/persistence/src/postgres/conversation-repository.test.ts`
- Test: `packages/persistence/src/postgres/approval-repositories.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2 exports.
- Produces: `PostgresConversationRepository implements ConversationRepository`, `PostgresApprovalRequestRepository implements ApprovalRequestRepository`, `PostgresApprovalDecisionRepository implements ApprovalDecisionRepository`. Constructors `(sql: PostgresDb)`.

Behavioral oracle: `packages/persistence/src/conversation-repository.ts` (READ IT FULLY — it has existence checks like `requireConversation`, message-content redaction before persisting, and idempotency semantics on `createOperation`/`createChangeRequest`; reproduce all of them, including thrown error types/messages) and `approval-repositories.ts` (+ both test files).

Implementation notes:
- All conversation mutations: `sql.begin` + `pg_advisory_xact_lock(hashtext('conversation:' || ${projectId}))` — one serialization scope per project, mirroring the file adapter's single conversation lock.
- `appendMessage`: sequence = `coalesce(max(sequence),0)+1` within the locked transaction; redact content blocks exactly as the file adapter does (find its redaction call and copy it); return the parsed `Message`.
- `listMessages(projectId, {cursor, limit})`: `sequence > cursor order by sequence asc`, `limit` when provided — cursor pagination via the PK index.
- `updateOperation`/`updateChangeRequest`: file adapter semantics (no CAS — read-modify-write full replace by id; keep a plain `update … set data = … where id = …`, throwing the file adapter's error when the row is missing).
- `getSnapshot`: 5 queries in one transaction (conversation, messages asc, attachments, operations, changeRequests — match the file adapter's ordering for each list).
- Approval repos: plain inserts (PK conflicts surface as errors — mirror file behavior on duplicate create), `getForStepRun` = `where run_id = ${runId} and step_run_id = ${stepRunId} limit 1` on the index, `list(runId)` ordered as the file adapter orders (check its test).

Tests (full code, via `describePostgres`): snapshot roundtrip covering every record type; message sequence + cursor pagination + concurrent append (10 parallel → sequences 1..10); operation idempotency semantics copied from the file test; approval request→decision flow incl. `getForStepRun` and the ≤1-decision-per-request constraint (duplicate decision insert rejects); missing-conversation error paths.

Steps: failing tests → implement → pass → typecheck → commit `feat(persistence): postgres conversation and approval repositories (#53)`.

---

### Task 5: Artifact store (metadata + inline content + bytea blobs + reap)

**Files:**
- Create: `packages/persistence/src/postgres/artifact-store.ts`
- Test: `packages/persistence/src/postgres/artifact-store.test.ts`

**Interfaces:**
- Consumes: Tasks 1-2 exports.
- Produces: `PostgresArtifactStore implements ArtifactStore` — full port: `put`, `putBlob`, `getBlobStream`, `getLatest`, `getRevision`, `listLatest`, `listMetadata`, plus `reapExpired(now: Date): Promise<number>` (same extra method the file store exposes for the API reaper).

Behavioral oracle: `packages/persistence/src/artifact-store.ts` + test. Reproduce:
- Revision allocation: inside `sql.begin` + `pg_advisory_xact_lock(hashtext('artifacts:' || ${projectId}))`, `revision = coalesce(max(revision),0)+1` per `(project_id, name)`.
- `put` idempotency: before allocating, look up an existing row matching `idempotency_key` (or, failing that, `source_decision_id`) for the same `(project_id, name)`; on hit return that revision's `StoredArtifact` (metadata from `data`, content from `content`).
- `put` computes `sha256` of `JSON.stringify(content)` exactly as the file store does (copy the hashing call from `fs-utils.ts`'s `sha256` helper or reimplement with `node:crypto` identically).
- `putBlob(input, source)`: stream-consume `source` into a buffer while hashing incrementally and enforcing `input.maxBytes` mid-stream — on exceed, destroy the stream and throw `ArtifactTooLargeError` (import from domain; match the file adapter's error construction). Then transactionally allocate revision, insert `artifacts` row (`storage='blob'`, `sizeBytes`, `expiresAt` from `retentionSeconds`, `content = null`) and `artifact_blobs` row (bytes). `sizeBytes`/`sha256` from the actual streamed bytes.
  - `// ponytail: blob bytes buffered in memory and stored as bytea (caps: ≤50MB per existing ARTIFACT_MAX_* limits); issue #54 moves bytes to object storage with true streaming.`
- `getBlobStream`: select bytes; `null` when the artifact/blob row is missing or `blob_deleted` — return a `Readable.from(buffer)`.
- `listLatest`/`listMetadata`/`getLatest`/`getRevision`: match file ordering and shapes (check the file test for exact expectations — e.g. `listMetadata(projectId)` returns all names' revisions; keep its ordering).
- `reapExpired(now)`: one statement — `update artifacts set blob_deleted = true where storage='blob' and blob_deleted=false and expires_at <= ${now} returning project_id, name, revision`, then `delete from artifact_blobs` for the returned keys (same transaction); return count. Metadata survives; `getBlobStream` afterwards returns `null` (→ API 410 flow unchanged).

Tests (full code): inline put/get/list + revision monotonicity under 5 concurrent puts of the same name (revisions 1..5 unique); idempotencyKey and sourceDecisionId short-circuits; blob roundtrip with sha256/sizeBytes assertions; `maxBytes` exceeded throws `ArtifactTooLargeError` and leaves no row; reap flow (put blob with `retentionSeconds: 0`, reap with future `now`, assert count 1, `getBlobStream` → null, metadata `blobDeleted: true`); FK violation for unknown project.

Steps: failing tests → implement → pass → typecheck → commit `feat(persistence): postgres artifact store with bytea blobs and reap (#53)`.

---

### Task 6: Composition wiring, migrate script, compose service, docs

**Files:**
- Modify: `packages/persistence/src/index.ts` (export the `postgres/` modules: client, migrator, all `Postgres*` classes — follow the existing barrel style)
- Modify: `packages/composition/src/config.ts`
- Modify: `packages/composition/src/runtime.ts`
- Create: `scripts/db-migrate.mjs`
- Modify: root `package.json` (script `"db:migrate": "node scripts/db-migrate.mjs"`)
- Modify: `docker-compose.yml` (add `postgres` service)
- Modify: `.env.example` (`PERSISTENCE_MODE`, `DATABASE_URL`)
- Modify: `docs/OPERATIONS.md` ("Migração para Postgres" section: replace the aspirational text with actual instructions)
- Create: `docs/adr/0016-postgres-metadata-persistence.md` (number = next free; check `ls docs/adr/`)
- Test: `packages/composition/src/runtime.postgres.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: `RuntimeConfig` gains `persistenceMode: 'file' | 'postgres'` and `databaseUrl?: string`; `createRuntime` in postgres mode constructs the 9 Postgres adapters (projects, runs, steps, attempts, approvalRequests, approvalDecisions, events, stepEvents, conversations, artifacts) and calls `assertSchemaCurrent` once at boot; everything else (queue, metrics, quality, previews, model overrides, project versions, workflows, policies, workspaces) stays file-based. Runtime member types for the swapped nine widen from concrete `File*` classes to their port interfaces (plus `reapExpired` for artifacts: declare the runtime member as `ArtifactStore & { reapExpired(now: Date): Promise<number> }` or add `reapExpired` to the `ArtifactStore` port — pick adding it to the port, both impls already have it, and update `packages/domain/src/ports.ts` accordingly).

Config rules (mirror `EXECUTOR_MODE` style in `config.ts`): `PERSISTENCE_MODE: z.enum(['file','postgres']).default('file')`; `DATABASE_URL: z.string().min(1).optional()`; `superRefine`: `persistenceMode === 'postgres' && !databaseUrl` → config error `"PERSISTENCE_MODE=postgres requires DATABASE_URL"`.

`scripts/db-migrate.mjs` (complete):

```js
import { loadDotEnv } from './lib/dotenv.mjs'; // if no such helper exists, use: import 'dotenv/config';
import { createPostgresClient, migrateUp } from '@agent-foundry/persistence';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const sql = createPostgresClient(url);
const applied = await migrateUp(sql);
console.log(applied.length === 0 ? 'schema up to date' : `applied migrations: ${applied.join(', ')}`);
await sql.end({ timeout: 5 });
```

(Scripts import workspace packages by name elsewhere? Verify — if root scripts can't resolve `@agent-foundry/persistence` before build, import from `../packages/persistence/dist/index.js` guarded by a "run npm run build first" error, or use `tsx`-style direct src import consistent with other scripts in `scripts/`. Match whatever an existing script does; if none imports a workspace, use `node --import tsx scripts/db-migrate.mts`? Keep it simplest-that-works and document the choice in the task report.)

`docker-compose.yml` service (additive):

```yaml
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: foundry
      POSTGRES_PASSWORD: foundry
      POSTGRES_DB: foundry
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U foundry']
      interval: 5s
      timeout: 3s
      retries: 10
```

(plus `postgres_data` under top-level `volumes:`; do NOT point `api`/`worker` at it by default — file mode stays the shipped default. Add a commented `# PERSISTENCE_MODE: postgres` + `# DATABASE_URL: postgres://foundry:foundry@postgres:5432/foundry` pair in both services' `environment:` blocks.)

`runtime.postgres.test.ts` (composition): wrap in the same Docker-skip guard (import `describePostgres` is persistence-internal — composition may import `@agent-foundry/persistence` ✓, reuse it): boot `createRuntime` with `PERSISTENCE_MODE=postgres`, `DATABASE_URL` from a testcontainer (run `migrateUp` first), `EXECUTOR_MODE=mock`, temp `DATA_DIR` — assert (a) boot succeeds and `runtime.projects` round-trips a create/get against Postgres; (b) boot with an un-migrated database throws `/db:migrate/`; (c) `PERSISTENCE_MODE=postgres` without `DATABASE_URL` throws the config error. Also verify `runtime.worker.runOnce()` drives a mock-executor project run end-to-end with Postgres persistence: create a project via `runtime.projectService.create(...)` (copy the minimal fixture from an existing composition/orchestrator test — see `packages/orchestrator/src/testing/harness.ts` and existing runtime tests for the smallest working project-create call) and drive `runOnce` until the run completes; assert run status `completed` reading through `runtime.runs`. This is the acceptance-criterion proof that adapters serve the same ports the local mode uses.

ADR content: context (ADR 0003 deferred Postgres), decision (hybrid jsonb+columns, embedded SQL migrations, advisory-lock serialization, PERSISTENCE_MODE switch, file default), consequences (bytea ceiling → #54, queue/metrics/previews still file → #55+, rollback = set PERSISTENCE_MODE=file).

`docs/OPERATIONS.md`: update the "Migração para Postgres" section — how to enable (env vars), migrate (`npm run db:migrate`), rollback (switch back to file mode; data written while in postgres mode does not sync back — state this explicitly), and that blobs currently live in bytea until #54.

Steps: failing composition test → wire config/runtime → pass → full `npm run check` → commit `feat(composition): PERSISTENCE_MODE=postgres wiring, db:migrate, compose service, ADR (#53)`.

---

### Task 7: Final verification + PR

- [ ] `npm run check` (must be fully green — format, lint, architecture, roadmap, typecheck, tests incl. all Postgres suites, build).
- [ ] `npm run e2e --workspace @agent-foundry/api` (file-mode golden flow — proves zero regression for the default path).
- [ ] Capture evidence: test-run output for the Postgres suites (migration up/down, CAS conflict, constraint violation, concurrency, pagination), `npm run check` tail, e2e summary.
- [ ] Push branch, open PR titled `feat: PostgreSQL schema and domain-port adapters behind PERSISTENCE_MODE (#53)`, body: summary, acceptance-criteria checklist mapped to code/tests, evidence blocks, security/migration/rollback assessment (DoD), `Closes #53`. End PR body with the standard Claude Code attribution line.

## Self-Review Notes

- Issue criterion "Migrations versionadas criam constraints, índices e enums sem depender de sync automático" → Task 1 (DDL: enums, FKs, partial unique index, domain type; runner applies explicitly; boot only asserts).
- "Adapters implementam as mesmas portas usadas pelo modo local" → Tasks 2-5 + Task 6's end-to-end mock run through `runtime.worker.runOnce()` on Postgres.
- "Optimistic concurrency impede lost update" → Task 2 CAS + concurrent-update tests.
- "Queries principais possuem paginação por cursor" → Task 3 (`afterId`/`cursor`), Task 4 (`listMessages` cursor).
- "Testcontainers cobre migrations e comportamento dos repos" → all tasks' suites via `describePostgres`.
- "Migration up/down suportada, constraint violations e concorrência" (mandatory tests) → Task 1 up/down, Tasks 2-5 constraint/concurrency tests.
- Out of scope (explicit): JobQueue (#55), event fanout/SSE changes (#56), object storage (#54), metrics/quality/preview/model-override/project-version repos (not in the issue's entity list; file adapters remain), policy/workflow YAML repos (static config, not runtime data — persisting them adds surface for zero benefit).
