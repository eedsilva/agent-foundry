# ADR 0037: Hand-author the Issue Radar reference app instead of live-generating it

- Status: Accepted
- Date: 2026-07-24
- Owners: Integrations

## Context

Issue #76 closes the v0.10 milestone by delivering Issue Radar as agent-foundry's golden
full-stack reference app: Next.js + Tailwind + shadcn/ui + local Supabase, auth-protected
CRUD/filters/dashboard, attachments via Storage + RLS, browser tests for positive and
negative (cross-user) access, and an exportable, documented Compose deployment. Its six
blocking sub-issues (#70-#75) each shipped as a platform capability plus e2e proof — none
of them ran the full `web-app-v1` multi-agent generation workflow live to produce their
evidence.

## Decision

Issue Radar is hand-authored under `examples/issue-radar-app/`, following exactly the
conventions the `web-app-v1` pipeline would apply: the auth pattern in
`harness/scaffolds/nextjs/` (reused, not modified), the RLS-baseline and default-deny
policy shape from `harness/stacks/supabase.md`, and the storage upload/scan protocol from
`packages/platform/src/supabase-storage.ts` (#72). Two Playwright specs
(`apps/api/e2e/issue-radar-golden-journey.spec.ts`,
`apps/api/e2e/issue-radar-cross-user-access.spec.ts`) boot the real app against a real,
isolated local Supabase stack via `@agent-foundry/composition`'s real-mode runtime — the
same runtime production uses — and are gated in CI (`.github/workflows/ci.yml`'s
`issue-radar-e2e` job).

We did not run the real `web-app-v1` workflow (real Claude Code CLI through
plan→architecture→implementation→verification→browser-verification→release quality
gates) to produce Issue Radar's code. That loop is real and wired (see
`packages/orchestrator/src/workflow-orchestrator.ts`,
`packages/executors/src/claude-executor.ts`), but running it live is slow, costly per
run, and its end-to-end reliability across all quality gates is not yet proven —
exercising it for the first time as this issue's acceptance evidence would conflate two
different risks (does the generation loop work? does the resulting app satisfy the PRD?)
in one expensive, nondeterministic step.

## Alternatives considered

Running the live pipeline against `examples/issue-radar.prd.md` would more literally
satisfy "born via chat," but ties #76's completion to an unproven, expensive process
outside this issue's control, with no clear rollback if a quality gate stalls or loops.
Generating once and freezing the output (like `npm run dogfood:run --freeze`) was
considered and rejected: dogfood tasks are small, scoped diffs against a seeded
workspace, not a full multi-page app, and freezing a multi-thousand-line live-generated
diff without human review would not meet this repo's own code-review conventions.

## Consequences

Positive: the reference app is deterministic to build, review, and regression-test;
its RLS migrations are covered by a fast unit-level lint regression
(`packages/platform/src/issue-radar-example-security-lint.test.ts`) in addition to the
two browser specs. Negative: it does not, by itself, prove the live multi-agent
generation loop can produce a working app from `examples/issue-radar.prd.md`
unattended — that remains open, tracked risk (see `docs/RISK_REGISTER.md`'s real-CLI-loop
entry), not closed by this ADR.

## Validation and rollback

Validated by `npm run check` plus the `issue-radar-e2e` CI job passing on the PR that
introduces this ADR. Rollback is deleting `examples/issue-radar-app/`, the two Playwright
specs, and the `issue-radar-e2e` CI job — no other package depends on this example.
