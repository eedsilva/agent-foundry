# ADR 0036: Static security lint and RLS access-matrix verification before release

- Status: Accepted
- Date: 2026-07-24
- Owners: Platform

## Context

Issue #75 names the risk directly: "Backend gerado sem segurança de dados é uma armadilha polida" — a
generated backend without data security is a polished trap. `SupabaseGeneratedProjectRuntime` (ADR 0007,
0030, 0031) already lets a generated app's coding-agent loop create tables and RLS policies through
ordinary `supabase/migrations/*.sql` files, and already blocks a manually-approved destructive migration
without approval (`supabase-runtime.ts`'s `destructiveStatements()` / approval-gate check, predating this
ADR). What it had no way to do was catch the more common data-security failure mode: a migration that
applies cleanly, is not destructive, and still leaves a table world-readable or world-writable — no RLS
enabled at all, RLS enabled but zero policies on a table keyed by `user_id`/`owner_id`, a policy that
grants `anon` a write, or a `GRANT` that hands anon (or PUBLIC, which includes anon) direct table access
outside any policy. None of those are exercised by the destructive-migration gate, and none were verified
by any existing test suite before this issue.

Issue #71 established this repo's generated-app authorization model: single-owner rows
(`user_id`/`owner_id` columns compared to `auth.uid()`), no tenant, member, or admin table. Issue #75's
acceptance criteria ask for an access matrix testing "anonymous, owner, member e admin quando aplicável"
(when applicable) — for this codebase, only anonymous and owner are applicable today.

## Decision

Two independent, complementary checks, both scoped to the platform boundary rather than to a live
orchestrator run:

1. **Static lint** (`packages/platform/src/security-lint.ts`, `lintMigrationsSql`/`lintMigrationsDir`) —
   parses the same generated `supabase/migrations/*.sql` statements `sqlStatements()`/
   `destructiveStatements()` already tokenize (ADR-predating helpers, exported for reuse rather than
   reimplemented) and reports `SecurityFinding`s (`packages/contracts/src/security.ts`:
   `SecurityReportSchema` — `schemaVersion`, `findings[]`, `blocked`, `generatedAt`) for five rules:
   `missing-rls` (a created table with no matching `ENABLE ROW LEVEL SECURITY`, high), `sensitive-table-
no-policy` (RLS on but zero `CREATE POLICY` statements on a table shaped like `user_id`/`owner_id` or a
   FK to `auth.users`, critical), `anon-write-policy` (a write policy granted to `anon`, or written with an
   unconditional `USING (true)`/`WITH CHECK (true)`, critical), `anon-grant` (a `GRANT` of INSERT/UPDATE/
   DELETE/ALL to `anon` or `public` still in effect, high), and `destructive-migration` (reusing the
   existing `destructiveStatements()` detector verbatim, high). `blocksRelease(report)` is a pure function
   over the resulting `SecurityReport` — true whenever any finding is `high` or `critical`.
2. **Live RLS access-matrix e2e** (`packages/platform/src/security-rls.e2e.test.ts`) — against a real,
   freshly provisioned local Supabase stack (not mocked, not skipped by default in CI): anonymous SELECT
   and INSERT denied; an authenticated owner can read, insert, update, and delete their own rows (the
   positive baseline a pure-denial suite cannot provide by itself); a second authenticated user's
   UPDATE/DELETE against the first user's row is a real IDOR probe against actual owner-scoped policies
   and has no effect; and an authenticated INSERT that spoofs another user's `user_id` is rejected by the
   migration's `WITH CHECK`. This runs in CI as a new `rls-e2e` job (`.github/workflows/ci.yml`), cloned
   from the existing `auth-e2e` job pattern (real `supabase/setup-cli`, `RUN_SUPABASE_RLS_E2E=true`),
   so it executes on every push and PR rather than being available-but-skipped like some other e2e suites.

`blocksRelease()` is exposed as a function callers check, not wired into the orchestrator's
`quality-loop`/`approval-gate` nodes to halt a live run. Nothing in this change stops a generated app from
being previewed or iterated on with an unresolved high/critical finding; it produces the artifact and
the boolean a release step would need to enforce that, and defers the actual enforcement wiring.

## Alternatives considered

- **Test member and admin roles in the access matrix**: rejected as not applicable. Issue #71's
  generated-app schema has no tenant/member/admin table — only `user_id`/`owner_id` → `auth.uid()`. Adding
  a role tier that doesn't exist in the generated schema would test a fixture invented for the test, not
  the real authorization model. If a future issue adds RBAC to generated apps, this matrix is the place to
  extend with member/admin cases at that time.
- **Wire `blocksRelease()` into the orchestrator's quality-loop/approval-gate for a live run-halt now**:
  rejected for this issue. The finding-producing and blocking-decision primitives are done and covered;
  deciding where in the orchestrator's node graph a run should actually halt, what the operator sees, and
  how a human overrides it is a separate, non-trivial design surface. Building the artifact without
  wiring it in is a smaller, independently reviewable change than doing both at once. **This is an
  explicit post-merge follow-up, not a dropped requirement.**
- **A real SQL parser instead of regex-on-statement-text for the lint rules**: rejected, matching the
  precedent `destructiveStatements()` already set. The migrations this lints are generated by this
  repo's own scaffold and coding-agent loop, not arbitrary third-party SQL, so the statement shapes are
  bounded; a full parser is more code to cover shapes that don't occur here. Marked in-code
  (`security-lint.ts`) as a known ceiling to revisit if statement shapes diverge.

## Consequences

Positive: every generated migration set can now be checked for the two RLS failure modes that
`destructive-migration` never covered (no RLS at all, RLS with no policy on a sensitive table), plus the
`anon`-equivalent write paths (`USING/WITH CHECK (true)`, direct `GRANT`, and `GRANT ... TO public`, which
Postgres treats as implicitly including `anon`). The RLS e2e suite is a real, non-mocked proof that the
scaffold's actual owner-scoped policies (not a hypothetical) resist anonymous access, cross-owner IDOR,
and `user_id` spoofing, and it now runs in CI on every push/PR rather than only locally.

Negative / security: `blocksRelease()` not being wired into any enforcement path means a migration set
with a `high`/`critical` finding today does not, by itself, stop anything — the finding is only as useful
as whatever calls `lintMigrationsDir`/`blocksRelease` and acts on the result. Until the orchestrator
integration lands, this is a detection capability, not yet a release gate in the literal sense.
Regex-based lint rules can both under- and over-match on SQL shapes the generator hasn't produced yet;
review during this issue already found and closed two real gaps (below), which is evidence the approach
surfaces real misses, not proof no more remain.

Operational: `lintMigrationsSql`/`lintMigrationsDir` are pure/read-only — they parse SQL text and return a
report, they do not touch a live database or mutate migrations. `security-rls.e2e.test.ts` provisions and
tears down its own throwaway local Supabase stack (temp `dataDir`, `supabase stop --no-backup` in
`afterAll`); it has no effect on any other project's data.

Migration: none. `SecurityReportSchema` is a new contract (`schemaVersion: '1'`); nothing existing reads
or writes it yet, so there is no compatibility surface to break.

## Validation and rollback

`packages/contracts/src/security.test.ts` (11 tests) covers the schema's severity/rule enums and the
finding/report shapes, including the `.strict()` rejection of unknown fields. `packages/platform/src/
security-lint.test.ts` (13 tests) covers all five rules individually, the anon-grant revoke/re-grant
interaction, the ALL-implies-write-ops handling, and two zero-finding fixtures — a hand-written clean
owner-RLS migration set and, more importantly, the real `generatedStorageMigration()` SQL this repo
actually ships (`supabase-storage.ts`, ADR 0032/0025) — proving the linter does not false-positive on
production migration text. It also proves `destructive-migration` findings reuse the exact same
`destructiveStatements()` function the runtime's approval gate calls
(`supabase-runtime.test.ts:721`; see also T5 in `.superpowers/sdd/task-5-report.md`), so the security
artifact and the actual release-blocking enforcement cannot silently disagree about what counts as
destructive. `packages/platform/src/security-rls.e2e.test.ts` (6 tests) is real-stack proof, env-gated
(`RUN_SUPABASE_RLS_E2E=true`) and run unconditionally in CI's new `rls-e2e` job. Full evidence and exact
commands: `docs/evidence/issue-75-security-verification.md`.

Two real linter gaps and one real test-validity gap were found and fixed during task review before merge:
`anon-grant` initially missed `GRANT ALL ... TO anon` and `GRANT ... TO public` (Postgres's PUBLIC
pseudo-role includes anon) — both fixed, both now covered by dedicated tests. The first version of the T4
e2e fixture had no UPDATE/DELETE policies at all, so the cross-owner IDOR tests could not distinguish real
IDOR protection from "writes are globally broken for everyone" — fixed by adding real owner-scoped
update/delete policies and a positive-case test proving the owner's own writes succeed.

Rollback: revert `packages/contracts/src/security.ts`, `packages/platform/src/security-lint.ts`, `packages/
platform/src/security-rls.e2e.test.ts`, and the `rls-e2e` job in `.github/workflows/ci.yml`. Nothing else
in the runtime calls `lintMigrationsSql`/`lintMigrationsDir`/`blocksRelease` yet, so no other code path is
affected by removing them. `supabase-runtime.ts`'s pre-existing destructive-migration approval gate is
untouched by this ADR and would continue enforcing on its own.
