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
`claude` → `ready` (2.1.229). Both `DATA_DIR`s were scratch directories outside the worktree and are
gone; every value this document quotes was copied out of them into the committed files listed below
before they were discarded.

### Committed sources

Every timeline row, event name, decision string and sha256 below is checkable against a file in this
directory.

`run1-events.jsonl` and `run2-events.jsonl` are **filtered excerpts** of each run's `events.jsonl`,
copied line-for-line (not re-serialised, not reformatted) and kept in original order — 29 of run 1's
85 lines and 29 of run 2's 87. The filter was:

```
grep -E '"nodeId":"(plan-approval|schema|schema-approval)"|"type":"(project\.started|project\.failed|task\.failed)"|"dedupeKey":"[^"]*:task:task-execution:T[12]:|"type":"agent\.completed","createdAt":"[^"]+","nodeId":"implement\.T[12]"' \
  <DATA_DIR>/projects/<PROJECT_ID>/events.jsonl
```

— every event on the `plan-approval`, `schema` and `schema-approval` nodes; every `task.started`,
`quality.approved` and `task.completed` for T1 and T2, and each of those two tasks' own
`agent.completed`; plus `project.started` and the terminating `task.failed` and `project.failed`.

`run1-schema-current.json`, `run1-schema-approval.json`, `run2-schema-current.json` and
`run2-schema-approval.json` are the **content** of revision 1 of each artifact, taken from
`<DATA_DIR>/projects/<PROJECT_ID>/artifacts/<name>/000001.json` (the artifact store keeps one file per
revision under a directory per artifact name; each file wraps `metadata` around `content`). They are
committed as the exact byte string the store hashes — `JSON.stringify(content)`, compact, no trailing
newline — so `shasum -a 256 <file>` reproduces the sha256 quoted in this document and in the
`artifact.created` event. They read best through `python3 -m json.tool <file>`.

## Run 1 — the defect

The schema gate behaved exactly as ADR 0060 specifies. From the run's `events.jsonl`
([`run1-events.jsonl`](run1-events.jsonl)):

| Time (UTC) | Event | Node |
|---|---|---|
| `04:41:22.544` | `node.completed` | `plan-approval` |
| `04:43:29.253` | `node.completed` | `schema` |
| `04:43:29.394` | `run.approval_requested` | `schema-approval` |
| `04:43:29.944` | `run.approval_decided` — "Operator schema approval approved." | `schema-approval` |
| `04:43:29.950` | `artifact.created` — `schema.approval` revision 1 | `schema-approval` |
| `04:43:30.001` | `task.started` — T1 | `task-execution` |

The approval event records what it reviewed: `reviewedArtifact` `schema.current` revision 1, sha256
`a2364de4a61d68aff1fc04ed7c02801d2d27e6b2cb75276c0b3cdae4e88f3880` —
[`run1-schema-current.json`](run1-schema-current.json), and the approval it produced is
[`run1-schema-approval.json`](run1-schema-approval.json), sha256
`e6e119a05483a586a24cda940054d89cac84530dedda7fe075436e7cc22d11af`. The schema node's own summary read
"Derived the minimal data model the approved Counter plan requires: one new table, public.counter …".
The `schema-approval` node completed at `04:43:29.962` and the first implementation task started
0.04s later, at `04:43:30.001`; no implementation task ran before it.

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

Unlike run 2's equivalent state, which is committed as section 0 of the transcript, this one is
recorded here from the session that ran it and has no committed capture: run 1's stack was stopped to
free Docker resources before run 2 started, so those queries can no longer be repeated.

This is the first half of defect #1 in [`../defect-list.md`](../defect-list.md) (HA-0.1), which called
out `DROP POLICY IF EXISTS` explicitly. The second half of that defect — the `.migrate()` approval path
existing at the platform layer but never wired into the workflow's gate system — is still open as
[#535](https://github.com/eedsilva/agent-foundry/issues/535), and it is what stops both runs described
here.

**A separate defect, recorded and not fixed here
([#537](https://github.com/eedsilva/agent-foundry/issues/537)):** `implement.T2`'s agent returned
`status: 'blocked'` at `04:51:22.326` — every command it needed (`pnpm db:types`, `pnpm typecheck`,
`supabase --version`, `docker exec … psql`) was refused by the session's Bash permission policy — and
yet `quality.approved` fired for T2 at `04:51:27.857` and `task.completed` at `04:51:28.160`. All three
events are in [`run1-events.jsonl`](run1-events.jsonl). It is not a schema-first defect.

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

Identifiers are matched the way Postgres resolves them: an unquoted identifier folds to lower case, a
quoted one is taken verbatim. So `P` and `p` are the same policy, `"p"` and `p` are the same policy,
and `"P"` and `p` are **not** — a drop of `"P"` that only `p` re-creates stays destructive.

The rule change is not local to `migrate`. `destructiveStatements` is also what
`packages/platform/src/security-lint.ts` uses, so the linter's `destructive-migration` finding now goes
silent for a policy replace too. That is intended — the same statement pair is not a data loss in
either caller — but it is a second, quieter place the classification moved.

The exception is written into ADR 0031 as an amendment ("Amendment (2026-08-13, #529)").

Commits on this branch, in order:

| Commit | Change |
|---|---|
| `b652edb` | policy-replace exemption + tests |
| `424a3fd` | dollar-quote scanner — later reverted |
| `1769a1c` | revert the scanner; guard the exemption on dollar quoting instead |
| `43aae94` | widen the dollar-tag regex to `/\$[^\s$]*\$/`, so non-ASCII Postgres tags like `$é$` cannot launder a drop |
| `f9b5761` | collapse the two destructive-filter paths into one |
| `917b37d` | fold policy identifiers the way Postgres does, so a quoted `"P"` no longer pairs with an unquoted `p` |

`sqlStatements` is byte-identical to its pre-#529 form. Reproduce with:

```
for ref in d0ef9ab b652edb 43aae94 HEAD; do
  git show $ref:packages/platform/src/supabase-runtime.ts \
    | awk '/^export function sqlStatements/,/^}$/' | shasum -a 256
done
```

— `b2d1356281934c7ace21d101837000ba293326ebd328c4b5875b1371500a3f00` at every one. Tests:
`npx vitest run packages/platform/src/supabase-runtime.test.ts` 62/62 and
`packages/platform/src/security-lint.test.ts` 14/14 (76 together); `npx tsc -b` exit 0.

## Run 2 — the evidence run

Same command, code at `43aae94`. The schema gate again preceded implementation
([`run2-events.jsonl`](run2-events.jsonl)):

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
`f91361a74e6020e8228ba77ff9126ec9c62bd922aae67180237cded3e84b5060`
([`run2-schema-current.json`](run2-schema-current.json)), and produced `schema.approval` revision 1,
sha256 `1ca42720456b03b4cdef3bd89551f0991b71e29473b27b263cbc0f4a5351d7f3`
([`run2-schema-approval.json`](run2-schema-approval.json)).

`20260813061809_schema_plan.sql` was generated from that approved artifact and committed —
[`run2-schema-plan.sql`](run2-schema-plan.sql). It contains the `drop policy if exists` /
`create policy` pair, and under the fix it yields **zero** destructive statements (transcript section 1
below).

The run still failed, and this time correctly. T1's own agent-authored migration
`20260813062500_counter.sql` — [`run2-counter-agent-authored.sql`](run2-counter-agent-authored.sql) —
ends with `drop table public.items;`, removing the scaffold's demo table. (The `062500` in that
filename is a name the agent chose, not a write time: T1 completed at `06:23:32`, and its
`agent.completed` at `06:23:25` in [`run2-events.jsonl`](run2-events.jsonl) names
`supabase/migrations/20260813062500_counter.sql` as one of the two deliverables it wrote.) That is genuinely destructive,
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
the script's, not a run's.

The script is [`run2-transcript-script.ts`](run2-transcript-script.ts) in this directory. It is a
one-off capture tool, not part of the build or the test suite, and it needs a live Supabase stack for
the project it is pointed at — run 2's stack is long gone, so re-running it means reproducing a run
first. It was invoked from the worktree root as:

```
npx tsx docs/evidence/harness-alignment/schema-first/run2-transcript-script.ts \
  <DATA_DIR> 01KZWVNGD4RM32PXWKEJXS69N6
```

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
this work and filed as [#536](https://github.com/eedsilva/agent-foundry/issues/536); it is not part of
the schema-first path.

## Acceptance criteria, one by one

| # | Criterion | Verdict |
|---|---|---|
| 1 | A real-mode run reaches a terminal state with `schema` → `schema-approval` before any implementation task, artifacts retained | **Met** — in both runs |
| 2 | The applied migration is the one generated from the approved artifact | **Met, with a caveat** — applied by a scripted invocation of the production apply path, not by the orchestrator in-run |
| 3 | `relrowsecurity` true for every generated table and ≥1 matching `pg_policies` row per table, queried against the live stack | **Met** |
| 4 | `verifySchema` green against that live stack | **Met**, same caveat as 2 |
| 5 | A destructive change is proposed and blocked pending approval in a real run, with the block recorded | **Met for "blocked", not for "pending"** — blocked twice, organically, in two real runs; but nothing was left pending, because there is no approval gate to park at ([#535](https://github.com/eedsilva/agent-foundry/issues/535)) |

**Criterion 1.** Both runs reached a terminal state (`project.failed`), and in both the `schema` node
completed and `schema-approval` was decided before the first `task.started` — see the two timelines
above. Artifacts (`schema.current`, `schema.approval`, the decision log) were written and are recorded in
`events.jsonl` with their sha256s; both runs' `schema.current` and `schema.approval` contents and the
filtered event excerpts are committed here (see "Committed sources"), so the retention is in the repo
rather than in a scratch `DATA_DIR`.

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

**Criterion 5.** The *block* is demonstrated twice, both times by a real run rather than a contrived
input. The *pending* half of the criterion is not met and cannot be, on today's code:

- Run 1 blocked on a **false positive** — the generator's own idempotent `drop policy if exists`. That
  block is recorded at `05:04:24Z` above, and it is what this branch fixes.
- Run 2 blocked on a **genuine** destructive change an implementation agent authored,
  `drop table public.items;`, recorded at `06:52:27Z` above.

Neither block left anything pending. `migrate` raises a `ValidationError`, the task fails its attempt
and the run goes to `project.failed`; there is no operator gate to park at and nothing to approve,
because the platform-layer approval path is never wired into the workflow's gate system. That is
[#535](https://github.com/eedsilva/agent-foundry/issues/535) — the second half of defect #1 in
[`../defect-list.md`](../defect-list.md) — and it is not fixed by this branch.

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
  operator gate. Tracked as [#535](https://github.com/eedsilva/agent-foundry/issues/535); not fixed by
  this branch.
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
| [`run2-transcript-script.ts`](run2-transcript-script.ts) | The one-off capture tool that produced that transcript — not part of the build or the test suite |
| [`run1-events.jsonl`](run1-events.jsonl) / [`run2-events.jsonl`](run2-events.jsonl) | Filtered, byte-preserving excerpts of each run's `events.jsonl` — see "Committed sources" |
| [`run1-schema-current.json`](run1-schema-current.json) / [`run2-schema-current.json`](run2-schema-current.json) | The `schema.current` revision 1 content each run's approval reviewed |
| [`run1-schema-approval.json`](run1-schema-approval.json) / [`run2-schema-approval.json`](run2-schema-approval.json) | The `schema.approval` revision 1 content each approval produced |
| `.gitattributes` | Exempts the transcript from whitespace checks — psql pads its columns with trailing spaces, and the transcript is committed exactly as captured |
