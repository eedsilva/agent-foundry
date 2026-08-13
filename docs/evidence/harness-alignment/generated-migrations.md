# Generated schema-plan migrations — #481

**Ticket:** [#481](https://github.com/eedsilva/agent-foundry/issues/481) ("Generate migrations from the schema artifact")
**What this proves:** `generateSchemaPlanSql` (`packages/contracts/src/schema-plan-sql.ts`) turns an approved
`SchemaPlan` into forward-only DDL that (a) is exactly what a fixture's plan says, byte for byte, and (b) actually
enables Row Level Security and every declared policy when applied to a real Postgres — not just asserted in a
unit test against a string.

All output below is real command output from this machine, not hand-written or reconstructed. Commands were run
from the repo root on this branch (`feat/481-schema-migrations`) on 2026-08-12.

## 1. Generated SQL for the `crud-heavy` fixture

Produced by a throwaway script (`npx tsx`, deleted immediately after — not committed) that imports
`generateSchemaPlanSql` and `SchemaPlanSchema` directly from `packages/contracts/src`, parses
[`crud-heavy/schema-plan.json`](crud-heavy/schema-plan.json) through the real Zod schema (so the input went
through the same validation the orchestrator uses, not a hand-trimmed fixture), and prints the function's
return value with no post-processing:

```
$ npx tsx .scratch-print-sql.ts
```

Verbatim stdout:

```sql
-- Generated from the approved schema plan artifact (schemaVersion 1). Forward-only; do not edit by hand.
create table if not exists public.categories ( id uuid not null default gen_random_uuid(), name text not null, description text, primary key (id) );
alter table public.categories enable row level security;
drop policy if exists authenticated_all on public.categories;
create policy authenticated_all on public.categories for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create table if not exists public.items ( id uuid not null default gen_random_uuid(), name text not null, sku text not null, category_id uuid not null, quantity integer not null default 0, reorder_threshold integer not null default 0, primary key (id), unique (sku), foreign key (category_id) references public.categories (id) on delete restrict, constraint items_quantity_non_negative check (quantity >= 0), constraint items_reorder_threshold_non_negative check (reorder_threshold >= 0) );
create index if not exists items_category_id_idx on public.items (category_id);
alter table public.items enable row level security;
drop policy if exists authenticated_all on public.items;
create policy authenticated_all on public.items for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create table if not exists public.stock_adjustments ( id uuid not null default gen_random_uuid(), item_id uuid not null, delta integer not null, reason text not null, created_at timestamptz not null default now(), created_by uuid not null, primary key (id), foreign key (item_id) references public.items (id) on delete cascade, foreign key (created_by) references auth.users (id) on delete restrict );
create index if not exists stock_adjustments_item_id_idx on public.stock_adjustments (item_id);
alter table public.stock_adjustments enable row level security;
drop policy if exists authenticated_select on public.stock_adjustments;
create policy authenticated_select on public.stock_adjustments for select using (auth.role() = 'authenticated');
drop policy if exists authenticated_insert_own on public.stock_adjustments;
create policy authenticated_insert_own on public.stock_adjustments for insert with check (auth.role() = 'authenticated' AND created_by = auth.uid());
```

Notable, reading the output against the generator source (`packages/contracts/src/schema-plan-sql.ts`):
every `create table` uses `if not exists`, every index uses `create index if not exists` /
`create unique index if not exists`, RLS is enabled unconditionally right after each table's DDL and indexes, and
every policy is preceded by its own `drop policy if exists` — the idempotence the generator claims (safe to apply
the same plan twice) is visible directly in the statement shapes, not just asserted.

## 2. RLS proof — real Postgres, both from the integration test and from a direct query

### 2a. The integration suite, run for real

[`packages/persistence/src/postgres/schema-plan-sql.integration.test.ts`](../../../packages/persistence/src/postgres/schema-plan-sql.integration.test.ts)
applies `generateSchemaPlanSql`'s output twice (idempotence) against a `testcontainers`-provisioned
`postgres:17-alpine` container for all three HA-0.1 fixtures (`crud-heavy`, `dashboard-heavy`, `auth-heavy`), then
asserts, purely by querying — never by re-reading the generator's own source — that every table exists with the
right columns/nullability, `pg_class.relrowsecurity` is `true` for every table, and every declared policy exists
in `pg_policies`.

Command:

```
$ npx vitest run packages/persistence/src/postgres/schema-plan-sql.integration.test.ts
```

Verbatim output:

```
 RUN  v3.2.7 /Users/edsilva/Documents/ed/agent-foundry/.claude/worktrees/481-schema-migrations

 ✓ packages/persistence/src/postgres/schema-plan-sql.integration.test.ts (3 tests) 6715ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  20:39:40
   Duration  9.10s (transform 394ms, setup 0ms, collect 1.77s, tests 6.71s, environment 0ms, prepare 166ms)

Exit code: 0
```

3 tests passed — one per fixture shape — each one only green because, among the other assertions, every
table in that shape's plan had `relrowsecurity = true` and every declared policy existed in `pg_policies` after
the SQL was applied twice.

### 2b. Direct query output, `crud-heavy` only

The vitest run above proves pass/fail per fixture but doesn't print the query rows themselves. A second
throwaway script (`npx tsx`, deleted immediately after — not committed) started its own `testcontainers`
Postgres, applied the AUTH_STUB + the same generated SQL from Section 1 twice, and printed the actual
`pg_class` / `pg_policies` join for `crud-heavy`'s three tables:

```
$ npx tsx .scratch-print-rls.ts
┌─────────┬─────────────────────┬────────────────┬──────────────┐
│ (index) │ table_name          │ relrowsecurity │ policy_count │
├─────────┼─────────────────────┼────────────────┼──────────────┤
│ 0       │ 'categories'        │ true           │ 1            │
│ 1       │ 'items'             │ true           │ 1            │
│ 2       │ 'stock_adjustments' │ true           │ 2            │
└─────────┴─────────────────────┴────────────────┴──────────────┘
```

`relrowsecurity: true` for all three tables, and the policy counts match the fixture exactly — `categories` and
`items` each declare one `authenticated_all` policy, `stock_adjustments` declares two (`authenticated_select`,
`authenticated_insert_own`) — see [`crud-heavy/schema-plan.json`](crud-heavy/schema-plan.json).

## Scope and caveats

- Both throwaway scripts (`.scratch-print-sql.ts`, `.scratch-print-rls.ts`) were deleted immediately after their
  output was captured into this document; they are not present on this branch. This document is the durable
  record of what they printed.
- Section 2b only queries `crud-heavy`. `dashboard-heavy` and `auth-heavy` RLS coverage is proven by the
  integration suite (Section 2a) passing for those two fixtures' `it` blocks, not by a direct query dump in this
  document — the suite's per-table `relrowsecurity`/`pg_policies` assertions (see the test source linked above)
  are the same check Section 2b prints rows for, just asserted rather than displayed.
- This document does not cover the orchestrator-side write path (`supabase/migrations/<timestamp>_schema_plan.sql`
  landing in a real project workspace) or `verifySchema`'s live-database check — those are proven by
  `packages/orchestrator/src/workflow-orchestrator.test.ts` and `packages/platform/src/supabase-runtime.test.ts`
  respectively, both unit-level with mocked I/O, not evidence-document material.
