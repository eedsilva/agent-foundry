# Task 3 report: Preview, workflow, and repair integration

Commit: `5b7fe92` (`feat: orchestrate browser verification`)

## Summary

- Added `BrowserVerificationCoordinator`, which starts a durable preview, validates the exact stored browser-plan envelope, invokes the browser verifier, returns a schema-valid deterministic failure report for invalid plans, and stops every started preview in `finally`.
- Added the browser branch to `WorkflowOrchestrator` without changing workspace-verifier behavior when `browserTestPlanArtifact` is absent.
- Pinned the exact browser plan revision/hash in step idempotency and `StepAttempt.inputArtifacts`; browser attempts persist `model: browser-verifier` and `previewSessionId`.
- Reused `verification.completed`, stored browser reports under the declared output artifact, and advanced the verified checkpoint only for approved reports.
- Wired `PlaywrightBrowserVerifier` and the coordinator into runtime composition.
- Added the exact browser quality loop to `workflows/web-app-v1.yaml` and supplied its plan/report to release assessment.
- Preserved executor behavior; runtime integration uses test-only browser plan/preview/verifier fakes at external boundaries.

## Files changed

- `packages/contracts/src/run.ts`
- `packages/contracts/src/preview.test.ts`
- `packages/domain/src/run-state.ts`
- `packages/orchestrator/src/browser-verification-coordinator.ts`
- `packages/orchestrator/src/browser-verification-coordinator.test.ts`
- `packages/orchestrator/src/index.ts`
- `packages/orchestrator/src/workflow-orchestrator.ts`
- `packages/orchestrator/src/idempotency.ts`
- `packages/orchestrator/src/testing/harness.ts`
- `packages/orchestrator/src/policy-release-e2e.test.ts`
- `packages/composition/src/runtime.ts`
- `packages/composition/src/runtime.integration.test.ts`
- `packages/persistence/src/workflow-repository.test.ts`
- `workflows/web-app-v1.yaml`

The two small contract/domain changes were required to persist the requested `browser-verifier` model and the already-defined `previewSessionId` through `transitionStepAttempt`; arbitrary internal verifier model names remain rejected.

## RED evidence

### Contract and coordinator RED

Command:

```bash
npx vitest run packages/contracts/src/preview.test.ts packages/orchestrator/src/browser-verification-coordinator.test.ts
```

Observed:

```text
FAIL packages/orchestrator/src/browser-verification-coordinator.test.ts
Error: Cannot find module './browser-verification-coordinator.js'

FAIL packages/contracts/src/preview.test.ts
expected false to be true

Test Files 2 failed (2)
Tests 1 failed | 28 passed (29)
```

The failures were caused by the absent coordinator and the frozen attempt contract rejecting `model: browser-verifier`.

### Required focused integration RED

Command:

```bash
npx vitest run \
  packages/orchestrator/src/browser-verification-coordinator.test.ts \
  packages/orchestrator/src/policy-release-e2e.test.ts \
  packages/composition/src/runtime.integration.test.ts
```

Observed:

```text
FAIL packages/orchestrator/src/browser-verification-coordinator.test.ts
Error: Cannot find module './browser-verification-coordinator.js'

FAIL packages/orchestrator/src/policy-release-e2e.test.ts
Error: Cannot find module './browser-verification-coordinator.js'

FAIL packages/composition/src/runtime.integration.test.ts
expected undefined to be an instance of PlaywrightBrowserVerifier

Test Files 3 failed (3)
Tests 1 failed | 5 passed (6)
```

### Static integration RED

Command:

```bash
npm run typecheck
```

Observed after browser orchestration was implemented:

```text
packages/orchestrator/src/workflow-orchestrator.ts: error TS2353:
'previewSessionId' does not exist in transitionStepAttempt's typed patch.
```

This exposed the one-line frozen-domain transition omission; `previewSessionId` already existed in `StepAttemptSchema`.

## GREEN evidence

### Required focused tests plus workflow repository validation

Command:

```bash
npx vitest run \
  packages/orchestrator/src/browser-verification-coordinator.test.ts \
  packages/orchestrator/src/policy-release-e2e.test.ts \
  packages/composition/src/runtime.integration.test.ts \
  packages/persistence/src/workflow-repository.test.ts
```

Observed:

```text
Test Files 4 passed (4)
Tests 17 passed (17)
```

### Final relevant regression set

Command:

```bash
npx vitest run \
  packages/contracts/src/preview.test.ts \
  packages/domain/src/run-state.test.ts \
  packages/orchestrator/src/browser-verification-coordinator.test.ts \
  packages/orchestrator/src/policy-release-e2e.test.ts \
  packages/composition/src/runtime.integration.test.ts \
  packages/persistence/src/workflow-repository.test.ts
```

Observed:

```text
Test Files 6 passed (6)
Tests 56 passed (56)
Duration 18.27s
```

### Typecheck

Command: `npm run typecheck`

Observed: exit 0, no diagnostics.

### Architecture

Command: `npm run architecture:check`

Observed:

```text
architecture ok: 11 workspaces, no forbidden edges or cycles
tests 2 passed, 0 failed
```

### Lint, format, and diff

Commands:

```bash
npm run lint:code
npx prettier --check packages/contracts/src/preview.test.ts packages/orchestrator/src/browser-verification-coordinator.ts packages/orchestrator/src/browser-verification-coordinator.test.ts packages/orchestrator/src/policy-release-e2e.test.ts packages/orchestrator/src/workflow-orchestrator.ts packages/orchestrator/src/idempotency.ts packages/orchestrator/src/testing/harness.ts packages/composition/src/runtime.ts packages/composition/src/runtime.integration.test.ts packages/persistence/src/workflow-repository.test.ts packages/contracts/src/run.ts packages/domain/src/run-state.ts workflows/web-app-v1.yaml
git diff --check
```

Observed: all exit 0; ESLint reported no warnings, all changed files matched Prettier, and `git diff --check` was clean.

## Self-review

- Confirmed invalid plans produce `BrowserVerificationReportSchema` output with the exact plan reference, deterministic validation text, no leaked preview token, and no verifier call.
- Confirmed success, verifier failure, invalid plan, and abort each stop the started preview exactly once.
- Confirmed failed and approved browser reports both complete attempts and emit `verification.completed`; only approved reports checkpoint.
- Confirmed repair receives the exact plan and failed-report revisions, rerun retains the exact plan revision, an exact completed attempt is reused, and a new plan revision invalidates reuse.
- Confirmed workspace verification keeps `model: workspace-verifier`, empty inputs, and its prior execution branch; the added undefined browser policy field is omitted by stable idempotency serialization.
- Confirmed no executor source changed and no final documentation task was performed.

## Concerns

- The runtime workflow integration test fakes preview/browser execution to stay deterministic and fast, while a separate assertion verifies production composition uses `PreviewService`, `BrowserVerificationCoordinator`, and `PlaywrightBrowserVerifier`. Real browser mechanics remain covered by Task 2's executor tests.
- No blocking concern remains.

## Review fixes

### Inherited RED evidence

- The inherited review regression changes cover: an inserted newer browser-plan revision during a failure/repair/replay; a reused failed browser report while a newer approved report exists; browser verifier failure retaining `previewSessionId`; report and successful-attempt persistence failures; coordinator publication of the preview session before verifier failure; and post-runner-start preview persistence failure.
- At takeover, the focused rerun of coordinator, preview lifecycle, and policy-release tests produced one expected test-contract mismatch: the new preview regression expected `failurePhase` on terminal `failed`, but `PreviewSessionSchema` deliberately permits it only on `failing`. The assertion was corrected to the durable terminal status and error; no production behavior was weakened.

### GREEN evidence

```bash
npx vitest run \
  packages/orchestrator/src/browser-verification-coordinator.test.ts \
  packages/orchestrator/src/policy-release-e2e.test.ts \
  packages/orchestrator/src/preview-service.test.ts \
  packages/composition/src/runtime.integration.test.ts \
  packages/persistence/src/workflow-repository.test.ts \
  packages/contracts/src/preview.test.ts \
  packages/domain/src/run-state.test.ts
```

- Coordinator, policy-release, preview, repository, contract, and run-state suites: 75 tests passed; runtime integration: 6 tests passed (81 total).
- `npm run typecheck`, `npm run architecture:check`, `npm run lint:code`, Prettier check for all changed source/tests, and `git diff --check` all passed.

### Files changed

- `packages/orchestrator/src/browser-verification-coordinator.ts`
- `packages/orchestrator/src/browser-verification-coordinator.test.ts`
- `packages/orchestrator/src/workflow-orchestrator.ts`
- `packages/orchestrator/src/policy-release-e2e.test.ts`
- `packages/orchestrator/src/preview-service.ts`
- `packages/orchestrator/src/preview-service.test.ts`
- `packages/orchestrator/src/testing/harness.ts`

### Self-review

- Browser-plan references are captured from the setup artifact, loaded by exact revision and SHA-256 on check/repair/replay, and become part of idempotency inputs.
- Approval reads the check artifact returned or reused in the current loop, rather than the global latest report.
- Preview session identity is persisted immediately after start; preview cleanup preserves the original startup error; artifact and successful-attempt persistence complete before an approved checkpoint advances.
