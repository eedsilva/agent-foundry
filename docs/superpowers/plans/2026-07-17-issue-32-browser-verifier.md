# BrowserVerifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver issue #32 as one isolated, evidence-backed PR by adding a versioned declarative browser-test contract, a policy-enforced Playwright verifier, and reproducible preview/workflow integration.

**Architecture:** Browser plans remain ordinary `AgentArtifact` envelopes whose `data` is validated by a version-1 Zod schema. A `BrowserVerifier` domain port separates orchestration from the Playwright implementation; a small coordinator owns preview start/verify/stop, and existing `verify` workflow steps select browser mode with an exact plan-artifact name. Browser mode reuses the current artifact store, attempt records, quality-loop behavior, and `verification.completed` event.

**Tech Stack:** TypeScript, Zod, Vitest, Playwright 1.61.1 with headless Chromium, Node HTTP fixtures, existing filesystem persistence and workflow orchestration.

## Global Constraints

- Work only in `/Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-32-browser-verifier` on `agent/issue-32-browser-verifier`.
- Use strict RED → GREEN → REFACTOR; record the exact failing and passing commands in each task report.
- Apply Ponytail Ultra and Karpathy guidelines: reuse existing contracts and workflow machinery, make surgical changes, and add no speculative abstractions.
- Add only `playwright@^1.61.1` to `@agent-foundry/executors`; install only Chromium in CI with `npx playwright install --with-deps chromium`.
- Execute declarative actions/assertions only; never generate or execute JavaScript from a browser plan.
- Browser navigation paths must start with exactly one `/`; absolute URLs and `//` network paths are invalid.
- The exact `/preview/<sessionId>/` proxy prefix is always allowed. Every other origin requires an exact `ProjectPolicy.browserAllowedOrigins` entry.
- Use a 10-second action/assertion timeout, 60-second total ceiling, at most 100 redacted observations, and `serviceWorkers: 'block'`.
- Treat HTTP status `>=400`, failed requests, `console.error`, uncaught page errors, policy blocks, and action/assertion failures as a failed verdict.
- Always close page/context/browser and stop the preview on success, failure, timeout, or cancellation.
- Issue #33 owns screenshots, traces, video, retention, and binary downloads. This change stores JSON plan/report artifacts and per-step JSON evidence only.
- Keep existing workspace-verifier behavior unchanged when `browserTestPlanArtifact` is absent.

---

### Task 1: Contracts and workflow validation

**Files:**

- Modify: `packages/contracts/src/preview.ts`
- Modify: `packages/contracts/src/preview.test.ts`
- Modify: `packages/contracts/src/policy.ts`
- Modify: `packages/contracts/src/policy.test.ts`
- Modify: `packages/contracts/src/workflow.ts`
- Modify: `packages/contracts/src/workflow.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/domain/src/ports.ts`
- Modify: `packages/persistence/src/workflow-repository.ts`
- Modify: `packages/persistence/src/workflow-repository.test.ts`

**Interfaces:**

- Consumes: existing `AgentArtifactSchema`, `ArtifactReferenceSchema`, `PreviewSessionReferenceSchema`, `ProjectPolicySchema`, and `VerifyStepSchema` conventions.
- Produces: `BrowserTestPlanSchema`, `BrowserTestPlanArtifactSchema`, `BrowserVerificationReportSchema`, inferred public types, `ProjectPolicy.browserAllowedOrigins?: string[]`, `VerifyStep.browserTestPlanArtifact?: string`, and `BrowserVerifier.verify({ planArtifact, planContent, session, allowedOrigins }, signal)`.

- [ ] **Step 1: Write failing browser-plan and report contract tests**

  Add focused cases to `preview.test.ts` using a three-step create/update/delete-shaped plan. Assert the role/label/text/testId locators, goto/click/fill actions, visible/hidden/containsText/url assertions, and viewport parse. Assert failures for zero or 101 steps, first action not `goto`, `/`-less paths, `//host/path`, `https://host/path`, viewport dimensions outside the inclusive `1..10_000` range, malformed `AgentArtifact` envelopes, and report references/evidence outside the contract.

  The minimum valid envelope is:

  ```ts
  const artifact = {
    schemaVersion: '1',
    status: 'completed',
    summary: 'CRUD browser plan',
    data: {
      schemaVersion: '1',
      id: 'crud',
      title: 'CRUD',
      viewport: { width: 1280, height: 720 },
      steps: [
        {
          id: 'open',
          title: 'Open app',
          action: { kind: 'goto', path: '/' },
          assertions: [{ kind: 'url', path: '/' }],
        },
      ],
    },
    decisions: [],
    assumptions: [],
    risks: [],
    nextActions: [],
  };
  ```

- [ ] **Step 2: Write failing policy/workflow/repository tests**

  Assert exact-origin policy parsing accepts `https://api.example.test` and rejects paths, credentials, query/fragment components, wildcard hosts, and non-HTTP(S) schemes. Assert browser verify steps require `scripts: []` and `includeGitDiffCheck: false`, workspace verify steps retain current defaults, and mixed modes fail. In repository tests, assert a browser plan artifact must already be produced upstream and that the browser report becomes available to later agent steps.

- [ ] **Step 3: Run the focused tests and preserve RED evidence**

  Run:

  ```bash
  npx vitest run \
    packages/contracts/src/preview.test.ts \
    packages/contracts/src/policy.test.ts \
    packages/contracts/src/workflow.test.ts \
    packages/persistence/src/workflow-repository.test.ts
  ```

  Expected: failures caused by missing browser schemas, policy field, verify-step field/refinements, and dependency validation—not syntax or fixture errors.

- [ ] **Step 4: Implement the minimum schemas, exports, port, and dependency rules**

  Define strict Zod discriminated unions with the exact public shapes from issue #32. Use a single path schema refined with `path.startsWith('/') && !path.startsWith('//')`. Use integer viewport dimensions in the inclusive `1..10_000` range. Validate the plan artifact by extending the existing envelope so only `data` changes. Use this report shape so persistence and orchestration agree on names:

  ```ts
  interface BrowserVerificationReport {
    schemaVersion: '1';
    approved: boolean;
    summary: string;
    planArtifact: ArtifactReference;
    previewSession: PreviewSessionReference;
    planValidationError?: string;
    steps: Array<{
      stepId: string;
      title: string;
      status: 'passed' | 'failed' | 'skipped';
      durationMs: number;
      finalUrl?: string;
      error?: string;
      observations: Array<{
        kind:
          'console-error' | 'request-failed' | 'http-error' | 'uncaught-exception' | 'policy-block';
        message: string;
        url?: string;
        timestamp: string;
      }>;
    }>;
  }
  ```

  Define the port without an executor dependency:

  ```ts
  export interface BrowserVerifier {
    verify(
      input: {
        planArtifact: ArtifactReference;
        planContent: unknown;
        session: PreviewSessionReference;
        allowedOrigins: string[];
      },
      signal: AbortSignal,
    ): Promise<BrowserVerificationReport>;
  }
  ```

  In workflow validation, browser mode is selected by `browserTestPlanArtifact`; refine it to `scripts.length === 0 && includeGitDiffCheck === false`. Extend repository artifact-graph validation so the named plan is available before the verify step and the verify output remains available afterward.

- [ ] **Step 5: Run focused tests, typecheck, and commit**

  Run the focused command from Step 3, then:

  ```bash
  npm run typecheck
  git diff --check
  git add packages/contracts packages/domain/src/ports.ts packages/persistence
  git commit -m "feat: add browser verification contracts"
  ```

---

### Task 2: Deterministic Playwright executor

**Files:**

- Create: `packages/executors/src/browser-verifier.ts`
- Create: `packages/executors/src/browser-verifier.test.ts`
- Modify: `packages/executors/src/index.ts`
- Modify: `packages/executors/package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: Task 1 `BrowserVerifier`, plan/report schemas, artifact reference, and preview-session reference.
- Produces: exported `PlaywrightBrowserVerifier implements BrowserVerifier`, with no generated-code execution and deterministic redacted JSON evidence.

- [ ] **Step 1: Add the dependency and failing fixture-driven tests**

  Add exactly `playwright@^1.61.1` to the executors workspace and install Chromium locally. Build local Node HTTP fixtures in the test file (or one colocated fixture file only if readability requires it) for: full create/update/delete success; missing locator followed by skipped later steps; HTTP 500; `console.error`; uncaught exception; forbidden-origin sentinel with zero received requests; and abort cleanup. Drive the public verifier, not internal helpers.

- [ ] **Step 2: Run the executor test and preserve RED evidence**

  Run:

  ```bash
  npx playwright install chromium
  npx vitest run packages/executors/src/browser-verifier.test.ts
  ```

  Expected: failure because `PlaywrightBrowserVerifier` does not exist.

- [ ] **Step 3: Implement the minimum deterministic verifier**

  Launch one headless `chromium` browser and one context per verify call with the plan viewport and `serviceWorkers: 'block'`. Race the run against a 60-second timeout and the supplied abort signal. Set Playwright default action/navigation timeouts to 10 seconds.

  Resolve each plan path against the preview URL while preserving its token only for the initial preview navigation. Permit a request only when its URL is beneath the exact preview session prefix or its origin exactly matches a normalized allowed origin. Route both HTTP and WebSocket traffic; abort and append a `policy-block` observation otherwise. Register `response`, `requestfailed`, `console`, and `pageerror` listeners before navigation. Record status `>=400`, failures, console errors, and uncaught exceptions. Never include the preview token in final URLs, messages, thrown errors, or stored observations.

  Execute only the declared union:

  ```ts
  goto -> page.goto(...)
  click -> locator.click()
  fill -> locator.fill(value)
  visible/hidden -> locator visibility checks
  containsText -> locator text-content assertion
  url -> compare token-free path
  ```

  Stop after a failed step, mark every later plan step `skipped`, cap observations at 100, derive `approved` from all execution and passive-event failures, and close browser resources in `finally`.

- [ ] **Step 4: Run executor tests, focused contracts, typecheck, and commit**

  Run:

  ```bash
  npx vitest run packages/executors/src/browser-verifier.test.ts
  npx vitest run packages/contracts/src/preview.test.ts packages/contracts/src/policy.test.ts
  npm run typecheck
  git diff --check
  git add .github/workflows/ci.yml package-lock.json packages/executors
  git commit -m "feat: execute declarative browser plans"
  ```

---

### Task 3: Preview, workflow, and repair integration

**Files:**

- Create: `packages/orchestrator/src/browser-verification-coordinator.ts`
- Create: `packages/orchestrator/src/browser-verification-coordinator.test.ts`
- Modify: `packages/orchestrator/src/index.ts`
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`
- Modify: `packages/orchestrator/src/idempotency.ts`
- Modify: `packages/orchestrator/src/testing/harness.ts`
- Modify: `packages/orchestrator/src/policy-release-e2e.test.ts`
- Modify: `packages/composition/src/runtime.ts`
- Modify: `packages/composition/src/runtime.integration.test.ts`
- Modify: `workflows/web-app-v1.yaml`

**Interfaces:**

- Consumes: existing `PreviewService.start/stop`, exact artifact revisions, Task 1 `BrowserVerifier`, Task 2 `PlaywrightBrowserVerifier`, and current quality-loop/idempotency/attempt machinery.
- Produces: `BrowserVerificationCoordinator.verify(...)`, browser-mode orchestration, and a reproducible browser quality loop in `web-app-v1.yaml`.

- [ ] **Step 1: Write failing coordinator cleanup tests**

  Test success, verifier failure, invalid-plan failure, and abort. In every case, assert `PreviewService.stop(sessionId)` is called exactly once after a session starts. Assert invalid plan content returns a schema-valid failed `browser-verification.report` with `planValidationError` rather than throwing before cleanup.

- [ ] **Step 2: Write failing workflow integration tests**

  Exercise failure → repair → rerun with the same exact plan reference. Assert: the browser attempt input contains the plan reference; its context records `previewSessionId`; the report links the same plan and preview session; repair receives both plan and failed report; rerun loads the same plan revision; plan revision participates in idempotency; replay reuses only an exact completed attempt; approved reports advance/checkpoint; failed reports do not; `verification.completed` is emitted; and every preview stops.

- [ ] **Step 3: Run orchestrator/composition tests and preserve RED evidence**

  Run:

  ```bash
  npx vitest run \
    packages/orchestrator/src/browser-verification-coordinator.test.ts \
    packages/orchestrator/src/policy-release-e2e.test.ts \
    packages/composition/src/runtime.integration.test.ts
  ```

  Expected: failures for the absent coordinator, browser branch, runtime wiring, and workflow node.

- [ ] **Step 4: Implement coordinator and browser verify branch**

  The coordinator starts a preview for the project workspace/run, converts the running session to the public preview reference, validates the exact stored plan envelope, invokes `BrowserVerifier`, and stops in `finally`. If validation fails, return a deterministic failed report with the exact plan reference and validation message.

  In `executeStep`, load the latest named browser plan once, retain its exact revision/hash, include that reference in `stepIdempotencyKey`, and pass the stored artifact into `executeVerifyStep`. In browser mode, set attempt metadata to the internal browser verifier, record the plan in `inputArtifacts`, record `previewSessionId` in attempt context, store the report under `step.outputArtifact`, reuse `verification.completed`, and checkpoint only when approved. Leave the current workspace verifier branch byte-for-byte behaviorally equivalent.

- [ ] **Step 5: Add the browser quality loop**

  Insert between deterministic verification and release assessment:

  ```yaml
  - id: browser-verification
    type: quality-loop
    title: Browser verification gate
    maxIterations: 3
    setup:
      id: plan-browser-test
      type: agent
      role: tester
      taskKind: verification
      title: Define the reproducible browser test plan
      instructions: Produce a schemaVersion 1 declarative browser test plan for the critical CRUD journey. Use only relative app paths, supported semantic locators, actions, and assertions.
      inputArtifacts: [prd, plan.current, architecture.current, code.review, verification.report]
      outputArtifact: browser-test.plan
      mutatesWorkspace: false
      harnessTags: [testing, browser]
      maxAttempts: 3
    check:
      id: verify-browser
      type: verify
      title: Run the declarative browser test plan
      outputArtifact: browser-verification.report
      browserTestPlanArtifact: browser-test.plan
      scripts: []
      includeGitDiffCheck: false
    repair:
      id: repair-browser
      type: agent
      role: fixer
      taskKind: repair
      title: Repair browser verification failures
      instructions: Reproduce each failed step from the exact browser plan and report, repair the root cause, and retain the plan unchanged for the rerun.
      inputArtifacts:
        [prd, plan.current, architecture.current, browser-test.plan, browser-verification.report]
      outputArtifact: browser-verification.fix
      mutatesWorkspace: true
      harnessTags: [repair, browser, testing]
      maxAttempts: 3
    approval:
      artifact: browser-verification.report
      path: approved
      equals: true
  ```

  Add the browser plan/report to release-assessment inputs.

- [ ] **Step 6: Run focused tests, workflow validation, typecheck, and commit**

  Run:

  ```bash
  npx vitest run \
    packages/orchestrator/src/browser-verification-coordinator.test.ts \
    packages/orchestrator/src/policy-release-e2e.test.ts \
    packages/composition/src/runtime.integration.test.ts \
    packages/persistence/src/workflow-repository.test.ts
  npm run typecheck
  npm run architecture:check
  git diff --check
  git add packages/orchestrator packages/composition workflows/web-app-v1.yaml
  git commit -m "feat: orchestrate browser verification"
  ```

---

### Task 4: Documentation and branch verification

**Files:**

- Create: `docs/adr/0020-declarative-browser-verification.md`
- Modify: `docs/adr/README.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/VALIDATION.md`

**Interfaces:**

- Consumes: the implemented plan/report schemas, policy boundary, runtime flow, focused-test names, and CI installation command.
- Produces: operator/security/architecture/validation evidence and rollback guidance for issue #32.

- [ ] **Step 1: Write ADR 0020**

  Record context, decision, consequences, and rejected alternatives. State that browser tests are versioned declarative artifacts; Chromium runs only behind the domain port; preview traffic is limited to trusted loopback plus exact policy origins; JSON evidence is redacted and capped; binary evidence remains issue #33; stronger process/network isolation remains issue #120.

- [ ] **Step 2: Update operations, security, architecture, and validation docs**

  Document local/CI Chromium installation, the 10-second/60-second limits, diagnostics and observation kinds, origin normalization/enforcement, token redaction, artifact shapes and revision linkage, failure→repair→same-plan rerun, migration (optional policy/workflow fields), rollback (remove browser quality-loop node/runtime wiring while workspace verification continues), and explicit issue #32 acceptance/evidence commands.

- [ ] **Step 3: Run focused browser evidence**

  Run and preserve output for the PR/issue:

  ```bash
  npx vitest run \
    packages/contracts/src/preview.test.ts \
    packages/contracts/src/policy.test.ts \
    packages/contracts/src/workflow.test.ts \
    packages/persistence/src/workflow-repository.test.ts \
    packages/executors/src/browser-verifier.test.ts \
    packages/orchestrator/src/browser-verification-coordinator.test.ts \
    packages/orchestrator/src/policy-release-e2e.test.ts \
    packages/composition/src/runtime.integration.test.ts
  ```

- [ ] **Step 4: Run the full branch gate**

  Run every command and preserve concise pass counts:

  ```bash
  npm run format:check
  npm run lint
  npm run architecture:check
  npm run roadmap:check
  npm run typecheck
  npm test
  npm run build
  npm run doctor
  git diff --check
  ```

- [ ] **Step 5: Commit documentation**

  ```bash
  git add docs
  git commit -m "docs: document browser verification"
  ```

---

## Review, PR, and Evidence

- [ ] After every task, create a scoped `review-package` from that task's recorded base and require a fresh reviewer's spec-compliance and code-quality approval. Fix and re-review every Critical/Important finding.
- [ ] Create a whole-branch review package from `git merge-base main HEAD`; require final correctness approval and resolve all Critical/Important findings.
- [ ] Push `agent/issue-32-browser-verifier` and open exactly one PR to `main` containing `Closes #32` plus focused/full validation, security, migration, and rollback evidence.
- [ ] After the PR exists, run `ponytail-review` and `code-simplifier-v2` on the issue diff only. Apply every applicable finding, rerun focused tests and the full gate, and push.
- [ ] Monitor required GitHub checks and review threads until green/resolved.
- [ ] Comment on issue #32 with the PR URL/final commit, acceptance-criteria mapping, CRUD/UI/API/console/policy outputs, full validation output, and security/migration/rollback assessment.
