# ADR 0031: Forward-only generated-project migrations

- Status: Accepted
- Date: 2026-07-23
- Owners: Platform, Core
- Extends: ADR 0030

## Context

Generated projects need SQL changes without silently losing local Supabase/Postgres data. Issue #69 already gives every generated project an isolated Supabase CLI workdir and Postgres runtime. Issue #70 adds review and destructive-change gates to that existing boundary.

## Decision

Migrations are contained files under `supabase/migrations/*.sql` and run only with `supabase migration up`. Before applying, operators review a preview with its SHA-256 checksum and detected destructive statements. The detector removes comments, splits statements, and flags `DROP`, `TRUNCATE`, `DELETE FROM`, and `ALTER TABLE ... DROP COLUMN`; it is a gate, not a full SQL parser.

For a destructive batch, operators first create a local combined artifact: a schema dump plus a data-only dump, concatenated into the requested contained backup path. Its combined, schema, and data SHA-256 values, timestamp, and generated manifest identify the backup. Apply requires approval matching every destructive migration checksum and that untampered generated manifest/artifact from the last 24 hours.

No down-migration API, automatic restore, or automatic data restore exists. An incompatibility is remediated by an application roll-forward or an operator's explicit restore of a selected backup.

## Consequences

Non-destructive migrations keep the normal forward apply path. Destructive batches require review, a fresh verified combined backup, and approval before the single `migration up` command runs. The gate intentionally remains conservative; unusual destructive SQL may need an operator review even when not detected.

## Amendment (2026-08-13, #529)

One documented exception is carved into the detector's rule list. A `DROP POLICY` that a *later* statement in the *same* migration re-creates with a `CREATE POLICY` for the same policy name and table is a replace, not a removal: it destroys no data and the table is never left unprotected once applied. It does not require approval. This is what unblocked the schema-first path — `generateSchemaPlanSql` emits `drop policy if exists <policy> on <table>;` before each `create policy` so a plan re-applies idempotently, and under the pre-amendment rule every generated schema-plan migration was classified destructive and failed closed in a real run.

Everything else stays as it was: every other `DROP`, `TRUNCATE`, `DELETE FROM` and `ALTER TABLE ... DROP COLUMN`; an unpaired `DROP POLICY`; and a create-then-drop, which is a net removal, so order matters. Identifiers are compared the way Postgres resolves them — unquoted folded to lower case, quoted taken verbatim — and an unqualified table resolves to `public`.

A migration containing dollar quoting (`$$`, `$tag$`) forfeits the exemption wholesale and keeps its pre-amendment classification, because the statement scanner does not parse dollar-quoted bodies and would otherwise read a `CREATE POLICY` that never executes as a real re-creation.

Two consequences worth recording. The exemption matches policy name and table only, never the command or the qualifier, so a replace that changes a policy's predicate passes unreviewed; creating a permissive policy was never gated in the first place, so this adds no exposure the gate previously prevented. And `destructiveStatements` also feeds the security linter (`packages/platform/src/security-lint.ts`), so its `destructive-migration` finding likewise goes silent for a policy replace.

Follow-up: [#538](https://github.com/eedsilva/agent-foundry/issues/538) asks the wider question this exception raises — classify by what a statement destroys rather than by the `DROP` keyword, so the exception falls out of the rule instead of sitting beside it.

Evidence: [`docs/evidence/harness-alignment/schema-first/`](../evidence/harness-alignment/schema-first/README.md), issue [#529](https://github.com/eedsilva/agent-foundry/issues/529).

## Amendment (2026-08-13, #535)

The approval contract above was never wired into a real run: `syncGeneratedDatabase` called `applyWorkspaceMigrations` with no `approval` argument and no workflow node raised a gate for a pending destructive migration, so a destructive batch hard-failed the run (`project.failed`) with no recovery path — the review-and-backup contract existed only as an unreachable code path.

The orchestrator now parks the run at an approval gate the same way the static `plan-approval`/`schema-approval` workflow nodes do, built from the same StepRun/ApprovalRequest/ApprovalDecision machinery but keyed off a synthetic node id (since the gate fires mid-step rather than as a declared graph node). Approving builds the backup and applies with `migrate()` directly; rejecting ends the run. The operator-visible message names the offending file and statement and states that the whole pending batch is held, not just those files.

Evidence: issue [#535](https://github.com/eedsilva/agent-foundry/issues/535).

## Validation and rollback

Adapter tests cover preview detection, schema-plus-data backup creation and provenance, changed SQL/backup rejection, batch approval, and the absence of `migration down`. Roll back application code only when it remains compatible with the current schema. Otherwise roll forward the application or explicitly restore the chosen backup while the project is stopped.
