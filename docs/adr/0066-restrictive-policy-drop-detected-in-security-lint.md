# ADR 0066: A RESTRICTIVE policy drop is detected in security-lint, not in the migration gate

- Status: Accepted
- Date: 2026-08-15
- Owners: Core, Security
- Tracked by issue #546
- Complements ADR 0064 (does not supersede it)

## Context

ADR 0064 removed `DROP POLICY` from `destructivePatterns` on the argument that
dropping a policy can only *reduce* access: with RLS enabled, zero policies is
deny-all. That argument holds for PERMISSIVE policies — the default, OR-composed
— and it was recorded as the sharp edge of that decision that it does **not**
hold for RESTRICTIVE ones.

Postgres composes effective access as `(OR of permissive) AND (AND of
restrictive)`. Dropping the last restrictive policy removes a narrowing
conjunct, so it *widens* access — precisely the "more access" outcome ADR 0064's
permissive argument rules out.

`destructiveStatements()` cannot close this. It sees one statement at a time,
`AS RESTRICTIVE` is declared on `create policy` and never appears on the `drop`,
and the create may live in an entirely different, earlier migration. Neither a
statement-local nor a migration-local check can tell a restrictive drop from a
permissive one.

## Decision

**Detect it in `security-lint`, which already reads the whole migration set.**
`lintMigrationsSql` (`packages/platform/src/security-lint.ts`) gains a sixth
rule, `restrictive-policy-drop` (severity `high`, so `blocksRelease` is true):

- Two regexes over the statements `sqlStatements()` already yields:
  `CREATE_POLICY_TARGET_RE` reads the policy target plus the optional
  `AS { PERMISSIVE | RESTRICTIVE }` mode, and `DROP_POLICY_RE` reads the target
  of a drop. The mode is read *positionally* — Postgres only allows it directly
  after the table name — so a predicate mentioning those words cannot fool it.
- `foldIdentifier`/`policyKey` (restored from the pairing block ADR 0064
  removed, `git show 5071e7fc:packages/platform/src/supabase-runtime.ts`) key a
  policy by folded `schema.table:policy`, matching Postgres's rule that an
  unquoted identifier lower-cases and a quoted one is verbatim. An unqualified
  target defaults to `public`.
- One ordered pass over the (sorted) file set keeps the policies currently in
  force `AS RESTRICTIVE`. A drop of one becomes a *candidate*; a later
  `AS RESTRICTIVE` re-create of the same key clears it. Candidates surviving the
  whole set are reported.

The migration approval gate is deliberately left alone. This is a review-time
security finding about the shape of a schema, not a data-loss risk needing a
verified backup, and folding it back into `destructiveStatements()` would
re-introduce exactly the cross-statement pairing state ADR 0064 removed — with
the same laundering surface — into the code path that also gates the runtime.

## Alternatives considered

- **Revert ADR 0064 and restore the unconditional `^DROP\b`.** Rejected, and
  explicitly out of scope on #546: it re-breaks the schema-first path (#529)
  for every permissive policy replace to catch a case the generator cannot
  emit.
- **Re-introduce pairing logic into `destructiveStatements()`.** Rejected for
  the reasons above; also out of scope on #546.
- **Query the live catalog (`pg_policies.permissive`).** Rejected: the lint is
  pure and read-only by construction (ADR 0036) and runs before anything is
  applied; a catalog probe needs a provisioned stack the linter has no business
  requiring.
- **Flag every `DROP POLICY` in the lint regardless of mode.** Rejected: the
  generator emits a drop before every policy create for idempotence, so this
  would fire on every schema-first run — noise that trains operators to ignore
  the rule.

## Consequences

- Positive: the accepted negative of ADR 0064 is closed. A hand-written
  restrictive drop with no restrictive replacement now blocks release with a
  finding that names both halves — the drop statement and the file the
  restrictive create came from — which is the non-obvious part.
- Positive: no change to `destructiveStatements()`, so the migration gate keeps
  its stateless classify-by-effect property and the schema-first path is
  untouched.
- Negative / accepted: a permissive re-create after a restrictive drop is still
  flagged. That is intended — the narrowing conjunct is gone either way — but it
  reads as a false positive to someone who sees a matching create.
- Known ceiling (shared with every other rule in this file): regex-over-
  statement-text, not a SQL parser. `sqlStatements()` does not know dollar
  quoting, so a `create policy … as restrictive` inside a `do $$ … $$` body
  registers as if it were top-level. It fails *toward* flagging, and
  `generateSchemaPlanSql` emits no dollar quoting. Upgrade path is a real
  parser, shared with the `ponytail:` note already at `CREATE_TABLE_RE`.
- Known ceiling: a restrictive policy created outside the linted migration set
  (applied by hand against the database) is invisible, so a drop of it raises
  nothing. The lint reasons only about the SQL in the repo.
- ADR 0036 says the linter has "five rules". That enumeration is now stale; per
  `docs/adr/README.md` accepted ADRs are not rewritten, and this ADR is the
  correction.

## Validation and rollback

`packages/platform/src/security-lint.test.ts`: a cross-file restrictive drop is
flagged (`high`, correct table, evidence naming the creating file); a drop that
a later statement re-creates `AS RESTRICTIVE` is not; a re-create as PERMISSIVE
still is; a permissive drop is not (the ADR 0064 case stays exempt); an
unqualified drop matches a `public.`-qualified create; and identifier folding
matches `"tenant_isolation"` to unquoted `TENANT_ISOLATION` while keeping
`"TENANT_ISOLATION"` distinct. The existing polynomial-backtracking test gained
near-miss prefixes for both new regexes.

To roll back, remove the `restrictive-policy-drop` member from
`SecurityRuleSchema` (`packages/contracts/src/security.ts`) and the two regexes,
the two maps, the tracking branches and the emitting loop from
`security-lint.ts`. Nothing else reads the rule.
