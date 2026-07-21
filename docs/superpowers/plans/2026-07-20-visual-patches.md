# Structured Visual Patches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user preview a safe structured visual change, then promote it through source editing, deterministic verification, browser verification, one commit, and one ProjectVersion.

**Architecture:** A `VisualEdit` is a validated contract attached to a `visual-edit` Operation. The preview iframe applies it only temporarily; promotion sends the exact contract to the existing conversation execution path. That path keeps the workspace uncommitted until required checks pass, then commits and records the version atomically from the operation perspective.

**Tech Stack:** TypeScript, Zod, Fastify, React/Next.js, Vitest, Playwright.

## Global Constraints

- Work only on `agent/issue-42-visual-patches`; do not alter or push `main`.
- Direct editing is limited to text, color/token reference, spacing, typography, and responsive layout properties listed in the contract.
- Ambiguous or unsafe edits remain conversational; they never become a direct source mutation.
- A temporary iframe preview must not write workspace files or create a commit.
- Promotion runs `typecheck`, `lint`, `test`, `build`, and browser verification before its sole commit and ProjectVersion.
- Failed promotion rolls the workspace back to its initial clean checkpoint and writes no ProjectVersion.
- No new runtime dependency or persistence migration.

---

### Task 1: Visual-edit contract and safe preview protocol

**Files:**
- Create: `packages/contracts/src/visual-edit.ts`, `packages/contracts/src/visual-edit.test.ts`
- Modify: contract barrel exports, conversation/API/preview contracts, `apps/api/src/preview-inspector-script.ts`, `apps/api/src/preview-inspector-script.test.ts`, `apps/web/app/project/[id]/preview-panel.tsx`
- Test: focused Vitest contracts/script tests and Playwright preview interaction coverage.

- [ ] Write failing contract tests for each allowed property family, responsive layout breakpoint, resolved target source, and unsafe/invalid rejection.
- [ ] Implement the smallest strict Zod `VisualEdit` schema: `target`, `property`, `oldValue`, `newValue`, optional breakpoint; token references are allowed only as `var(--name)` values.
- [ ] Extend only resolved selection results with source line/column/component metadata and preserve existing result fields.
- [ ] Write failing inspector tests for temporary text/style apply and clear behavior.
- [ ] Implement origin-checked `af:visual-edit:preview` and `af:visual-edit:clear` messages against the last selected element, saving/restoring originals without mutating workspace source.
- [ ] Add the PreviewPanel direct-control UI for preview/clear only, and route ambiguous/unsupported/unsafe requests to the existing chat classification flow. Do not add a promotion request until Task 2 provides its API.
- [ ] Run focused tests and commit the contract/preview slice.

### Task 2: Validated visual-edit operation and promotion gates

**Files:**
- Modify: `apps/api/src/app.ts`, `apps/api/src/app.test.ts`, `apps/web/lib/api.ts`, `packages/orchestrator/src/operation-service.ts`, `packages/orchestrator/src/conversation-step-config.ts`, `packages/orchestrator/src/conversation-operation-runner.ts`, `packages/composition/src/runtime.ts`
- Test: operation-service, conversation-operation-runner, API, and composition tests.

- [ ] Write failing API/service tests for a project-owned live session, source containment, generated canonical conversation message, and queued `visual-edit` operation.
- [ ] Add `POST /projects/:projectId/preview/:sessionId/visual-edits`; validate session ownership, `VisualEdit`, and workspace-relative source before starting the operation.
- [ ] Enable the Task 1 direct-control panel's promotion action through that endpoint, leaving the temporary iframe preview in place until the user clears it or selects another element.
- [ ] Attach `visualEdit` optionally to Operation and make free-form visual change requests run a non-mutating clarification step until a resolved direct patch is supplied.
- [ ] Write failing runner tests for clean-baseline enforcement, exact visual-edit prompt provenance, verification-before-commit ordering, one ProjectVersion, and rollback on each gate failure.
- [ ] Treat a direct visual edit as a mutating developer step whose prompt requires the named source target and preservation of existing Tailwind/CSS token usage.
- [ ] After agent output, run canonical deterministic scripts and a bounded browser smoke plan; text edits assert the requested text, style edits prove startup/no browser errors and preserve screenshot evidence.
- [ ] Commit only after both reports approve, require a non-empty source diff, persist all evidence references, and record exactly one ProjectVersion; rollback on every non-success path.
- [ ] Run focused tests and commit the operation/promotion slice.

### Task 3: End-to-end proof and delivery evidence

**Files:**
- Create: `apps/api/e2e/visual-patches.spec.ts`
- Modify: only shared E2E fixtures if required by the new scenarios.

- [ ] Write failing Playwright scenarios for text, padding, token color, and responsive layout.
- [ ] Prove each control temporarily updates the selected iframe element before any promotion request.
- [ ] Prove an ambiguous or invalid direct request opens the conversational fallback instead of a direct operation.
- [ ] Run focused E2E and commit the evidence slice.

### Task 4: Final validation, review, and PR

- [ ] Run `npm run check`, `npm run e2e --workspace @agent-foundry/api`, `npm run doctor`, and `git diff --check`.
- [ ] Push the feature branch and create a PR closing #42 with tests, rollback, compatibility, security, and observable-preview evidence.
- [ ] Run Ponytail over-engineering review and a behavior-preserving code-simplifier pass on the PR diff; fix every concrete finding and re-run affected tests plus the full gates.
- [ ] Push review fixes, inspect live GitHub checks, and report their final state.

## Assumptions

- Design-token control applies an existing CSS custom-property reference to the selected element; changing the global token definition remains conversational because it affects multiple consumers.
- Style-only browser verification is a bounded startup/error/screenshot check until the source map can emit stable selectors suitable for computed-style assertions.
