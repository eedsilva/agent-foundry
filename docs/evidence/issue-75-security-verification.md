# Issue #75: RLS, authorization, and destructive-operation verification evidence

Related: ADR [0036](../adr/0036-security-verification-before-release.md).

## Acceptance

| Acceptance intent (issue #75)                                            | Implementation                                                                                                                                                                                                                                                                                                                                                        | Evidence                                                                                                                                                      |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schema e policies passam por static lint e testes de acesso              | `packages/platform/src/security-lint.ts`: `lintMigrationsSql`/`lintMigrationsDir` over generated `supabase/migrations/*.sql`; contract in `packages/contracts/src/security.ts`                                                                                                                                                                                        | `security.test.ts` 11/11, `security-lint.test.ts` 13/13                                                                                                       |
| Matriz testa anonymous, owner, member e admin quando aplicável           | `packages/platform/src/security-rls.e2e.test.ts` against a real local Supabase stack: anonymous denied, owner read/write/update/delete (positive baseline), cross-owner IDOR denied, privilege escalation denied. Member/admin: **N/A** — issue #71's generated-app schema is single-owner (`user_id`/`owner_id` → `auth.uid()`), no tenant/member/admin table exists | `security-rls.e2e.test.ts` 6/6 against real local Supabase                                                                                                    |
| Migration destrutiva exige approval gate                                 | Pre-existing `destructiveStatements()`/approval-gate check in `supabase-runtime.ts` (unchanged); T2 exported it for reuse; T5 confirmed the destructive-migration lint rule and the runtime's enforcement share that exact same detector                                                                                                                              | `supabase-runtime.test.ts:721` ("destructive migration without approval throws", incl. zero-approval case); `security-lint.test.ts:242` (same-detector proof) |
| Release bloqueia tabela sensível sem policy explícita                    | `sensitive-table-no-policy` rule (critical) fires when a `user_id`/`owner_id`/`auth.users`-referencing table has RLS enabled but zero `CREATE POLICY` statements; `blocksRelease()` returns true for any high/critical finding                                                                                                                                        | `security-lint.test.ts` dedicated case + `blocksRelease()` assertions throughout that file                                                                    |
| Findings entram no security artifact com severidade e evidência          | `SecurityReportSchema`/`SecurityFindingSchema` (`packages/contracts/src/security.ts`): `schemaVersion`, `findings[]` (each with `id`, `rule`, `severity`, `table`, `location`, `evidence`, `remediation`), `blocked`, `generatedAt`                                                                                                                                   | `security.test.ts` 11/11 (schema shape, `.strict()` rejection of unknown fields, severity/rule enums)                                                         |
| Testes obrigatórios: IDOR, missing RLS e privilege escalation em fixture | IDOR: cross-owner UPDATE/DELETE tests in `security-rls.e2e.test.ts`. Missing RLS: `missing-rls` rule in `security-lint.ts`. Privilege escalation: spoofed-`user_id`-on-INSERT test in `security-rls.e2e.test.ts`                                                                                                                                                      | `security-rls.e2e.test.ts` 6/6; `security-lint.test.ts`'s `missing-rls` case                                                                                  |

## Results

Exact commands and pass counts from the local verification run (controller-run; not re-run in this
task since the full suite takes ~11 minutes):

```bash
npm run format:check          # passed
npm run lint                  # passed
npm run architecture:check    # passed
npm run roadmap:check         # passed
npm run typecheck             # tsc -b --force --pretty false — passed, clean
npm run build                 # passed (Next.js build succeeded, TypeScript in the build succeeded)
npm run secrets:check         # passed (no .env tracked, no known secret shapes in source/client bundle)
npm test                      # test:unit (vitest) + test:scripts
```

`npm test` result: **1661 passed, 13 skipped (e2e-gated), 1 failed.**

Focused new-code test runs (all green):

```bash
npx vitest run packages/contracts/src/security.test.ts               # 11/11
npx vitest run packages/platform/src/security-lint.test.ts            # 13/13
RUN_SUPABASE_RLS_E2E=true npx vitest run packages/platform/src/security-rls.e2e.test.ts   # 6/6, real local Supabase
npx vitest run packages/platform/src/supabase-runtime.test.ts         # 34/34 (T2 regression, unaffected)
```

### The one failure — explained, not hidden

The single `npm test` failure was
`packages/executors/src/docker-sandbox-runner.integration.test.ts > ... enforces allowlisted DNS and HTTP...`,
a Docker container-readiness flake (`No such container: <id>`). This is not attributable to this branch:

- The file it's in has zero diff on this branch — `git diff --stat 3f688d4 HEAD -- packages/executors/`
  shows no changes to anything under `packages/executors/`.
- Re-running that single test file in isolation immediately after passed cleanly:
  `npx vitest run packages/executors/src/docker-sandbox-runner.integration.test.ts` → **18/18 passed.**
- The session's Docker daemon was simultaneously running long-lived Supabase containers from the T4
  live-RLS-e2e work above, plus containers from an unrelated project started weeks earlier — container
  contention during the full-suite run, not a regression this branch introduced.

## CI

`.github/workflows/ci.yml` gained a `rls-e2e` job (cloned from the existing `auth-e2e` job): checks out,
installs the pinned Supabase CLI (`supabase/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520`, v2.62.5),
and runs `RUN_SUPABASE_RLS_E2E=true npx vitest run packages/platform/src/security-rls.e2e.test.ts` against
a real Supabase stack on every push and PR — not env-gated-but-skipped, it runs unconditionally in CI like
`auth-e2e` and `storage-e2e` already do.

## Real gaps found and fixed during review

Two real security-linter gaps and one real test-validity gap were caught by task review before merge —
recorded here as evidence the process worked, not swept into the "done" summary:

- `anon-grant` initially missed `GRANT ALL ... TO anon` and `GRANT ... TO public` (Postgres's `PUBLIC`
  pseudo-role includes `anon`) — both fixed, both now covered by dedicated tests in `security-lint.test.ts`.
- The first version of the T4 e2e's RLS fixture had no `UPDATE`/`DELETE` policies at all, so the
  cross-owner IDOR tests couldn't distinguish real IDOR protection from "writes are globally broken for
  everyone" — fixed by adding real owner-scoped update/delete policies plus a positive-case test proving
  the owner's own writes succeed (`security-rls.e2e.test.ts`, "lets an owner read and write their own
  rows").

## Scope decisions (recorded in ADR 0036)

- Access matrix = anonymous + owner + cross-owner IDOR + privilege escalation; member/admin explicitly
  N/A for this schema generation (issue #71 has no RBAC, only single-owner `user_id`/`owner_id`).
- `blocksRelease(report)` is a pure function at the platform boundary; wiring it into the orchestrator's
  `quality-loop`/`approval-gate` nodes for a live run-halt is an **explicit deferred follow-up**, not
  dropped scope.
- `rls-e2e` runs unconditionally in CI on every push/PR, matching the `auth-e2e`/`storage-e2e` pattern.

## Definition of Done

Reviewed against `docs/DEFINITION_OF_DONE.md`: acceptance criteria are demonstrated by the table above
with real test evidence (not merely asserted); typecheck/lint/format/architecture/roadmap/build/tests all
pass (one flake explained, isolated-rerun proven clean); failure states are tested (anon denial, IDOR
denial, spoofing denial, missing-approval destructive-migration throw); the new `SecurityReportSchema` is
additive, nothing existing reads or writes it yet so there's no compatibility break; this document plus
ADR 0036 are the delivery-evidence and decision-record artifacts the DoD requires. No gap found requiring
further action.
