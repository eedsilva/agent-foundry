# Generate Migrations From the Schema Artifact (#481) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrations are generated from the approved schema plan artifact — forward-only, constraints and RLS in the database by construction — and implementation tasks receive the schema as input context instead of inventing tables. Per ADR 0060 and GitHub issue #481.

**Architecture:** Four seams, smallest diff at each:

1. A pure generator in `packages/contracts` turns a `SchemaPlan` into idempotent forward-only Postgres DDL (`create table if not exists`, constraints, indexes, `enable row level security`, `drop policy if exists` + `create policy`). Contracts is the only package both the orchestrator and platform already depend on, and the generator has no runtime dependency beyond the type it consumes.
2. `workflows/web-app-v1.yaml` gains a `schema` agent step (`outputContract: schema-plan`, already supported by `workflow-orchestrator.ts:2784` and `:3107`) plus a `schema-approval` gate, and the per-task `implement` step takes `schema.current` as an input artifact.
3. The orchestrator writes the generated SQL into the project workspace at `supabase/migrations/<ts>_schema_plan.sql` when a step's `outputContract === 'schema-plan'` validates — the file is committed by the existing `mutatesWorkspace` path and applied by the existing `applyWorkspaceMigrations` / `db:reset` machinery. No new node type, no change to the destructive-migration approval gate.
4. A new `GeneratedProjectRuntime.verifySchema` port method queries the live project database (`information_schema`, `pg_class.relrowsecurity`) and the orchestrator hard-fails when the observed tables do not match the approved plan.

**Tech Stack:** TypeScript, Zod v4, Vitest, `postgres` (npm, already in the monorepo via `@agent-foundry/persistence`), Supabase CLI, Postgres testcontainers (`describePostgres`).

## Global Constraints

- **The destructive-migration approval gate is untouched.** `requireMigrationApproval` in `packages/platform/src/supabase-runtime.ts` must not be modified. Acceptance criterion: "Destructive changes still require approval" is satisfied by *not* bypassing it. (Issue #481, ADR 0060.)
- **Forward-only.** The generator never emits `drop table`, `drop column`, or `alter column type`. Re-running a schema step that produced identical DDL must not write a second migration file; a changed schema writes a *new* timestamped file, never rewrites an applied one. (Issue #481, ADR 0060.)
- **Verify by query, not by reading the file.** RLS and table shape are asserted against a real Postgres, never by string-matching the generated SQL. (Issue #481 agent guidance.)
- **A schema mismatch is a hard failure, not a warning.** (Issue #481 agent guidance.)
- **Data plane is `DATABASE_URL` + S3-compatible storage. Do not introduce `supabase-js`.** (Issue #481 agent guidance; project memory.)
- **`supabase status` is the authoritative JSON source, never `supabase start` output** — `start` output drifted before and broke a storage E2E. (Issue #481 agent guidance.)
- Run `npm run typecheck` (`tsc -b --pretty false`) after every task that touches `.ts`/`.tsx`. A vitest-only verification lets `exactOptionalPropertyTypes` errors through.
- Any new test file that binds ports, spawns processes, uses containers, or asserts elapsed time goes in the **slow** bucket. The fast/slow lists in `package.json` must stay an exact partition — verify with `npx vitest list --filesOnly`. (AGENTS.md.)
- Fast test loop: `npx vitest run <file>` for the files the task touches. Do not run the full suite after every step.
- No comments explaining WHAT code does — only WHY, and only when non-obvious. Default to no comments.
- Follow the ponytail rule: the shortest change that actually works. No speculative options objects, no abstraction with one implementation, no config for a value that never changes.

---

### Task 1: Pure migration generator — `generateSchemaPlanSql`

**Files:** `packages/contracts/src/schema-plan-sql.ts` (new), `packages/contracts/src/schema-plan-sql.test.ts` (new), `packages/contracts/src/index.ts` (export).

**Interface:**

```ts
export function generateSchemaPlanSql(plan: SchemaPlan): string;
```

`SchemaPlan` and its member types come from `./schema-plan.js` (`SchemaTable`, `SchemaColumn`, `SchemaConstraint`, `SchemaIndex`, `RlsPolicy`, `TableRls`). Read that file first — it is the authority on the input shape.

**Required SQL shape**, per table, in this order:

1. `create table if not exists public.<table> ( <columns>, <table-level constraints> );`
   - Column line: `<name> <type>` + `not null` when `nullable === false` + `default <default>` when `default` is set.
   - Column types map 1:1 to Postgres type names (`uuid`, `text`, `integer`, `numeric`, `boolean`, `timestamptz`, `date`, `jsonb`).
   - `primary-key` → `primary key (<cols>)`; `unique` → `unique (<cols>)`; `foreign-key` → `foreign key (<cols>) references <referencesTable> (<referencesColumns>) on delete <cascade|restrict|set null>`; `check` → `constraint <name> check (<expression>)`.
   - A `referencesTable` **without** a dot is a local table and must be emitted as `public.<name>`; a dotted reference (`auth.users`) is emitted verbatim — `validateSchemaPlan` already treats dotted references as external.
   - `onDelete: 'set-null'` maps to SQL `set null`.
2. `create index if not exists <name> on public.<table> (<cols>);` — `unique: true` → `create unique index if not exists`.
3. `alter table public.<table> enable row level security;`
4. Per policy: `drop policy if exists <name> on public.<table>;` then `create policy <name> on public.<table> for <command> [using (<using>)] [with check (<withCheck>)];`
   - `command: 'all'` emits `for all`.
   - Emit `using` only when set, `with check` only when set. `RlsPolicySchema` guarantees at least one is present.

**Identifier quoting:** wrap every identifier that is not `^[a-z_][a-z0-9_]*$` in double quotes; leave plain lowercase identifiers unquoted so the output reads like the hand-written baseline migration in `harness/scaffolds/nextjs/supabase/migrations/20260726000000_rls_baseline.sql`. Expressions (`default`, `check.expression`, `using`, `withCheck`) are emitted verbatim — they are DB expressions authored by the planner, already constrained by the contract.

**Header:** the file starts with a comment naming the generator and the plan's `schemaVersion`, e.g.
`-- Generated from the approved schema plan artifact (schemaVersion 1). Forward-only; do not edit by hand.`

**Steps:**

- [ ] RED: write `packages/contracts/src/schema-plan-sql.test.ts` with a first failing test — a single-table plan (one uuid PK column, one text column, RLS with one `select` policy using `user_id = (select auth.uid())`) produces SQL containing exactly the create/enable-RLS/create-policy statements. Run `npx vitest run packages/contracts/src/schema-plan-sql.test.ts` and watch it fail because the module does not exist.
- [ ] GREEN: implement `generateSchemaPlanSql` minimally; watch the test pass.
- [ ] RED→GREEN for each remaining behaviour, one test at a time: composite primary key; unique constraint; local foreign key (`public.` prefix added); external foreign key (`auth.users` emitted verbatim); `on delete set null`; named check constraint; plain and unique indexes; a policy with only `withCheck`; a `for all` policy; an identifier needing quoting; multi-table output ordering follows `plan.tables` order.
- [ ] Add a test asserting the output contains **no** `drop table`, `drop column`, or `alter column` (forward-only global constraint).
- [ ] Export `generateSchemaPlanSql` from `packages/contracts/src/index.ts`.
- [ ] Run `npx vitest run packages/contracts/src/schema-plan-sql.test.ts` and `npm run typecheck`.

**Verification:** all new tests pass; `npm run typecheck` exits 0.

---

### Task 2: Prove the generated SQL against a real Postgres

**Files:** `packages/contracts/src/schema-plan-sql.integration.test.ts` (new — note: contracts has no Postgres helper today, so read `packages/persistence/src/postgres/testing.ts` and reuse `describePostgres` if it is importable from a devDependency; if importing `@agent-foundry/persistence` into `packages/contracts` tests would create a dependency cycle, put this file in `packages/persistence/src/postgres/schema-plan-sql.integration.test.ts` instead and import the generator from `@agent-foundry/contracts`. Prefer the placement that adds **no** new package dependency edge.), `package.json` (slow-bucket list).

This is the ticket's "applies cleanly / RLS active per table (verified by query)" evidence, automated.

**Steps:**

- [ ] Read `packages/persistence/src/postgres/testing.ts` and an existing `describePostgres` suite to copy the setup idiom exactly.
- [ ] RED: write a test that loads `docs/evidence/harness-alignment/crud-heavy/schema-plan.json`, parses it with `SchemaPlanArtifactSchema`, generates the SQL, and executes it against the test Postgres — asserting it applies without error. It will fail first because the fixtures reference `auth.users` and `auth.uid()`, which do not exist in a plain Postgres. Fix by creating a minimal stub in the test setup **before** applying the generated SQL:
      `create schema if not exists auth;`
      `create table if not exists auth.users (id uuid primary key);`
      `create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;`
  The stub belongs to the test, not to the generator.
- [ ] Add a test that applies the SQL **twice** and still succeeds — proving the idempotent DDL claim.
- [ ] Add the query-based assertions, all three run against the live database, none by reading the SQL string:
  - every table in the plan exists in `information_schema.tables` (`table_schema = 'public'`);
  - every column of every planned table exists in `information_schema.columns` with a matching data type and nullability;
  - every planned table has `relrowsecurity = true` in `pg_class` (join `pg_namespace` on `nspname = 'public'`);
  - every planned RLS policy name exists in `pg_policies` for its table.
- [ ] Repeat the whole assertion set for all three fixtures (`crud-heavy`, `dashboard-heavy`, `auth-heavy`) — a loop over the three files, not three copy-pasted blocks.
- [ ] Register the new file in the **slow** bucket in `package.json` (positional path in `test:unit:slow`, and an `--exclude` in `test:unit:fast` if the file's path is not already covered by an existing exclude glob). Verify the partition with `npx vitest list --filesOnly` — fast + slow counts must equal the total.
- [ ] Run the new file with `npx vitest run <path>` and `npm run typecheck`.

**Verification:** the integration test passes against a real Postgres; the fast/slow partition is still exact (paste the counts into the report).

---

### Task 3: Orchestrator writes the generated migration into the workspace

**Files:** `packages/orchestrator/src/workflow-orchestrator.ts`, `packages/orchestrator/src/workflow-orchestrator.test.ts`.

**Seam:** `workflow-orchestrator.ts` around line 3107 already validates `step.outputContract === 'schema-plan'` with `SchemaPlanArtifactSchema` and throws on failure. Immediately after that validation succeeds (and before the `step.mutatesWorkspace` commit at ~line 3135, so the generated file lands in the same commit), write the migration file.

**Behaviour:**

- Target directory: `join(this.workspaces.workspacePath(project.id), 'supabase', 'migrations')`, created if absent (`mkdir` with `recursive: true`).
- Filename: `<YYYYMMDDHHmmss>_schema_plan.sql`, timestamp from `this.clock.now()` (never `Date.now()` — the orchestrator injects a clock and tests depend on it).
- **Skip when unchanged:** before writing, read any existing `*_schema_plan.sql` files in that directory; if the newest one's content is byte-identical to the freshly generated SQL, write nothing. A changed schema writes a new timestamped file; an applied migration is never rewritten (Global Constraints, forward-only).
- The write failing is a step failure — do not swallow the error.

**Steps:**

- [ ] Read the surrounding method (roughly `workflow-orchestrator.ts:3060-3160`) and the existing orchestrator test idioms for a workspace-mutating agent step before writing anything.
- [ ] RED: add a test to `workflow-orchestrator.test.ts` that runs an agent step with `outputContract: 'schema-plan'` and `mutatesWorkspace: true`, emitting a valid schema-plan artifact, then asserts a `supabase/migrations/*_schema_plan.sql` file exists in the workspace and its content contains the planned table's `create table if not exists public.<name>` and its `enable row level security` line. Watch it fail.
- [ ] GREEN: implement the write at the seam.
- [ ] RED→GREEN: a test proving a second identical schema-plan step writes **no** second file (directory still holds exactly one `*_schema_plan.sql`).
- [ ] RED→GREEN: a test proving a schema-plan step whose generated SQL differs writes a **second** file and leaves the first untouched.
- [ ] Run `npx vitest run packages/orchestrator/src/workflow-orchestrator.test.ts` and `npm run typecheck`.

**Verification:** the three new orchestrator tests pass; the existing orchestrator suite stays green; `npm run typecheck` exits 0.

---

### Task 4: Wire the schema step into the production workflow

**Files:** `workflows/web-app-v1.yaml`, plus whichever test asserts the workflow's shape (search for a test that loads `web-app-v1.yaml`; if none exists, add assertions to the closest workflow-loading test).

**Changes:**

1. New `schema` agent node, placed **after** `plan-approval` and **before** `task-execution`:
   - `role: planner`, `taskKind: planning`, `outputArtifact: schema.current`, `outputContract: schema-plan`, `inputArtifacts: [prd, plan.current]`, `mutatesWorkspace: true` (the orchestrator writes the generated migration into the workspace during this step — Task 3), `harnessTags: [planning, web]`, `maxAttempts: 3`, profile mirroring the `plan` node.
   - Instructions: derive the data model the approved plan requires — tables, columns, constraints in DB terms, indexes, and per-table RLS policies. Every table declares RLS explicitly. Prefer the smallest schema that satisfies the plan. Reference `auth.users` for ownership columns rather than inventing a users table.
2. New `schema-approval` approval-gate node, mirroring `plan-approval`: `artifact: schema.current`, `outputArtifact: schema.approval`, `actions: [approve, reject]`, `onReject: end`.
3. `task-execution.implement.inputArtifacts` becomes `[prd, plan.current, schema.current]`, and its instructions gain a sentence: the approved schema plan is authoritative and its migration is already generated in `supabase/migrations/` — implement against those tables, do not invent or redefine them; add a new migration only for something the schema plan does not cover.
4. `task-execution.repair.inputArtifacts` likewise gains `schema.current` (a repair agent that cannot see the schema will re-invent tables).

**Steps:**

- [ ] Read `workflows/web-app-v1.yaml` end to end and the workflow contract in `packages/contracts/src/workflow.ts` before editing — the node shape must validate.
- [ ] RED: add/extend a test asserting the loaded `web-app-v1` workflow contains a `schema` node with `outputContract: 'schema-plan'`, a `schema-approval` gate on `schema.current`, and that the `implement` and `repair` steps list `schema.current` in `inputArtifacts`. Watch it fail.
- [ ] GREEN: make the yaml changes; watch the test pass.
- [ ] Confirm nothing else hardcodes a single approval gate: `grep -rn "approval-gate\|approval" packages/orchestrator/src packages/composition/src apps/web/src --include='*.ts' --include='*.tsx' | grep -v test`. If any code assumes exactly one gate per run, report it as a BLOCKED finding rather than working around it.
- [ ] Run the touched test files and `npm run typecheck`.

**Verification:** workflow tests pass; the yaml validates against the workflow contract; report explicitly whether a second approval gate is supported by the run/UI code you inspected.

---

### Task 5: Verify the live database matches the approved schema — hard failure on drift

**Files:** `packages/domain/src/ports.ts`, `packages/platform/src/supabase-runtime.ts`, `packages/platform/package.json` (add the already-in-monorepo `postgres` dependency if the runtime has no SQL client), `packages/orchestrator/src/workflow-orchestrator.ts`, plus every fake/stub implementing `GeneratedProjectRuntime` (`packages/orchestrator/src/testing/harness.ts`, `packages/orchestrator/src/project-service.test.ts`, `packages/composition/src/*`, `packages/platform/src/supabase-runtime.test.ts` — find them all with `grep -rln "GeneratedProjectRuntime" packages apps --include='*.ts'`).

**Port addition** (one method, no options bag):

```ts
verifySchema(input: { projectId: string; tables: SchemaTable[] }): Promise<SchemaVerification>;
```

with

```ts
type SchemaVerification = {
  missingTables: string[];
  missingColumns: string[];      // "table.column"
  tablesWithoutRls: string[];
};
```

Put `SchemaVerification` wherever the other runtime result types live (`packages/contracts/src/app-environment.ts` holds `MigrationPreview`/`MigrationBackup` — follow that precedent).

**Implementation in `supabase-runtime.ts`:** connect to the project's Postgres using the runtime's existing credential/port discovery (read how the runtime learns the DB port and password today — `supabase status` JSON is authoritative, never `supabase start` output), then run three read-only queries: `information_schema.tables`, `information_schema.columns`, and `pg_class.relrowsecurity` joined to `pg_namespace` on `nspname = 'public'`. Close the connection in a `finally`. Extra tables the plan does not name are **not** a failure — an implementation task may legitimately add a helper table; the check is that everything the operator approved is really there with RLS on.

**Orchestrator wiring:** in `syncGeneratedDatabase` (`workflow-orchestrator.ts:2591`), after `applyWorkspaceMigrations` resolves, load the latest `schema.current` artifact; if present, call `verifySchema` with its tables and throw an `ExecutionError` naming every missing table, missing column, and RLS-less table when any list is non-empty. No schema artifact (a project that predates this change, or a workflow without the step) → skip silently.

**Steps:**

- [ ] Read `syncGeneratedDatabase` and its caller, plus how `supabase-runtime.ts` discovers connection details, before writing anything.
- [ ] RED: add a unit test in `packages/orchestrator/src/workflow-orchestrator.test.ts` with a fake runtime whose `verifySchema` reports a missing table, asserting the step fails with an error naming that table. Watch it fail.
- [ ] GREEN: add the port method, update every fake so `tsc -b` passes, and wire the orchestrator call.
- [ ] RED→GREEN: a test proving a clean `verifySchema` result does not fail the step, and a test proving the call is skipped when no `schema.current` artifact exists.
- [ ] Test the platform implementation against a real database at whatever level the existing `supabase-runtime` tests use — if the existing suite mocks `execa` rather than booting Supabase, follow that idiom rather than adding a new Docker-dependent test. Say in the report which level you tested at and what remains unproven.
- [ ] Run the touched test files and `npm run typecheck`.

**Verification:** orchestrator tests pass, every `GeneratedProjectRuntime` implementor compiles, `npm run typecheck` exits 0.

---

### Task 6: Docs and evidence

**Files:** `CONTEXT.md`, `docs/ARCHITECTURE.md`, `harness/stacks/supabase.md`, `docs/evidence/harness-alignment/generated-migrations.md` (new).

**Steps:**

- [ ] `CONTEXT.md`: add the term for the generated migration to the glossary, in the exact style of the neighbouring entries (read the Schema Plan entry #480 added and match it).
- [ ] `docs/ARCHITECTURE.md`: one or two lines on the seam — schema plan approved → migration generated into the workspace → applied by the existing runtime → verified by query.
- [ ] `harness/stacks/supabase.md`: state that the schema plan's migration is generated and already present; an implementation task adds a migration only for something the plan does not cover, and never redefines a planned table. Keep the existing RLS rules intact.
- [ ] `docs/evidence/harness-alignment/generated-migrations.md`: the ticket's evidence. Include the generated SQL for one fixture (crud-heavy) verbatim, and the actual query output from Task 2's integration test proving RLS is on for every table (run the test and paste real output — do not hand-write it). Follow the citation/rigor style of the existing files in that directory.
- [ ] Run `npm run format` on the touched files.

**Verification:** `npm run check:static` passes (format/lint/architecture/roadmap/typecheck).

---

## Final Verification (after all tasks, before requesting final review)

- [ ] `npm run check` — log to a file and echo the exit code; never judge it through a pipe to `tail` (project memory: a piped `tail` reports tail's status, not the command's).
- [ ] `npx vitest list --filesOnly` — fast + slow counts equal the total.
- [ ] `git diff --stat origin/main...HEAD` — no unrelated files.
