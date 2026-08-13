# ADR 0064: Destructive migrations classified by effect, not by the DROP keyword

- Status: Accepted
- Date: 2026-08-13
- Owners: Core, Security
- Tracked by issue #538

## Context

`destructiveStatements()` (`packages/platform/src/supabase-runtime.ts`) feeds
two consumers: the runtime's migration approval gate
(`MigrationApprovalRequiredError`, whose message demands "approval and
verified backup") and `security-lint`'s `destructive-migration` rule
(ADR-0036), which reuses the same detector verbatim.

It classified by opening keyword: anything matching `^DROP\b` was destructive.
Policies have no `create or replace`, so `generateSchemaPlanSql` emits
`drop policy if exists X on T;` before each `create policy` for idempotence —
and the classifier read that as data loss. A real schema-first run (#529) died
on it.

#529 fixed it narrowly: a `DROP POLICY` was exempt only when a *later*
statement re-created that same policy on that same table, and only when the
migration contained no dollar quoting. That bought correctness for the
generator's exact output with ~50 lines of pairing state, four regexes and
three recorded ceilings — and three of its four fix commits went on closing
ways to smuggle a `create policy` past the pair-matcher.

## Decision

**Classify by what a statement destroys.** In
`packages/platform/src/supabase-runtime.ts`, `destructivePatterns` becomes
five stateless regexes over `sqlStatements(sql)`, with no cross-statement
state:

1. `DROP POLICY` leaves the list unconditionally. In the permissive case —
   the default, and all `generateSchemaPlanSql` emits — RLS with zero policies
   is deny-all, not allow-all, so dropping a policy removes access. It
   destroys no data, and a "verified backup" was never a remedy for it. See
   Consequences for the restrictive case, which is not this benign.

2. `alter table … disable row level security` **joins** the list. That is the
   statement that actually exposes data, and it matched nothing before — not
   the gate, and not `security-lint`, whose `ENABLE_RLS_RE` only tracks
   enables, so a later migration disabling RLS leaves the table's `rlsEnabled`
   record stale-true and raises no `missing-rls` finding. No backup undoes an
   exposure, but approval is the right control for it.

The `DROP` pattern's negative lookahead must stay inside `\b(?!\s+POLICY\b)`
rather than following a consuming `\s+` — the reason is recorded at the regex
itself, where someone would otherwise "simplify" it.

## Alternatives considered

- **Keep #529's pairing.** Rejected: state, regexes and three known ceilings
  buying operator visibility of a statement that cannot lose data. It also
  does not generalise — triggers have the same no-idempotent-create shape as
  policies, so trigger generation would arrive needing its own carve-out.
- **Exempt `DROP POLICY` without adding `DISABLE ROW LEVEL SECURITY`.**
  Rejected by the repo owner's explicit call: removing the only signal that
  touches RLS while the genuinely exposing statement stays unmatched by both
  the gate and the lint is a net regression, and the addition is one regex.
- **Make the generator emit policies idempotently** with a catalog-guarded
  `do $$ … $$` block and no drop. Rejected, and noted as a trap: the natural
  shape uses dollar quoting, which tripped #529's own `DOLLAR_QUOTED` guard
  and reopened the original failure for that migration.

## Consequences

- Positive: `generateSchemaPlanSql` output classifies non-destructive by
  construction rather than by a pairing coincidence, so the schema-first path
  no longer depends on statement ordering or on the migration avoiding `$…$`
  (a migration containing `values($1,$2)` used to forfeit the exemption).
- Positive: the laundering surface is gone. With nothing paired, there is
  nothing to smuggle past a matcher.
- Positive: an RLS disable now blocks the gate and raises a
  `destructive-migration` finding, closing a real exposure that had no control
  at all.
- Negative / accepted: an operator no longer sees a `DROP POLICY` in the
  approval prompt, and a migration that removes a policy without replacing it
  applies without approval. `verifySchema` fails when a policy the approved
  schema plan declares is missing, but does not cover a policy the plan never
  declared.
- **Negative / accepted, and the sharp edge of this decision: a RESTRICTIVE
  policy drop is exempt too, and that one widens access.** Postgres composes
  permissive policies with OR and restrictive policies with AND, so effective
  access is `(OR of permissive) AND (AND of restrictive)`. Dropping the last
  restrictive policy therefore *removes* a narrowing conjunct — the "more
  access" outcome the permissive argument above rules out. This layer cannot
  tell the two apart: `AS RESTRICTIVE` is declared on `create policy` and
  never appears on the `drop`, and the create may live in an earlier
  migration entirely, so no statement-local or even migration-local check can
  distinguish them. Accepted on a bounded basis — `generateSchemaPlanSql`
  emits no restrictive policies, so this is reachable only via hand-written
  SQL from an implementing agent. It is a genuine narrowing of the pre-#538
  posture, which did require approval for an unpaired policy drop. Closing it
  needs a catalog-aware check across the whole migration set (the natural home
  is a `security-lint` rule, which already sees every file and already parses
  `AS PERMISSIVE|RESTRICTIVE` in `POLICY_RE`); that is future work, not in
  scope here. The ceiling is recorded as a `ponytail:` note at
  `destructivePatterns`.
- Known ceiling (unchanged): `verifySchema` compares policy **names** only, so
  a later plan changing a policy's predicate under an unchanged name drifts
  silently and still verifies green.
- Cosmetic: `security-lint`'s `destructive-migration` remediation still says
  "Verify a recent backup", which reads oddly for an RLS disable; the evidence
  field carries the statement verbatim, so the finding is not misleading.

## Validation and rollback

`packages/platform/src/supabase-runtime.test.ts`, describe block
`destructiveStatements classifies by effect (#538)`: the #529 real-run
migration and the crud-heavy fixture SQL classify empty; policy drops classify
empty regardless of ordering, spacing or dollar quoting; every other `DROP`,
`TRUNCATE`, `DELETE FROM`, `DROP COLUMN` and now `DISABLE ROW LEVEL SECURITY`
still classify destructive. Two end-to-end `runtime.migrate()` cases close it:
a policy-replace migration applies without approval, an RLS-disable migration
raises `MigrationApprovalRequiredError`.

To roll back, restore the `recreated`/`policyKey`/`DOLLAR_QUOTED` block from
`git show 5071e7fc:packages/platform/src/supabase-runtime.ts` and drop the two
new patterns.
