# DOM Source Map — Design

**Issue:** [#41](https://github.com/eedsilva/agent-foundry/issues/41) — `[v0.6] Mapear elemento selecionado no preview para componente e origem no código`
**Roadmap key:** `v06-dom-source-map`

## Goal

When a user clicks an element in the live preview iframe, resolve that click to
a small, explainable set of source files/components so a future "visual edit"
can target them precisely — never an arbitrary file, never a path outside the
project workspace.

## Context (as found in the codebase today)

- The preview iframe (`apps/web/app/project/[id]/preview-panel.tsx:251-256`)
  points at `apps/api/src/preview-proxy.ts`, which reverse-proxies to a real
  `next dev` process spawned per project
  (`packages/executors/src/node-preview-runner.ts`). The proxy origin is
  **cross-origin** from `apps/web` (`preview-service.ts` mints a
  per-session signed URL/token). This means `apps/web` cannot reach into the
  iframe's DOM directly — any in-page instrumentation must be served as part
  of the proxied response itself.
- Today's stack is always Next.js/React (`workflows/web-app-v1.yaml:5`,
  `stack: nextjs`) — there is no framework-selection mechanism, and no
  existing DOM→source instrumentation of any kind (confirmed by repo-wide
  grep — see research notes).
- `packages/executors/src/browser-verifier.ts` already drives a headless
  Playwright browser against a preview session for the scheduled `verify`
  workflow step, including `context.addInitScript(...)`, `page.evaluate(...)`,
  and screenshot capture. That pipeline runs once per delivery run — it is
  **not** the live path the user's own browser takes when looking at the
  iframe, but its screenshot capability is reusable for the fallback case
  below.
- `packages/persistence/src/workspace-manager.ts` +
  `packages/persistence/src/fs-utils.ts` (`safeSegment`) define the on-disk
  workspace layout; `packages/domain/src/sandbox-runner.ts:65-71` has the
  closest existing "is this path inside an allowed root" check
  (`path.relative` + `..`-prefix rejection), but nothing today validates an
  arbitrary file path read back from a browser-supplied hint.
- `apps/web/app/project/[id]/page.tsx:766-790` already has an inline
  "ambiguous, please confirm" panel pattern (for chat-message
  plan/build classification) and a modal pattern (`:1283-1378`) for
  blocking confirm/reject decisions. We reuse the inline-panel style for
  ambiguous selection — it doesn't block the whole screen.

## Architecture

### 1. Inspector script, injected at the proxy layer

`apps/api/src/preview-proxy.ts` already owns the only place that can modify
what the iframe receives (it's the only cross-origin-capable injection
point). We extend it to rewrite `text/html` **top-level document** responses
only (not sub-resources, not the WebSocket/HMR upgrade path) by appending a
small inline `<script>` before `</body>`.

The script does nothing until told to:

- Parent (`apps/web`) toggles "Select element" mode by
  `iframe.contentWindow.postMessage({ type: 'af:selection:start' }, previewOrigin)`.
- While active, a single capturing `click` listener on `document` calls
  `event.preventDefault()` / `stopPropagation()` (so the click never triggers
  real app navigation), then computes:
  - **DOM path**: breadcrumb of `tagName[nth-of-type]` from the clicked node
    up to `<body>`.
  - **Bounding box**: `element.getBoundingClientRect()`.
  - **Computed style**: a small fixed allow-list of properties (`display`,
    `position`, `width`, `height`, `color`, `background-color`, `font-size`,
    `font-family`) — not the full `CSSStyleDeclaration`, to keep the payload
    small and avoid ever leaking something a screenshot wouldn't already show.
  - **Source candidates**: walk the React Fiber tree. React (in dev mode,
    which `next dev` always uses) attaches a fiber to every DOM node under a
    key matching `/^__reactFiber\$/`, and each fiber carries `_debugSource:
    {fileName, lineNumber, columnNumber}` and `type`/`_debugOwner` for the
    component name. Starting at the clicked node's fiber, walk `fiber.return`
    up to the app root, collecting `{fileName, line, column, componentName}`
    for every fiber that has a named component type, de-duplicating adjacent
    frames that share the same `fileName`+`line` (this is what collapses a
    `list.map(...)` repeated item down to one candidate instead of N).
  - If no `__reactFiber$*` property is found on the clicked node (non-React
    output, a prod build without dev fiber metadata, or a framework we don't
    instrument), `candidates` is `[]` and `unsupported: true` is set — this is
    the "framework not supported" degrade path.
- Result is posted back: `window.parent.postMessage({ type:
  'af:selection:result', payload }, appOrigin)`. Both sides check
  `event.origin` against the expected counterpart before trusting a message.

This script is **only ever served by the proxy for live dev-preview
requests**. The publish/deploy pipeline builds and serves a separate static
production bundle that never passes through `preview-proxy.ts`, so the
"preview injects *unpublished* metadata" acceptance criterion is satisfied by
construction — we add a test asserting the injected script is absent from
whatever the publish pipeline emits.

### 2. Resolution, server-side

`apps/web` posts the raw client payload to a new endpoint (`apps/api`
route, thin — validates + delegates), which calls a new
`packages/orchestrator/src/preview-selection-service.ts`:

```
resolvePreviewSelection(projectId, rawSelection) -> PreviewSelectionResult
```

This:

1. Re-validates the shape with a new Zod schema (never trust the browser).
2. For each candidate `fileName`, resolves it against the project's
   `workspacePath(projectId)` using a **new** containment guard —
   `resolveWorkspaceRelativePath(workspaceRoot, candidatePath)`. This lives in
   `packages/domain/src/workspace-paths.ts`, **not** persistence: the repo's
   architecture check (`scripts/lib/architecture.mjs`) only allows
   `@agent-foundry/orchestrator` to depend on `@agent-foundry/contracts` and
   `@agent-foundry/domain`, never on `@agent-foundry/persistence` or
   `@agent-foundry/executors` directly — so this guard, and the on-demand
   screenshot capability (item 3 below), are defined as domain interfaces and
   wired to their concrete implementations only in `packages/composition`,
   the same way `BrowserVerifier`/`WorkspaceManager` already work. Follows the
   same rejection family as `sandbox-runner.ts`'s `isAllowed` (resolve,
   compare with `path.relative`, reject `..`/absolute escapes). Any candidate
   that resolves outside the workspace is dropped and logged, never returned
   to the client.
3. Classifies the result:
   - **`resolved`** — exactly one distinct in-workspace file among the
     (de-duplicated) candidates.
   - **`ambiguous`** — 2+ distinct in-workspace files remain (e.g. a wrapper
     component and its child both plausible) — the client must ask the user
     to confirm rather than editing an arbitrary one.
   - **`unsupported`** — no candidates at all (non-React output, or every
     candidate was outside the workspace). In this case the service also
     triggers a **best-effort screenshot** of the clicked region by reusing
     `packages/executors/src/browser-verifier.ts`'s existing Playwright
     screenshot capability against the same preview session (short-lived,
     on-demand, not the full scheduled `verify` flow) — giving the user
     "screenshot + description" instead of a source mapping.

### 3. Contracts (`packages/contracts/src/preview.ts`)

New types alongside the existing `BrowserLocator`/`BrowserVerificationReport`
family, following the file's `XxxSchema` + `z.infer` + `.strict()`
convention:

- `PreviewSelectionCandidateSchema` — `{ fileName, line, column,
  componentName? }` (raw, client-reported, pre-validation).
- `PreviewSelectionRequestSchema` — `{ domPath, boundingBox, computedStyle,
  candidates: PreviewSelectionCandidate[] }` (raw, posted by `apps/web`).
- `PreviewSelectionResultSchema` — `{ status: 'resolved' | 'ambiguous' |
  'unsupported', domPath, boundingBox, computedStyle, file?: string
  (workspace-relative), candidates?: string[] (workspace-relative, only for
  `ambiguous`), screenshot?: ArtifactMetadata (only for `unsupported`) }`
  (validated, server-produced — the only shape the client acts on).

### 4. UI (`apps/web`)

- A "Select element" toggle button on `PreviewPanel`, next to the existing
  preview controls.
- A `message` listener validating `event.origin` against the current
  session's preview origin, forwarding the raw payload to the new resolution
  endpoint, and rendering by `status`:
  - `resolved` → inline confirmation of the target file (ready for whatever
    consumes it next — out of scope for this issue, which only needs to
    *identify* the file).
  - `ambiguous` → the existing inline confirm/discard panel style
    (`page.tsx:766-790`) listing the candidate files as choices — user picks
    one or discards; we never auto-pick.
  - `unsupported` → the existing evidence-screenshot rendering (reused from
    `VerificationReportView`) plus the DOM path as a text description.

## Testing strategy

The four required acceptance scenarios — **simple component, wrapper,
repeated list, generated/dynamic element** — map to:

- **Fiber-walk + resolution logic** (`preview-selection-service`): pure unit
  tests using hand-built fake fiber objects (jsdom, no real React/webpack
  needed — our code only depends on the documented fiber shape:
  `type`/`return`/`_debugSource`/`_debugOwner`):
  - *Simple*: one fiber, one file → `resolved`.
  - *Wrapper*: two nested named fibers, two distinct files → `ambiguous`.
  - *Repeated list*: N fibers sharing one `fileName`+`line` → collapses to
    one candidate → `resolved`.
  - *Generated element*: no `__reactFiber$*` present → `unsupported`, and the
    Playwright screenshot fallback is invoked.
- **Workspace containment guard**: unit tests feeding `../../etc/passwd`-style
  and absolute-outside-workspace `fileName`s, asserting rejection + logging.
- **Injected script presence**: an integration test on `preview-proxy.ts`
  asserting the script is appended to `text/html` top-level responses and
  absent from non-HTML/sub-resource responses.
- **End-to-end**: one Playwright spec (extends the existing
  `apps/api/e2e/golden-flow.spec.ts` fixtures) that spins a real preview
  session serving a tiny fixture Next.js-style page with the four DOM
  shapes above, drives real clicks through the proxied iframe, and asserts
  the full round trip (click → postMessage → resolution → UI panel).
- **Ambiguous/unsupported UI**: component-level tests in `apps/web` for the
  confirm panel and the screenshot-fallback panel.

## Security notes

- Injected script is inert until explicitly activated by a `postMessage`
  from the parent, and only runs inside the sandboxed dev-preview
  session's own document — it cannot read anything outside that document.
- All `postMessage` traffic is origin-checked on both ends.
- File path candidates are treated as untrusted hints and re-validated
  server-side against the workspace root before ever being returned to the
  client or acted on; rejections are logged (project id, rejected path,
  reason) for diagnosability without ever logging the escaped path's
  contents.
- No new persistent storage is introduced — selection results are ephemeral
  (request/response), except the on-demand fallback screenshot, which reuses
  the existing artifact storage path already used by scheduled verification.

## Out of scope (this issue)

- Actually *applying* an edit to the resolved file(s) — that's issue #42
  ("Aplicar edições visuais como patches estruturados e verificáveis"),
  already tracked separately.
- Any framework other than Next.js/React — everything else is the
  `unsupported` degrade path.
