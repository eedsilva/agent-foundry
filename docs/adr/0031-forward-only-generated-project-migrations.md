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

## Validation and rollback

Adapter tests cover preview detection, schema-plus-data backup creation and provenance, changed SQL/backup rejection, batch approval, and the absence of `migration down`. Roll back application code only when it remains compatible with the current schema. Otherwise roll forward the application or explicitly restore the chosen backup while the project is stopped.
