# Schema-first path — real-mode run evidence (#529)

**Ticket:** [#529](https://github.com/eedsilva/agent-foundry/issues/529) (HA-C.3), sub-issue of epic
[#471](https://github.com/eedsilva/agent-foundry/issues/471) (HA-C).
**Design:** [ADR 0060 — Schema-first plan artifact for the generated data model](../../../adr/0060-schema-first-plan-artifact.md).
**What shipped before this:** [#480](https://github.com/eedsilva/agent-foundry/issues/480) (the schema
artifact and its gate) and [#481](https://github.com/eedsilva/agent-foundry/issues/481) /
[#519](https://github.com/eedsilva/agent-foundry/issues/519) (generating the migration from the approved
artifact — its evidence is [`../generated-migrations.md`](../generated-migrations.md)).

#529 asked for one real-mode run proving the schema-first path end to end against a live Supabase stack:
the schema artifact reviewed before implementation, the migration generated from the approved artifact,
RLS active on every generated table verified by query against the running stack rather than by reading
the migration, and the destructive-migration approval gate exercised rather than inspected.

There were **two** real-mode runs. The first one failing is the most valuable thing in this ticket: it
showed that the schema-first feature shipped in #481 could not apply its own generated migration in any
real run. That is exactly why #529 was filed as a live-stack ticket instead of accepting #519's
integration test as sufficient — #519 applies `generateSchemaPlanSql`'s output straight to a
testcontainers Postgres and never goes through `migrate`, so the defect was invisible to it.

## Method

Both runs used the same command; only `--data-dir` differed.

```
RUN_REAL_TRACER=true \
EXECUTOR_MODE=real \
CODEX_DEFAULT_MODEL=gpt-5.6-luna \
CLAUDE_FAST_MODEL=claude-haiku-4-5-20251001 \
npx tsx scripts/tracer.ts --scenario toy --approve-gates --executor-mode real \
  --data-dir <DATA_DIR>
```

Scenario `examples/tracer/scenarios/toy.json` (the Counter app), workflow `web-app-v1`.
`--approve-gates` is the `runTracerScenarioToCompletion` driver added by
[#509](https://github.com/eedsilva/agent-foundry/issues/509) (see
[`../ui-quality-judge-real-run-509/README.md`](../ui-quality-judge-real-run-509/README.md)); it
auto-approves every operator gate the run parks at, recorded as `decidedBy: 'tracer-driver'`.

| | Run 1 | Run 2 |
|---|---|---|
| Code | `d0ef9ab` (branch base, before the fix) | `43aae94` (after the fix) |
| Project | `01KZWPC2R7C26NE2SER2SC4QZJ` | `01KZWVNGD4RM32PXWKEJXS69N6` |
| Run | `01KZWPC2R8K31R6MHWBWQ0ZBXB` | `01KZWVNGD5XQY7GYMAMNAV585Q` |
| Started | `2026-08-13T04:36:03Z` | `2026-08-13T06:08:01Z` |
| Terminal state | `project.failed` `05:04:24Z` | `project.failed` `06:52:27Z` |

Host: claude CLI 2.1.229, codex CLI 0.146.1, supabase CLI 2.62.5, node v22.22.3.
`EXECUTOR_MODE=real npm run doctor -- --json` before run 1 probed `codex` → `ready` (0.146.1) and
`claude` → `ready` (2.1.229). Both `DATA_DIR`s were pinned outside the worktree so run artifacts could
not be committed by accident; they are scratch directories and will not survive. This document and the
four files beside it are the durable record.

## Run 1 — the defect

The schema gate behaved exactly as ADR 0060 specifies. From the run's `events.jsonl`:

| Time (UTC) | Event | Node |
|---|---|---|
| `04:41:22.544` | `node.completed` | `plan-approval` |
| `04:43:29.253` | `node.completed` | `schema` |
| `04:43:29.394` | `run.approval_requested` | `schema-approval` |
| `04:43:29.944` | `run.approval_decided` — "Operator schema approval approved." | `schema-approval` |
| `04:43:29.950` | `artifact.created` — `schema.approval` revision 1 | `schema-approval` |
| `04:43:30.001` | `task.started` — T1 | `task-execution` |

The approval event records what it reviewed: `reviewedArtifact` `schema.current` revision 1, sha256
`a2364de4a61d68aff1fc04ed7c02801d2d27e6b2cb75276c0b3cdae4e88f3880`. The schema node's own summary read
"Derived the minimal data model the approved Counter plan requires: one new table, public.counter …".
The first implementation task started 0.06s after the gate closed, and no implementation task ran before
it.

`writeSchemaPlanMigration` then wrote and committed `supabase/migrations/20260813044329_schema_plan.sql`
into the project workspace — [`run1-schema-plan.sql`](run1-schema-plan.sql) in this directory.

Tasks T1–T4 ran. At T4's browser check, `syncGeneratedDatabase` copied the workspace migrations into the
environment workdir and called `migrate`, which threw:

```
2026-08-13T05:04:24.682Z task.failed   T4 attempt 1/2 failed: Destructive migration requires approval and verified backup.
2026-08-13T05:04:24.833Z project.failed                       Destructive migration requires approval and verified backup.
```

The cause is in the generated migration itself. `generateSchemaPlanSql` emits a
`drop policy if exists <policy> on <table>;` before each `create policy` so that re-applying a plan is
idempotent. `destructiveStatements` matched any statement starting with `/^DROP\b/i`, so every generated
schema-plan migration was classified destructive; `migrate` then called `requireMigrationApproval`; and
the orchestrator applies workspace migrations with no approval argument
(`syncGeneratedDatabase` in `packages/orchestrator/src/workflow-orchestrator.ts`), so it failed closed.
`verifySchema` never ran.

Querying run 1's live stack directly afterwards confirmed nothing from the run had reached the database:
tables in `public` were `storage_uploads|t` only, policies were
`storage_uploads|storage_upload_owner_select` only, and `supabase_migrations.schema_migrations` held
`00000000000000` only — the scaffold baseline, untouched.

This is the first half of defect #1 in [`../defect-list.md`](../defect-list.md) (HA-0.1), which called
out `DROP POLICY IF EXISTS` explicitly. The second half of that defect — the `.migrate()` approval path
existing at the platform layer but never wired into the workflow's gate system — is still open, and it
is what stops both runs described here.

**A separate defect, recorded and not fixed here:** `implement.T2`'s agent returned `status: 'blocked'`
— every command it needed (`pnpm db:types`, `pnpm typecheck`, `supabase --version`,
`docker exec … psql`) was refused by the session's Bash permission policy — and yet `verify-task.T2`
approved and `task.completed` fired. Filed separately; it is not a schema-first defect.

## The fix

A policy *replace* — `drop policy if exists X on T` re-created by `create policy X on T` later in the
**same** migration, for the same policy name and table — is no longer classified destructive. Everything
else that was destructive still is: every other `DROP`, `TRUNCATE`, `DELETE FROM` and
`ALTER TABLE … DROP COLUMN`; an unpaired `drop policy`; and a create-then-drop, which is a net removal,
so order matters.

Any migration containing dollar quoting (`$$`, `$tag$`) forfeits the exemption entirely and keeps its
pre-#529 classification. That is a deliberate fail-closed ceiling, recorded as a `ponytail:` comment in
the source, because the statement scanner does not parse dollar-quoted bodies and an earlier attempt to
teach it to do so opened two new fail-open vectors.

Commits on this branch, in order:

| Commit | Change |
|---|---|
| `b652edb` | policy-replace exemption + tests |
| `424a3fd` | dollar-quote scanner — later reverted |
| `1769a1c` | revert the scanner; guard the exemption on dollar quoting instead |
| `43aae94` | widen the dollar-tag regex to `/\$[^\s$]*\$/`, so non-ASCII Postgres tags like `$é$` cannot launder a drop |

`sqlStatements` is byte-identical to its pre-#529 form — sha256 of the extracted function body
`45107393c9381063` at `d0ef9ab`, at `b652edb` and at `43aae94`. Tests:
`npx vitest run packages/platform/src/supabase-runtime.test.ts` 60/60 and
`packages/platform/src/security-lint.test.ts` 14/14 (74 together); `npx tsc -b` exit 0.

## Run 2 — the evidence run

Same command, code at `43aae94`. The schema gate again preceded implementation:

| Time (UTC) | Event | Node |
|---|---|---|
| `06:15:52.839` | `node.started` | `schema` |
| `06:18:08.703` | `artifact.created` — `schema.current` revision 1 | `schema` |
| `06:18:08.739` | `node.completed` | `schema` |
| `06:18:08.819` | `run.approval_requested` | `schema-approval` |
| `06:18:09.175` | `run.approval_decided` — "Operator schema approval approved." | `schema-approval` |
| `06:18:09.180` | `artifact.created` — `schema.approval` revision 1 | `schema-approval` |
| `06:18:09.207` | `task.started` — T1 | `task-execution` |

The approval reviewed `schema.current` revision 1, sha256
`f91361a74e6020e8228ba77ff9126ec9c62bd922aae67180237cded3e84b5060`, and produced `schema.approval`
revision 1, sha256 `1ca42720456b03b4cdef3bd89551f0991b71e29473b27b263cbc0f4a5351d7f3`.

`20260813061809_schema_plan.sql` was generated from that approved artifact and committed —
[`run2-schema-plan.sql`](run2-schema-plan.sql). It contains the `drop policy if exists` /
`create policy` pair, and under the fix it yields **zero** destructive statements (transcript section 1
below).

The run still failed, and this time correctly. T1's own agent-authored migration
`20260813062500_counter.sql` — [`run2-counter-agent-authored.sql`](run2-counter-agent-authored.sql) —
ends with `drop table public.items;`, removing the scaffold's demo table. That is genuinely destructive,
and the gate is right to refuse it without an operator approval:

```
2026-08-13T06:52:27.633Z task.failed   T3 attempt 1/2 failed: Destructive migration requires approval and verified backup.
2026-08-13T06:52:27.782Z project.failed                       Destructive migration requires approval and verified backup.
```

`migrate` refuses the whole pending batch, not the offending file, so the artifact-derived migration did
not apply either. The live database immediately after the run held only `storage_uploads`, at applied
version `00000000000000`.

## The transcript — criteria 2, 3, 4 (and 5 again)

Criteria 2, 3 and 4 could not be closed by the run itself, because the run could not get past the
unwired approval path. They were closed instead by a scripted invocation of the **production** apply and
verify path, run from the worktree root against run 2's still-live stack, with run 2's own approved
artifact and its own generated migration. **This is not the orchestrator doing it inside the run.** The
script calls only production entry points —
`SupabaseGeneratedProjectRuntime.applyWorkspaceMigrations` with no approval argument, exactly as
`syncGeneratedDatabase` calls it; `.verifySchema`; the exported `destructiveStatements`; and
`FileArtifactStore` to load `schema.current` through `SchemaPlanArtifactSchema` — but the sequencing is
the script's, not a run's. The script was deleted after its output was captured and is not committed.

The full raw output is [`run2-transcript.txt`](run2-transcript.txt) (110 lines, exit 0). #529's brief
asked for the RLS verification and the destructive-gate transcript as two files; they were produced by
one script in one pass, so they are committed as that single transcript. Its sections:

- **`## 0. STATE BEFORE`** — the live stack as run 2 left it: `storage_uploads|t` only, one policy,
  applied version `00000000000000`.
- **`## 1. GATE — batch refused as the run left it`** — per-file `destructiveStatements`, then
  `applyWorkspaceMigrations` on the batch as the run left it.
- **`## 2. APPLY — the artifact-derived migration alone`** — the agent's destructive file moved aside,
  then `applyWorkspaceMigrations` again.
- **`## 3. VERIFY — verifySchema green + RLS by query`** — `verifySchema`, then independent raw SQL
  against `pg_class`, `pg_policies` and `information_schema.columns`.
- **`## 4. RESTORE + GATE AGAIN`** — the file restored, the gate re-fired, the workspace left as found.

The `pruned stale unapplied environment copy:` lines in sections 1 and 2 are the script removing
migration files that the crashed run's own copy loop had already staged into the environment migrations
directory. Without that, `applyWorkspaceMigrations` no-ops on a retry after a crashed run, because its
freshness check compares filenames already present in that directory. That is a third defect, found by
this work and filed separately; it is not part of the schema-first path.

## Acceptance criteria, one by one

| # | Criterion | Verdict |
|---|---|---|
| 1 | A real-mode run reaches a terminal state with `schema` → `schema-approval` before any implementation task, artifacts retained | **Met** — in both runs |
| 2 | The applied migration is the one generated from the approved artifact | **Met, with a caveat** — applied by a scripted invocation of the production apply path, not by the orchestrator in-run |
| 3 | `relrowsecurity` true for every generated table and ≥1 matching `pg_policies` row per table, queried against the live stack | **Met** |
| 4 | `verifySchema` green against that live stack | **Met**, same caveat as 2 |
| 5 | Destructive-migration gate demonstrated in a real run, with the block recorded | **Met** — twice, and organically |

**Criterion 1.** Both runs reached a terminal state (`project.failed`), and in both the `schema` node
completed and `schema-approval` was decided before the first `task.started` — see the two timelines
above. Artifacts (`schema.current`, `schema.approval`, the decision log) were written and are recorded in
`events.jsonl` with their sha256s.

**Criterion 2.** `20260813061809_schema_plan.sql` was generated from `schema.current` revision 1 as
approved, and committed by the orchestrator during the run under
`supabase/migrations/*_schema_plan.sql`, as the ticket requires. Transcript section 2 shows
`applyWorkspaceMigrations` applying it for real: after the call,
`supabase_migrations.schema_migrations` holds `00000000000000`, `20260726000000` and `20260813061809` —
the last being this migration. The caveat is the sequencing: the orchestrator itself never got to apply
it, because the batch also contained the agent's `drop table`.

**Criterion 3.** Transcript section 3, raw SQL, not `verifySchema`'s own report:

```
     relname     | relrowsecurity
-----------------+----------------
 counter         | t
 items           | t
 storage_uploads | t
(3 rows)
    tablename    |         policyname          |  cmd   |                   qual
-----------------+-----------------------------+--------+------------------------------------------
 counter         | counter_select_public       | SELECT | true
 ...
(6 rows)
```

`counter` is the only table the approved schema plan generates; `items` and `storage_uploads` come from
the scaffold's `20260726000000_rls_baseline.sql`. `counter` has `relrowsecurity = t` and exactly the one
policy the artifact declares, `counter_select_public` for `SELECT` with qualifier `true`. Its columns
match the artifact too: `counter.id integer NO`, `counter.value integer NO`,
`counter.updated_at timestamp with time zone NO`.

**Criterion 4.** Transcript section 3, from `verifySchema` against the live stack, loading
`schema.current` revision 1 (tables: `counter`) through the real artifact schema:

```
verifySchema result: {
  "missingTables": [],
  "missingColumns": [],
  "mismatchedColumns": [],
  "tablesWithoutRls": [],
  "missingPolicies": []
}
```

All five drift lists empty — tables, columns, type, nullability, RLS, policy names.

**Criterion 5.** Demonstrated twice, and both times by a real run rather than a contrived input:

- Run 1 blocked on a **false positive** — the generator's own idempotent `drop policy if exists`. That
  block is recorded at `05:04:24Z` above, and it is what this branch fixes.
- Run 2 blocked on a **genuine** destructive change an implementation agent authored,
  `drop table public.items;`, recorded at `06:52:27Z` above.

Transcript section 1 shows the classification per file and the block, and section 4 shows it firing
again identically after the file is restored:

```
  20260726000000_rls_baseline.sql: (none)
  20260813061809_schema_plan.sql: (none)
  20260813062500_counter.sql: drop table public.items
  ...
error constructor: ValidationError
error message: Destructive migration requires approval and verified backup.
```

The generated schema-plan migration contributes no destructive statement; the agent's `drop table` does.

## What this evidence does not show

- **A real run completing end to end with the orchestrator applying the schema-plan migration itself.**
  Neither run got there. This is blocked by the second half of defect #1 in
  [`../defect-list.md`](../defect-list.md) — the platform-layer approval path is never wired into the
  workflow's gate system, so a destructive migration is an unrecoverable `ValidationError` rather than an
  operator gate. Tracked separately; not fixed by this branch.
- **Criteria 2 and 4 by an in-run code path.** They rest on a scripted invocation of the production
  functions, described above. The alternative was re-rolling real runs until an implementation agent
  happened not to author a legitimate `drop` — which the harness cannot currently pass at all.
- **More than one generated table.** The `toy` scenario's plan declares a single table with a single
  policy, so criterion 3's "every generated table" is one table. Broader shapes
  (`crud-heavy`, `dashboard-heavy`, `auth-heavy`) are covered only at integration level by #519 — see
  [`../generated-migrations.md`](../generated-migrations.md) — not on a live Supabase stack.
- **Anything about a completed app.** Both runs failed before full-suite verification, release
  assessment or diff approval. No claim is made here about the generated Counter app working.
- **The destructive-migration gate for a mixed dollar-quoted migration.** The fix deliberately declines
  the policy-replace exemption for any migration containing dollar quoting; run 2's agent-authored
  migration does contain a `$$` body, and it was refused on its `drop table`, which is correct but does
  not exercise the dollar-quote ceiling on its own.

## Files in this directory

| File | What it is |
|---|---|
| [`run1-schema-plan.sql`](run1-schema-plan.sql) | Run 1's `20260813044329_schema_plan.sql`, generated from its approved artifact |
| [`run2-schema-plan.sql`](run2-schema-plan.sql) | Run 2's `20260813061809_schema_plan.sql`, same |
| [`run2-counter-agent-authored.sql`](run2-counter-agent-authored.sql) | Run 2 T1's own `20260813062500_counter.sql` — the agent-authored migration whose `drop table public.items;` the gate refused |
| [`run2-transcript.txt`](run2-transcript.txt) | The raw transcript: state before, gate, apply, verify, restore + gate again |
| `.gitattributes` | Exempts the transcript from whitespace checks — psql pads its columns with trailing spaces, and the transcript is committed exactly as captured |
