# Plan — Issue #97: Polir builder, acessibilidade, responsividade e performance percebida

Spec: GitHub issue eedsilva/agent-foundry#97 (milestone v1.0 — Personal Builder).
Complementary, non-overlapping with ADR 0061 (#488 simple/Advanced builder) and #469
(generated-app UI quality — a different surface).

## Spec — the five acceptance criteria, verbatim

1. Chat, preview e changes têm estados vazios, loading, erro e recovery consistentes.
2. Keyboard navigation e WCAG 2.2 AA são verificadas nos fluxos principais.
3. Builder funciona em telas menores com degradação planejada.
4. Long tasks mostram progresso útil e ações seguras.
5. Budgets de performance são definidos e medidos.

Mandatory tests: axe, keyboard-only e Web Vitals nos fluxos golden.

## What already exists (surveyed 2026-08-15, do not rebuild)

- `apps/api/e2e/golden-flow.spec.ts` (1137 lines) is the golden-flow Playwright suite. It
  already runs a **whole-page axe scan** (`expectNoAxeViolations`, line 43-63) with tags
  `wcag2a wcag2aa wcag21a wcag21aa` across five surfaces (`builder`, `builder/mudancas`,
  `versions`, `router`, `home`), excluding only `[data-testid="preview-frame"]`. It already
  asserts dialog Escape + focus-return, the ARIA tablist keyboard pattern (Arrow/Home/End),
  and one narrow-viewport check at 900px (panes stack, no horizontal overflow). Measured
  baseline on this branch: **4 passed in 35s**, no Docker, via
  `npm run build:packages && npm run e2e --workspace @agent-foundry/api -- golden-flow.spec.ts`.
- **The a11y baseline is already good** — surveyed across all 41 non-test `.tsx` files:
  zero `onClick` on non-semantic elements, every input labelled, the one icon-only button
  (`components/overlay.tsx:132`) has `aria-label="Fechar"`, dialogs are native `<dialog>` +
  `showModal()` with an explicit opener-refocus, and heading levels are monotonic with one
  `h1` per route. Do not go looking for basic a11y bugs; they are not there. What is
  missing is a skip link, WCAG 2.2's new criteria, and the states/progress work below.
- `@axe-core/playwright@^4.10.2` and `@playwright/test@1.62.1` are already devDependencies
  of `apps/api`. **Do not add jsdom, happy-dom, @testing-library, or web-vitals.**
- `apps/web/components/empty-state.tsx` — the only shared state primitive.
- `apps/web/app/project/[id]/run-alert-strip.tsx` — `AlertStrip` (tone dot + title + detail
  + actions slot) and `RunAlertStrip`, already covering awaiting_approval / paused /
  resume-blocked / provisioning-error / generic-error.
- `apps/web/lib/ui.ts` — the shared class-token strings (`BTN`, `ERROR_BOX`, `HINT`, …).
- `apps/web/app/project/[id]/advanced-mode.ts` — per-project localStorage `useAdvancedMode`.

## Global Constraints

Every task must satisfy all of these. Violating one is a review defect.

- **TDD is mandatory.** Write the failing test, run it, paste the failure output into your
  report, then implement. A test that passed the first time you ran it is not evidence.
- **Portuguese for every user-facing string.** The shell is `lang="pt-BR"`; all existing
  labels are Portuguese ("Avançado", "Pausar", "Nenhum artefato ainda."). No English in
  rendered text, `aria-label`s, or `title`s.
- **No new dependencies.** Not runtime, not dev. Everything needed is installed.
- **Design tokens only.** No raw hex, no stock Tailwind palette colours. Use the CSS
  variables/utilities already in `apps/web/app/theme.css` and the class strings in
  `apps/web/lib/ui.ts`. Any text you add must clear 4.5:1 contrast (DESIGN.md §7) —
  `--ink` on a `/10` tone wash is the established pattern, `text-err` on `bg-err/10` is
  not (see the comments in `lib/ui.ts`).
- **Unit tests are `renderToStaticMarkup` from `react-dom/server` under vitest's `node`
  environment.** There is no DOM, no jsdom, no `@testing-library`. Follow the existing
  shape in `apps/web/app/project/[id]/builder-shell.test.tsx`. Anything needing a real DOM
  belongs in the Playwright e2e instead.
- **Presentational split for testability.** When a component's state branches cannot be
  reached from `renderToStaticMarkup` (because they live behind `useEffect`/fetch), extract
  a pure presentational sub-component the way `inspector/files-tab.tsx` extracts
  `FilesTabView`, and test that.
- **Per-task typecheck.** Every task that touches a `.ts`/`.tsx` file runs
  `npx tsc -b --pretty false` from the repo root and reports its output. Vitest alone does
  not typecheck; `exactOptionalPropertyTypes` errors have slipped past review twice.
- **Formatting.** Run `npx prettier --write` on every file you touched, and
  `git diff --check` must be clean (no trailing whitespace, no missing final newline)
  before you commit.
- **Test-bucket partition.** New vitest files under `apps/web/` land in the fast bucket
  automatically. If you add a test file anywhere else, verify with
  `npx vitest list --filesOnly` that fast + slow still equals the total, and update both
  globs in `package.json` together.
- **Commit per task**, message `feat(#97): <what>` or `fix(#97): <what>`. Do not amend or
  rebase other tasks' commits.

### Verification commands

- Unit, inner loop: `npx vitest run apps/web --pool=threads` (~2s, 34 files).
- Typecheck: `npx tsc -b --pretty false`.
- Golden-flow e2e (Tasks 4 and 5 only):
  `npm run build:packages && npm run e2e --workspace @agent-foundry/api -- golden-flow.spec.ts`
  (~5-10 min).

---

## Task 1 — One state primitive for empty, loading and error, applied to all three panes

**Criterion 1.** Today the three panes render the same three concepts five different ways:
`EmptyState` for empty; a bare `<p className={HINT}>Carregando…</p>` in `preview-panel.tsx`
for loading; `EmptyState title="Carregando arquivos…"` in `files-tab.tsx` for loading;
`<p role="alert" className={ERROR_BOX}>` for error in three files; `EmptyState title={error}`
for error in `files-tab.tsx`; and nothing at all in two places where loading is
indistinguishable from empty.

### Deliverable

Replace `apps/web/components/empty-state.tsx` with `apps/web/components/pane-state.tsx`:

```tsx
export function PaneState({
  kind,          // 'empty' | 'loading' | 'error'
  title,
  hint,
  action,
}: {
  kind: 'empty' | 'loading' | 'error';
  title: string;
  hint?: string;
  action?: ReactNode;
})
```

Required behaviour, each of which gets its own test:

- `kind="empty"` renders the exact markup `EmptyState` renders today (same wrapper classes,
  same `title`/`hint`/`action` treatment), with no live-region role. The existing contrast
  assertion in `empty-state.test.tsx` must be carried over unchanged.
- `kind="loading"` adds `role="status"` and `aria-busy="true"` to the wrapper.
- `kind="error"` adds `role="alert"` and renders on the `--err` tone wash (the `ERROR_BOX`
  colour pattern: `--ink` text on `bg-err/10` with `border-err/30`), so an error is visually
  distinguishable from an empty state rather than differing only by its string.
- `data-testid="pane-state"` and `data-kind={kind}` on the wrapper, so the e2e can assert on
  state without matching Portuguese copy.

Delete `empty-state.tsx` and `empty-state.test.tsx`. There must be exactly one such
primitive when you are done — do not leave `EmptyState` behind as an alias.

### Call sites to migrate (all of them)

| File | Change |
|---|---|
| `apps/web/app/project/[id]/conversation-list.tsx:65-70` | `PaneState kind="empty"`. **Also add the missing loading state**: `ChatPane` receives `conversation: ConversationPageResponse \| null`; `null` currently renders the same "Nenhuma mensagem ainda." as a genuinely empty conversation. Render `kind="loading"` while `conversation === null`. |
| `apps/web/app/project/[id]/chat-pane.tsx:274-278` | `conversationError` becomes `PaneState kind="error"`, keeping the string. |
| `apps/web/app/project/[id]/chat-pane.tsx:279-294` | The preview-failure recovery card keeps its "Try to fix" button but the button's label must be Portuguese — rename it **"Tentar corrigir"** (matching `builder-header.tsx`'s existing "Tentar novamente"). Update `chat-pane.test.tsx`, which asserts on the current label. Render the card through `PaneState kind="error"` with the button in `action`. |
| `apps/web/app/project/[id]/preview-panel.tsx:675-679` (`panelError`) and `:717-721` (`selectionError`) | `PaneState kind="error"`. |
| `apps/web/app/project/[id]/preview-panel.tsx:681-682` | `!sessionLoaded` → `PaneState kind="loading" title="Carregando…"`. |
| `apps/web/app/project/[id]/preview-panel.tsx:900-914` | The two bottom-tab empties (`Nenhum log de runtime ainda.`, `Nenhuma verificação de navegador ainda para esta execução.`) → `PaneState kind="empty"`. |
| `apps/web/app/project/[id]/inspector/files-tab.tsx:99,101,103,124,126` | Loading → `kind="loading"`; both error cases → `kind="error"`; empty → `kind="empty"`. |
| `apps/web/app/project/[id]/inspector/run-tab.tsx:20-26` | Same loading/empty conflation as ChatPane: `!runDetail` is loading, `runDetail.steps.length === 0` is empty. Split them. |
| `apps/web/app/project/[id]/inspector/{activity,changes,artifacts,router}-tab.tsx` | Straight `EmptyState` → `PaneState kind="empty"` rename. |
| `apps/web/app/project/[id]/inspector/model-pin-panel.tsx:161-165` | `draftError` → `PaneState kind="error"`. Leave its `return null` when `!run || !evidence` alone — that panel is genuinely not applicable then, not empty. |

Leave `AlertStrip`/`RunAlertStrip` alone. It is a page-level banner, a different primitive
with a different job; Task 2 owns it.

### Recovery actions

Three of the migrated error states can retry and currently cannot. Give each a
`PaneState action` button that re-runs the failed operation:

- `files-tab.tsx` `error` (the listing fetch) → **"Tentar novamente"**, re-runs the listing
  fetch.
- `files-tab.tsx` `contentError` (the selected-file fetch) → **"Tentar novamente"**, re-runs
  the content fetch for the currently selected path.
- `preview-panel.tsx` `panelError` → **"Tentar novamente"**, re-runs whichever of
  `start()`/`stop()` failed. If threading that is more than a few lines, retry `start()`
  only and say so in your report.

`chat-pane.tsx`'s `conversationError` and `model-pin-panel.tsx`'s `draftError` come from
user-initiated form submissions where the form is still on screen — no retry button, the
user re-submits. Do not add one.

### Tests (write first, watch each fail)

- `apps/web/components/pane-state.test.tsx` — one test per `kind` asserting the role /
  `aria-busy` / `data-kind` contract, plus the carried-over contrast assertion.
- Extend `apps/web/app/project/[id]/inspector/files-tab.test.tsx` (it already covers all
  five states via `FilesTabView`) to assert the new `data-kind` values and that both error
  states render a "Tentar novamente" button.
- New `apps/web/app/project/[id]/conversation-list.test.tsx` — asserts `conversation={null}`
  renders `data-kind="loading"` and `conversation` with zero messages renders
  `data-kind="empty"`. These must be two distinct states.
- New `apps/web/app/project/[id]/inspector/run-tab.test.tsx` — same loading-vs-empty split.
- Update `chat-pane.test.tsx` for the "Tentar corrigir" label.

For `preview-panel.tsx`, whose state branches sit behind `useEffect`, extract only what you
need to reach the branches, following `FilesTabView`. If extraction would be a large
refactor of a 33KB file, do not do it — state that in your report and let the e2e in Task 4
cover those branches instead.

---

## Task 2 — Useful progress and safe actions for long-running tasks

**Criterion 4.** During a long run the builder shows a `StatusPill` with a status word, a
last-updated wall-clock `<time>`, and a raw event log. There is no elapsed timer, no
"step N of M", and the only cancel affordance is a "Cancelar" button buried inside
`conversation-list.tsx`'s live-stream panel, visible only for the active conversation
operation.

### Deliverable

A `running` case in `RunAlertStrip` (`apps/web/app/project/[id]/run-alert-strip.tsx`),
rendered when `run.status === 'running'`, carrying:

- **Step progress** — "Step {done} de {total}". `total` comes from the workflow definition
  already loaded by `use-project-run.ts` (`workflowDef`); `done` is the count of steps in
  `runDetail.steps` that have reached a terminal status. If `workflowDef` is unavailable,
  degrade to "Step {done}" with no denominator rather than rendering a wrong total.
- **Elapsed time** — from the run's start to now, formatted by a new pure helper, ticking
  once per second.
- **Current step name** — the title of the step currently in a non-terminal state, when
  there is exactly one.
- **Safe actions in the strip's existing `actions` slot** — "Pausar" (the same handler
  `builder-header.tsx` already uses) and "Cancelar" for the active operation run, so the
  stop affordance is reachable from the simple two-pane view without hunting through the
  chat stream. Do not remove the existing controls from `builder-header.tsx` or
  `conversation-list.tsx`; this surfaces the same handlers in a second, findable place.
- The strip already carries `role="status"` for non-error tones, so progress changes are
  announced politely. Do not add a second live region.

### Where the logic goes

All derivation is pure and goes in a **new** `apps/web/app/project/[id]/run-progress.ts`:

```ts
export function formatElapsed(ms: number): string;               // "2m 14s", "45s", "1h 03m"
export function runProgress(
  runDetail: RunDetailResponse | null,
  workflowDef: WorkflowDefinition | null,
): { done: number; total: number | null; currentStepTitle: string | null };
```

`run-alert-strip.tsx` renders; it does not compute. The ticking clock is a `useEffect`
+ `setInterval(…, 1000)` in the component that must clear on unmount — but `formatElapsed`
itself takes a number, so every formatting case is unit-testable without a timer.

### Tests (write first, watch each fail)

- New `apps/web/app/project/[id]/run-progress.test.ts` — `formatElapsed` boundaries
  (0, 59s, 60s, 61s, 3599s, 3600s, 3661s) and `runProgress` cases: no runDetail, no
  workflowDef (total is `null`), all steps terminal, exactly one in flight, more than one
  in flight (`currentStepTitle` is `null`).
- Extend `apps/web/app/project/[id]/run-alert-strip.test.tsx` with a `running` case
  asserting the step counter text, the elapsed text, and that both "Pausar" and "Cancelar"
  render as buttons.

### Do not

Do not add a percentage bar. Step counts are the honest unit here — the DAG's steps are not
equal-cost and a percentage would be a fabrication.

---

## Task 3 — Planned degradation on smaller screens

**Criterion 3.** `builder-shell.tsx` already stacks to one column below `lg` (1024px) and
the e2e already asserts that at 900px. The gaps are everything inside the panes:
`builder-header.tsx`, `chat-pane.tsx`, `conversation-list.tsx`, `run-alert-strip.tsx`,
`changes-panel.tsx`, `version-history.tsx`, `agent-artifact-view.tsx`, `diff-view.tsx` and
`inspector/{run,activity}-tab.tsx` have **zero** responsive prefixes between them, and
`builder-header.tsx` packs a title, a `StatusPill`, a `<time>`, an "Avançado" toggle and up
to three action buttons into one non-wrapping row.

### Deliverable

The builder is usable at **390px** (an iPhone-class viewport) with no horizontal document
overflow on any surface, and no content clipped or unreachable. Specifically:

- `builder-header.tsx` — the control group wraps instead of overflowing. Use `flex-wrap`
  and a `sm:`-prefixed row layout; keep the desktop appearance byte-identical at ≥640px.
- Long unbroken strings (run IDs, commit SHAs, file paths, workspace paths) must not widen
  the document. They scroll inside their own container or wrap — the `MONO_PANE` token in
  `lib/ui.ts` already carries `overflow-x-auto max-w-full` for exactly this; use it, or
  `break-all`/`min-w-0` where a mono pane is wrong. Audit `diff-view.tsx`,
  `agent-artifact-view.tsx`, `version-history.tsx` and `inspector/run-tab.tsx` for this.
- A grid or flex child that must shrink needs `min-w-0` — without it CSS grid's `auto`
  minimum keeps the track at its content width and the document widens. This is the single
  most likely cause of any overflow you find.
- **The one deliberate degradation, documented:** below `lg` the Inspector stacks below
  the other two panes rather than being hidden. That is the existing behaviour and it is
  correct — record it in the ADR from Task 5 rather than changing it.

### Method

Do not guess at which elements overflow. Add the narrow-viewport probe to the e2e first
(it is fast to iterate on with `--grep`), read what it reports, and fix that. The probe
itself is Task 4's deliverable; for this task, drive it locally with a scratch Playwright
call or by reading the failing assertion. Report the actual overflowing selectors you
found and fixed.

### Tests (write first, watch each fail)

- Extend `apps/web/app/project/[id]/builder-header.test.tsx` — assert the control group
  carries `flex-wrap` (the static-markup test can only see classes; the real assertion is
  the e2e's no-overflow probe in Task 4, and that is fine — say so in a comment on the
  test so a later reader does not mistake it for the whole verification).

Keep it to that one unit test. Static markup cannot measure layout; Task 4's e2e is where
this criterion is actually verified, and duplicating a weak class-string assertion for
every file would be test theatre.

---

## Task 4 — Performance budgets: defined, measured, enforced

**Criterion 5.** Nothing measures performance today.

### The measurement decision (this is the durable part)

Two budgets, chosen because both are *deterministic in CI*:

1. **Client bundle size, from the production build.** `next build` writes
   `apps/web/.next/app-build-manifest.json` and the per-route JS chunks. A route whose First
   Load JS crosses its budget fails the check. This catches the real regression — someone
   importing a heavy library into the builder — and it is byte-exact, not timing-dependent.
2. **Cumulative Layout Shift on the golden flow.** CLS is the Web Vital that maps to this
   issue's own title ("performance percebida"), and it is a *layout* measurement, so it
   means the same thing under `next dev` (which is what the golden-flow e2e runs) as it
   does in production.

**LCP, INP and TTFB are explicitly NOT budgeted.** The golden-flow e2e runs `next dev`
(`golden-flow.spec.ts:181`), where those numbers reflect on-demand compilation of an
unminified bundle on a shared CI runner. A budget on them would be pure flake. Say this in
the doc; do not quietly omit it.

### Deliverable

- **`perf-budgets.json`** at the repo root — the single source of truth, read by both the
  script and the e2e:
  ```json
  {
    "firstLoadJsKb": { "/": <n>, "/project/[id]": <n>, "/router": <n> },
    "cls": { "builder": 0.1 }
  }
  ```
  Set each `firstLoadJsKb` from the *current measured* value plus roughly 15% headroom, and
  put the measured baseline in a comment field or in the doc — a budget nobody can trace
  back to a measurement gets raised on the first failure instead of investigated. `0.1` is
  the standard "good" CLS threshold; keep it.
- **`scripts/check-perf-budgets.mjs`** — reads the build output and `perf-budgets.json`,
  prints every route's measured-vs-budget, exits non-zero on any breach. It must fail loudly
  (not silently pass) if the build output is missing or a budgeted route is absent from it —
  a budget check that no-ops when the build moved is worse than none.
- **`npm run perf:check`** in the root `package.json`, and a `node --test`-style unit test
  at `scripts/lib/perf-budgets.test.mjs` following the existing `scripts/lib/*.test.mjs`
  pattern (add it to the `test:scripts` glob if the glob does not already pick it up).
  Extract the pure "given this manifest and these budgets, what breaches?" function into
  `scripts/lib/perf-budgets.mjs` so it is testable without a build.
- **CI wiring, part 1** — add `npm run perf:check` to the existing `build` job in
  `.github/workflows/ci.yml`, after `npm run build`. Do not create a new job for this; the
  build job already produces exactly the artifact the check needs.
- **CI wiring, part 2 — make the golden flow actually gate PRs.** Today
  `golden-flow.spec.ts` runs in CI *only* as a subprocess of the `supabase-data-plane-e2e`
  job (`packages/composition/src/supabase-data-plane.e2e.test.ts:260-262`), which needs
  Docker + the Supabase CLI and is red on `main` right now. That job is the sole CI path
  executing the axe scan — so every accessibility assertion in Tasks 1-5 would land
  unenforced. The suite itself needs neither Docker nor Supabase (measured: 4 passed in 35s
  standalone). Add a dedicated `golden-flow-e2e` job to `.github/workflows/ci.yml` modelled
  exactly on the existing `issue-radar-e2e` job (lines 111-129): `needs: preflight`,
  checkout, setup-node, `npm ci`, `npx playwright install --with-deps chromium`,
  `npm run build:packages`, then
  `npm run e2e --workspace @agent-foundry/api -- golden-flow.spec.ts`. Leave the
  `supabase-data-plane-e2e` job alone — fixing it is out of scope for #97, and the new job
  makes it no longer the only route.
- **`docs/PERFORMANCE_BUDGETS.md`** — what is budgeted, the measured baselines, why LCP/INP
  are not budgeted, and how to raise a budget deliberately (measure, justify in the PR).
- **`DESIGN.md:332`** currently claims the "a11y and responsive pass" line item is complete
  with acceptance "contrast AA verified, ≤1000px collapse tested". Update it to name what is
  actually verified after this branch: WCAG 2.2 AA via axe on five surfaces, a 390px
  overflow probe, and the two budgets. One edit, no rewriting of the surrounding table.
- **ADR** `docs/adr/0066-performance-budgets-and-builder-state-primitive.md` recording the
  durable decisions from this whole branch: the two budgets and their rationale, the single
  `PaneState` primitive from Task 1, and the below-`lg` stacking degradation from Task 3.
  Follow the format of `docs/adr/0061-*.md` (Status / Date / Owners / Tracked by / Context /
  Decision / Considered Options / Consequences). Status: Proposed. Tracked by issue #97.

### Tests (write first, watch each fail)

`scripts/lib/perf-budgets.test.mjs` — a route over budget, a route under, a budgeted route
missing from the manifest (must be a breach, not a pass), an empty manifest (must be a
breach).

### Do not

Do not touch `golden-flow.spec.ts` in this task — Task 5 owns every e2e change, including
the CLS assertion that reads this task's `perf-budgets.json`.

---

## Task 5 — Verify it: WCAG 2.2 AA, keyboard-only, narrow viewport, CLS

**Criteria 2, 3 and 5's measurement half.** This task owns every change to
`apps/api/e2e/golden-flow.spec.ts`, and fixes whatever the new assertions surface in
`apps/web`.

### Deliverable — five additions to the golden flow

1. **WCAG 2.2 AA.** Add `wcag22a` and `wcag22aa` to `expectNoAxeViolations`'s `withTags`
   list (line 53). In practice the rule this newly enables is axe's `target-size`
   (SC 2.5.8, 24×24 CSS px minimum). **Fix every violation it reports in `apps/web`** — most
   likely by bumping padding on small controls in `apps/web/lib/ui.ts`'s `BTN`/`CHIP`
   tokens. Do not add an exclusion or drop the tag to make the scan pass; if a violation is
   genuinely un-fixable, report it and say why rather than silencing it.
2. **A narrow-viewport overflow probe** at **390px** covering all four surfaces the suite
   already visits — the builder (both simple and Advanced), `/`, `/router` and
   `/project/:id/versions`. For each: assert
   `document.documentElement.scrollWidth <= document.documentElement.clientWidth`, and
   assert the primary action of the surface is still visible. Factor it into one helper
   (`expectNoHorizontalOverflow(page, surface)`) alongside `expectNoAxeViolations`, and pass
   a surface label so a failure names which page broke. Restore the 1440px viewport
   afterwards — the existing 900px check already does this and the axe scans after it
   depend on it.
3. **A keyboard-only pass over the chat composer**, the one flow the existing keyboard
   assertions miss entirely. From a fresh page load: Tab reaches the composer, the send
   control is reachable by keyboard, and the "Avançado" toggle responds to Space/Enter with
   `aria-pressed` flipping. Assert focus is *visible* on at least one control — read the
   computed `outline`/`box-shadow` and assert it is not `none`.
4. **A skip link** — the one basic a11y affordance the survey found genuinely absent
   (there is no skip link anywhere in `apps/web`). Add one to `apps/web/app/layout.tsx`:
   a first-in-DOM anchor to the
   `<main>` element, visually hidden until focused (the `sr-only`-until-`:focus` pattern;
   add the utility to `apps/web/app/theme.css` if it is not already there), labelled
   **"Pular para o conteúdo"**. Assert in the e2e that the first Tab from page load focuses
   it and that activating it moves focus into `<main>`. `<main>` needs an `id` and
   `tabIndex={-1}` for focus to actually land.
5. **CLS measurement against Task 4's budget.** Install a `PerformanceObserver` for
   `layout-shift` before navigating to the builder, exercise the page (the run through the
   inspector tabs the suite already does), then read the accumulated score and assert it is
   at or under `perf-budgets.json`'s `cls.builder`. Read the budget from the JSON file — do
   not hardcode `0.1` in the spec. Log the measured value with `console.log` so a CI run
   shows the number even when it passes; a budget nobody can see the trend of is a budget
   nobody maintains.

### Fixes

Whatever items 1-3 surface in `apps/web` are part of this task. If a fix is large enough to
be its own task, report it rather than half-doing it.

### Verification

`npm run build:packages && npm run e2e --workspace @agent-foundry/api -- golden-flow.spec.ts`
must pass, and your report must include the axe/CLS/overflow output. This suite is CI-only
per AGENTS.md, so a local green run is the evidence.

---

## Task order and file ownership

Sequential — Tasks 1-3 all touch `apps/web` component files and must not run concurrently.

| Task | Owns |
|---|---|
| 1 | `apps/web/components/pane-state.tsx` (+ deletes `empty-state.*`), `chat-pane.tsx`, `conversation-list.tsx`, `preview-panel.tsx`, `inspector/*.tsx` |
| 2 | `run-alert-strip.tsx`, `run-progress.ts` (new), `page.tsx` |
| 3 | `builder-header.tsx`, `diff-view.tsx`, `agent-artifact-view.tsx`, `version-history.tsx`, `changes-panel.tsx`, responsive classes anywhere |
| 4 | `perf-budgets.json`, `scripts/{lib/,}perf-budgets*.mjs`, `package.json`, `.github/workflows/ci.yml`, `docs/PERFORMANCE_BUDGETS.md`, `docs/adr/0066-*.md` |
| 5 | `apps/api/e2e/golden-flow.spec.ts`, `apps/web/app/layout.tsx`, `apps/web/app/theme.css`, `apps/web/lib/ui.ts` |

Task 5 must run last: its axe and overflow probes are the verification for Tasks 1-3.
