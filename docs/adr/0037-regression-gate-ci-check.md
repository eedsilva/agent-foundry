# ADR 0037: Regression gate as a required-path CI check for catalog and harness promotion

- Status: Accepted
- Date: 2026-07-24
- Owners: router/model-routing maintainer

## Context

Issue #67 required that promoting `models/catalog.yaml` or `harness/manifest.json` compare against a frozen benchmark baseline before merge. PR #283 shipped `compareBenchmarkReports` (the comparator), the frozen-baseline file convention (`docs/baselines/v0.9-benchmark.json`), and a standalone `POST /router/regression-gate` endpoint plus `scripts/benchmark.ts --gate` CLI flag — but wired none of it into an actual promotion path. `docs/OPERATIONS.md` documents catalog/harness promotion as a fully manual, human-reviewed process with no automated check. There is no CI-available real provider credential, so any automated gate can only run the benchmark suite in `--executor-mode mock`.

## Decision

Add a `regression-gate` job to `.github/workflows/ci.yml` that runs on every push/PR (via the existing `preflight`-gated job graph), but only executes `scripts/benchmark.ts --all --executor-mode mock` followed by `scripts/benchmark.ts --gate` when the change touches `models/catalog.yaml` or `harness/manifest.json` — decided by a new pure function, `shouldRunRegressionGate` (`packages/composition/src/regression-gate.ts`), driven off `git diff --name-only` against the PR's base SHA (or the previous commit on `push`), via a thin CLI wrapper (`scripts/promotion-gate-check.ts`). The job fails the check if `compareBenchmarkReports` returns `verdict: 'fail'` (any case regressed `passed` → `failed`, or a baseline case is missing from the fresh run).

The `docs/baselines/v0.9-benchmark.json` baseline is frozen once, checked into the repo, and re-frozen manually by a maintainer (`docs/OPERATIONS.md` "Regression gate de promoção") whenever a deliberate catalog/harness change is expected to shift benchmark outcomes.

## Alternatives considered

- **Run the gate unconditionally on every PR.** Rejected: adds ~20-25 minutes to every unrelated PR (docs, refactors) for zero signal, and the issue's acceptance criterion scopes the gate to "antes de promover catálogo ou harness" specifically.
- **Freeze and gate against a `--executor-mode real` baseline.** Rejected for now: CI has no provider credentials, so a CI-driven fresh run can only ever run in mock mode; gating mock-mode fresh runs against a real-mode baseline would make every case a permanent false-positive regression (mock mode cannot produce a `passed` status the way real mode can). Left as a documented future option requiring either CI credentials or a human-run, non-CI comparison.
- **Make it a required branch-protection status check immediately.** Rejected as out of scope for this change: that's a live GitHub governance mutation (`npm run github:governance:apply`), separate from adding the CI job itself, and should be a deliberate follow-up decision by whoever owns branch protection.

## Consequences

- Positive: catalog/harness PRs now get an automated structural check (case coverage, crash-before-repair-ceiling) instead of relying entirely on manual review.
- Negative: the job is slow (~20-25 min) whenever it runs, inherent to the existing benchmark suite's per-case-per-model dogfood pipeline, not something this decision changes.
- Negative/limitation: does not catch model-quality regressions today — only structural ones — because the baseline is mock-mode. This is documented in `docs/OPERATIONS.md` and in a code comment on the CI job.
- Migration: none — `docs/baselines/v0.9-benchmark.json` is new; no existing consumer depended on its absence.

## Validation and rollback

Validated by: `packages/composition/src/regression-gate.test.ts` (`shouldRunRegressionGate` unit tests), `packages/composition/src/benchmark-runner.test.ts` (committed-baseline sanity test), and `apps/api/e2e/golden-flow.spec.ts` (`POST /router/regression-gate` pass/fail e2e coverage against the real committed baseline).

Rollback: remove the `regression-gate` job from `.github/workflows/ci.yml`. The endpoint, CLI flag, and baseline file are harmless if left in place (the endpoint is already rate-limited and was already shipped in PR #283).
