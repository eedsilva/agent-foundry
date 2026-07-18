# Preview Panel + Golden Flow E2E — Design

- **Issue:** [#34](https://github.com/eedsilva/agent-foundry/issues/34) — `[v0.5] Construir painel de preview responsivo e fechar golden flow end-to-end`
- **Depends on:** #33 (artifact/blob store — merged, PR #169)
- **Roadmap key:** `v05-preview-ui-e2e`
- **Date:** 2026-07-18

## Context

Agent Foundry can already run a full build pipeline (plan → architecture →
implementation → deterministic verification → browser verification →
release assessment), start an isolated preview session for a running app
(#28/#30/#31), and capture browser evidence — screenshots, trace, video,
console/network observations — as artifacts (#32/#33). None of this is
surfaced to a human. There is no preview panel in `apps/web`, no viewport
switching, no rendering of captured evidence, and no human checkpoint in the
default workflow where a person reviews a diff before release.

This issue closes that gap: a responsive preview panel in `apps/web`, and a
real human approval step in the golden flow (change request → preview →
browser tests → diff approval), backed by an E2E test.

## Non-goals

- No new `ChangeRequest` domain concept. Project creation (`POST /projects`)
  is already the golden flow's entry point.
- No live console/network tapping of the iframe via injected scripts. Console
  and network data comes from the already-captured
  `browser-verification.report` artifact.
- No new component library (Tailwind/shadcn) for `apps/web`. The existing
  hand-rolled CSS in `globals.css` is the house style and this issue doesn't
  need more than it already offers (buttons, panels, modals, pills).

## Architecture

No new domain concepts or contracts. This is additive UI plus two small
`apps/api` surfaces and one workflow config change.

```
User ──> apps/web (PreviewPanel, diff-approval modal)
           │  POST /projects (existing)         → change request
           │  GET  /projects/:id/preview/active  → resolve/reattach session (NEW)
           │  POST /projects/:id/preview         → start session (existing)
           │  GET  /projects/:id/preview/:sid/logs → runtime logs (existing)
           │  GET  /projects/:id                 → artifacts incl. browser-verification.report (existing)
           │  GET  /projects/:id/artifacts/:name/blob → screenshots/trace/video (existing, currently unused by UI)
           │  GET  /projects/:id/versions/compare → code diff for the approval modal (existing)
           │  POST /runs/:id/approvals/:rid/decide → approve/reject diff (existing)
           ▼
apps/api ──> orchestrator ──> workflows/web-app-v1.yaml (NEW: diff-approval gate)
```

## Components

### 1. `GET /projects/:projectId/preview/active` (apps/api, new)

Resolves the project's currently-running `PreviewSession`, if any, so a page
refresh or panel remount re-attaches to the live session instead of the
client always calling `POST .../preview` (which mints a brand-new session
every time today). Backed by `previewSessions.listActive()`
(`packages/domain/src/ports.ts`), which the implementation plan must confirm
supports filtering by project — if it only filters by workspace/global, the
port and its persistence implementation need a small, additive
`projectId`/`workspaceRef` filter parameter. Returns `{ session: null }` when
nothing is active; the client then falls back to the existing "start
preview" affordance.

### 2. `diff-approval` gate (`workflows/web-app-v1.yaml`, config only)

A new `approval-gate` node inserted after `browser-verification` and before
`release-assessment`:

```yaml
- id: diff-approval
  type: approval-gate
  title: Human diff approval
  artifact: browser-verification.report
  outputArtifact: diff.approval
  actions: [approve, reject, request-changes]
  onReject: return-to-step
  returnToStepId: implementation-gate  # exact target confirmed during implementation
  repairArtifact: diff.repair-notes
```

This mirrors the shape of the existing `release-approval` fixture in
`apps/api/src/approvals.test.ts` — the gate references the artifact that was
just produced (`browser-verification.report`), giving the panel's approval
modal a concrete `ArtifactReference` to key off. The actual code diff shown
to the human comes from the existing `/versions/compare` endpoint, not from
a new artifact.

### 3. `PreviewPanel` component (`apps/web`, new)

Extracted as its own component/file rather than added to the already
1075-line `app/project/[id]/page.tsx` (which stays focused on run
status/timeline/approvals list, and now also mounts `PreviewPanel`).

- **Viewport switcher:** desktop / tablet / mobile buttons, plain CSS
  width/height presets on the iframe's container (no new dependency).
- **Session resolution:** on mount, `GET .../preview/active`; if present,
  embed its `url` as the iframe `src`; if absent, show a "Start preview"
  button (`POST .../preview`, existing).
- **Tabs:**
  - *Runtime logs* — `GET .../preview/:sessionId/logs`, same poll pattern
    already used for the run timeline.
  - *Console & network* — `browser-verification.report.steps[].observations`
    (kinds: `console-error`, `request-failed`, `http-error`,
    `uncaught-exception`, `policy-block`), sourced from
    `GET /projects/:id`'s existing `artifacts[]`, filtered client-side by
    `metadata.runId`.
  - *Test results* — the same report's `steps[]` (status/duration/error),
    rendered as a pass/fail list.
- Screenshots render as an `<img>` filmstrip via the existing-but-unused
  `getArtifactBlobUrl` helper; trace/video render as download links (same
  helper). This closes the current gap where the artifact modal renders
  `null` for blob-backed artifacts.

### 4. Diff-approval modal (`apps/web`, extends existing decide modal)

When an `ApprovalRequest`'s artifact is `browser-verification.report`
(i.e., the `diff-approval` gate), the existing decide modal additionally
fetches and renders:
- the code diff via `/versions/compare` (reusing the `diffLines` renderer
  already used on the versions page), comparing the project's last
  protected version against the version produced by this run,
- the same verification evidence view as the panel (steps, observations,
  screenshot filmstrip),

so the human approves/rejects with full context in one screen. Approve/
reject/request-changes continues to POST to the existing
`/runs/:id/approvals/:requestId/decide` endpoint — no API change.

## Data flow (golden flow, end to end)

1. User submits a PRD via the existing home-page form → `POST /projects`
   (the "change request").
2. Orchestrator runs `web-app-v1.yaml` through plan/architecture/
   implementation/deterministic-verification/browser-verification as today.
3. Run reaches the new `diff-approval` gate and halts.
4. User opens the project page. `PreviewPanel` resolves/starts a live
   preview session, embeds it in an iframe, and shows logs/console/network/
   test-results tabs from the just-produced evidence.
5. User opens the pending approval, reviews the diff + evidence in the
   extended decide modal, and approves (or rejects / requests changes,
   which re-queues the run through the existing repair mechanism).
6. Run proceeds to `release-assessment` and completes.

## Error handling

- `/preview/active` returning `null` is a normal state (no preview started
  yet), not an error — the panel shows the start affordance.
- If the active session's process has crashed (`preview.crashed` /
  `preview.failed` events already exist), the panel's existing SSE
  subscription surfaces this; the iframe shows the proxy's existing error
  response rather than the panel silently hanging.
- Blob artifact fetch failures (410 Gone for reaped blobs, 404 for
  never-written) render inline as "evidence expired/unavailable" rather than
  breaking the panel — these HTTP statuses already exist in the `/blob`
  route.
- `request-changes` on the diff-approval gate requires a note, matching the
  existing decide-modal validation for other approval gates.

## Testing

- **Unit/integration (`apps/api`):** new test(s) for `GET .../preview/active`
  (no session → null; active session → returned; stopped/expired session →
  not returned) following the existing `preview.test.ts` house style
  (`createRuntime` + `buildApp` against a temp `DATA_DIR`).
- **Web unit tests:** `apps/web/lib/api.test.ts`-style mocked-fetch coverage
  for the new client calls (`getActivePreviewSession`, report-derived
  observations/steps parsing).
- **E2E (`apps/web/e2e/golden-flow.spec.ts`, new):** Playwright +
  `@axe-core/playwright`, new devDependencies (`@playwright/test`,
  `@axe-core/playwright`), new `playwright.config.ts`. Drives a real Next.js
  dev server and a real `apps/api` server (temp `DATA_DIR`, ephemeral port)
  against a **fixture workflow** — deterministic steps (no LLM calls),
  mirroring `FIXTURE_WORKFLOW` in `apps/api/src/approvals.test.ts` — with a
  real, non-mock preview session and real Playwright browser-verifier run
  against the existing `packages/executors/src/fixtures/preview-dev-server.mjs`
  fixture app. This keeps the E2E fast/deterministic/free of model calls
  while still exercising real iframes, the real reverse proxy, real
  console/network capture, and a real axe scan.
  - Flow: submit change request → poll run to the `diff-approval` gate →
    open the preview panel → switch all three viewports → assert logs,
    console/network, and test-results tabs render real data → run axe
    against the panel and assert no violations → approve the diff via the
    UI → assert the run completes.
  - `*.spec.ts` naming avoids collision with Vitest's existing
    `**/*.test.ts` include pattern (`vitest.config.ts`), so no test-runner
    config conflict.

## Open questions for the implementation plan (not blocking design approval)

- Exact `previewSessions.listActive()` signature — confirm whether a
  project-scoped filter already exists or needs a small additive parameter.
- Exact `returnToStepId` for the `diff-approval` gate's `request-changes`
  path (repair should return to `implementation-gate`; confirm against how
  other `onReject: return-to-step` gates in this codebase target loop
  `setup` vs. the loop id itself).
- Exact version identifiers to pass to `/versions/compare` for "diff since
  last protected version" — depends on when `ProjectVersion` entries are
  written relative to the new gate.
