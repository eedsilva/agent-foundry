# Router Regression Gate Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three gaps PR #283 left open against GitHub issue #67 ("[v0.9] Construir dashboard de router e registry de experimentos") so the issue's acceptance criteria and required tests are actually satisfied, not just partially implemented.

**Architecture:** PR #283 already shipped the dashboard, decision log, experiment store, and a standalone `POST /router/regression-gate` endpoint — none of that is touched here except where a gap forces a change. This plan (1) freezes the missing `docs/baselines/v0.9-benchmark.json` baseline and wires the existing `compareBenchmarkReports` gate into a new CI job that runs whenever a PR touches `models/catalog.yaml` or `harness/manifest.json`, (2) finishes the experiment-registration web form so an operator can actually set variants/population/stop-rule instead of hitting fixed defaults, and (3) adds the e2e coverage the issue explicitly requires but PR #283 never wrote.

**Tech Stack:** TypeScript, Fastify (`apps/api`), Next.js App Router (`apps/web`), Zod contracts (`packages/contracts`), Vitest, Playwright, GitHub Actions.

## Global Constraints

- No new npm dependencies — everything needed already exists in the workspace.
- All existing Portuguese UI copy conventions in `apps/web/app/router/*` must be matched (labels, headings) — this is an internal ops dashboard, not user-facing product copy, and the file is already 100% Portuguese.
- Every new/changed Zod schema or exported constant must follow the existing `.strict()` / named-export conventions in `packages/contracts/src`.
- `npm run check` and `npm run e2e --workspace @agent-foundry/api` must stay green after every task.
- Do not push to `main`; all work happens on the current worktree branch (`worktree-issue-67-regression-gate`), landing via a PR.
- **The mock-executor-mode v0.9 baseline gates structural regressions only (case coverage, crashes), not model-quality regressions.** Every one of the 6 benchmark cases is expected to fail under `--executor-mode mock` (the mock executor scaffolds a generic app; it does not solve a case's bespoke `verifyScript`) — this is expected, schema-legal (`freezeBenchmarkReport` only requires every failed record to carry a `failure`, not that any record passes), and matches the existing "not a green wall" limitation already documented in `renderBenchmarkMarkdown`'s output. A **mock-mode "fresh" report must only ever be compared against a mock-mode baseline** — never swap in a `--executor-mode real` baseline for the file CI reads, or CI's mock-mode fresh runs (`caseId::modelId` always `failed`) will look like a permanent regression against any baseline entry a real run recorded as `passed`, and every PR will fail. Document this explicitly (Task 6, Task 7).
- **`scripts/benchmark.ts --all --executor-mode mock` is legitimately slow (~20–25 minutes locally for the full 6 cases × 3 resolvable catalog models = 18 runs), not hung.** Each run does a real project creation, a real worker pass, and (since the mock executor can't satisfy these cases' `verifyScript`s) repeated repair attempts up to the emergency ceiling before giving up — plus a real `npm ci` and preview-server boot per attempt. The parent `tsx` process's own CPU time stays near zero because the work happens in child processes (`npm ci`, `node server.mjs`). **Do not kill it for looking idle** — run it with a long-lived background shell and wait for actual completion (or a `task-notification`), never a short timeout-and-retry loop.

---

### Task 1: Add a promotion-sensitive-path decision helper to the regression gate module

**Files:**
- Modify: `packages/composition/src/regression-gate.ts`
- Test: `packages/composition/src/regression-gate.test.ts`

**Interfaces:**
- Produces: `PROMOTION_SENSITIVE_PATHS: readonly string[]` and `shouldRunRegressionGate(changedFiles: readonly string[]): boolean`, both exported from `packages/composition/src/regression-gate.ts`. Task 3's `scripts/promotion-gate-check.ts` imports `shouldRunRegressionGate` by exact name.

- [ ] **Step 1: Write the failing tests**

Add this new `describe` block to the end of `packages/composition/src/regression-gate.test.ts` (after the existing `describe('compareBenchmarkReports', ...)` block, same file — add `shouldRunRegressionGate` to the existing `import { compareBenchmarkReports } from './regression-gate.js';` line so it reads `import { compareBenchmarkReports, shouldRunRegressionGate } from './regression-gate.js';`):

```ts
describe('shouldRunRegressionGate', () => {
  it('returns true when the catalog file changed', () => {
    expect(shouldRunRegressionGate(['README.md', 'models/catalog.yaml'])).toBe(true);
  });

  it('returns true when the harness manifest changed', () => {
    expect(shouldRunRegressionGate(['harness/manifest.json'])).toBe(true);
  });

  it('returns false when no promotion-sensitive path changed', () => {
    expect(
      shouldRunRegressionGate(['README.md', 'packages/composition/src/regression-gate.ts']),
    ).toBe(false);
  });

  it('returns false for an empty change set', () => {
    expect(shouldRunRegressionGate([])).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/composition/src/regression-gate.test.ts`
Expected: FAIL — `shouldRunRegressionGate is not defined` (or a TypeScript import error, since the name doesn't exist in `regression-gate.ts` yet).

- [ ] **Step 3: Implement the helper**

Append to `packages/composition/src/regression-gate.ts` (after the `compareBenchmarkReports` function):

```ts

// Promotion-sensitive paths: a change here is what "promoting catalog or
// harness" means in this repo (see docs/OPERATIONS.md). CI wires this into
// the regression-gate job via scripts/promotion-gate-check.ts.
export const PROMOTION_SENSITIVE_PATHS: readonly string[] = [
  'models/catalog.yaml',
  'harness/manifest.json',
];

export function shouldRunRegressionGate(changedFiles: readonly string[]): boolean {
  return changedFiles.some((file) => PROMOTION_SENSITIVE_PATHS.includes(file));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/composition/src/regression-gate.test.ts`
Expected: PASS — all 8 tests (4 existing `compareBenchmarkReports` + 4 new `shouldRunRegressionGate`).

- [ ] **Step 5: Typecheck and commit**

Run: `npx tsc -b packages/composition --force --pretty false`
Expected: no errors.

```bash
git add packages/composition/src/regression-gate.ts packages/composition/src/regression-gate.test.ts
git commit -m "feat(composition): add shouldRunRegressionGate promotion-path check"
```

---

### Task 2: Freeze the v0.9 benchmark baseline

**Files:**
- Create: `docs/baselines/v0.9-benchmark.json`
- Create: `docs/baselines/v0.9-benchmark.md`
- Modify: `packages/composition/src/benchmark-runner.test.ts`

**Interfaces:**
- Consumes: `BASELINE_STEM` (already exported from `packages/composition/src/benchmark-runner.ts`, value `'v0.9-benchmark'`), `compareBenchmarkReports` (Task-independent, already exists in `regression-gate.ts`).
- Produces: the committed baseline pair at `docs/baselines/v0.9-benchmark.{json,md}`, read by the existing `POST /router/regression-gate` handler (`apps/api/src/app.ts:284`) and by Task 3's CI job and Task 5's e2e test.

- [ ] **Step 1: Write the failing test**

Add this to `packages/composition/src/benchmark-runner.test.ts`. First, extend the existing top-of-file import from `'./benchmark-runner.js'` to include `BASELINE_STEM`, so it reads:

```ts
import {
  BASELINE_STEM,
  freezeBenchmarkReport,
  loadBenchmarkCases,
  runBenchmarkCase,
} from './benchmark-runner.js';
```

Then add this import line (new):

```ts
import { compareBenchmarkReports } from './regression-gate.js';
```

Then add this new `describe` block anywhere at the top level of the file (e.g. right after the existing top-level `describe` block(s), before the final closing of the file):

```ts
describe('the committed v0.9 baseline', () => {
  it('parses, covers every benchmark case kind, and self-compares clean', async () => {
    const baselinePath = resolve(repoRoot, 'docs/baselines', `${BASELINE_STEM}.json`);
    const baseline = BenchmarkReportSchema.parse(JSON.parse(await readFile(baselinePath, 'utf8')));

    const coveredKinds = new Set(baseline.runs.map((run) => run.caseKind));
    for (const kind of BENCHMARK_CASE_KINDS) {
      expect(coveredKinds.has(kind)).toBe(true);
    }

    const result = compareBenchmarkReports(baseline, baseline);
    expect(result.verdict).toBe('pass');
    expect(result.reasons).toHaveLength(0);
  });
});
```

(`resolve`, `readFile`, `repoRoot`, `BenchmarkReportSchema`, and `BENCHMARK_CASE_KINDS` are all already imported/defined at the top of this file — no other import changes needed.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/composition/src/benchmark-runner.test.ts -t "committed v0.9 baseline"`
Expected: FAIL — `ENOENT: no such file or directory, open '.../docs/baselines/v0.9-benchmark.json'`.

- [ ] **Step 3: Generate the fresh benchmark records**

From the repo root:

```bash
rm -rf .data/benchmark
npx tsx scripts/benchmark.ts --all --executor-mode mock
```

Run this in a long-lived background shell (or a terminal you don't interrupt) and wait for it to actually finish — see the Global Constraints note above on why this takes ~20–25 minutes and must not be killed early. It prints one line per `caseId x modelId attempt N: status` (18 lines total: 6 cases × 3 models that resolve to a non-empty `model` string in `models/catalog.yaml` without any env vars set — `claude-opus`, `claude-sonnet`, `claude-haiku`; `codex-default`/`agy-default` resolve to `''` and are filtered out by `resolveModels()`). Every line is expected to end in `failed (EmergencyCeilingError: ...)` — that's correct, not a bug (see Global Constraints).

Expected exit code: `1` (the script's own `--all` failure-count check treats every `failed` record as a script failure; that's fine, we only care that 18 JSON records landed in `.data/benchmark/`). Verify with:

Run: `ls .data/benchmark/*.json | wc -l`
Expected: `18` (a `dogfood/` subdirectory also appears under `.data/benchmark` — that's `runDogfoodTask`'s own bookkeeping, not a benchmark record; `loadJsonRecords` already filters to `*.json` so it's harmless, just don't count it in this check).

- [ ] **Step 4: Freeze the baseline pair**

```bash
npx tsx scripts/benchmark.ts --freeze
```

Expected output: `Frozen 18 record(s) into docs/baselines.`

Verify the files exist:

Run: `ls docs/baselines/v0.9-benchmark.json docs/baselines/v0.9-benchmark.md`
Expected: both paths printed, no error.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/composition/src/benchmark-runner.test.ts -t "committed v0.9 baseline"`
Expected: PASS.

- [ ] **Step 6: Run the full existing benchmark-runner test file to confirm no regressions**

Run: `npx vitest run packages/composition/src/benchmark-runner.test.ts`
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 7: Commit**

```bash
git add docs/baselines/v0.9-benchmark.json docs/baselines/v0.9-benchmark.md packages/composition/src/benchmark-runner.test.ts
git commit -m "chore(benchmark): freeze the v0.9 mock-executor baseline"
```

---

### Task 3: Wire the regression gate into CI as a promotion-sensitive-path check

**Files:**
- Create: `scripts/promotion-gate-check.ts`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `shouldRunRegressionGate` from `packages/composition/src/regression-gate.js` (Task 1, must be complete first).
- Produces: a `regression-gate` CI job that runs `scripts/benchmark.ts --all --executor-mode mock` + `scripts/benchmark.ts --gate` only when a PR/push touches `models/catalog.yaml` or `harness/manifest.json`.

- [ ] **Step 1: Write the script**

Create `scripts/promotion-gate-check.ts`:

```ts
import { shouldRunRegressionGate } from '../packages/composition/src/regression-gate.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const changedFiles = (await readStdin())
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

console.log(shouldRunRegressionGate(changedFiles) ? 'true' : 'false');
```

This is a thin stdin/stdout wrapper over `shouldRunRegressionGate`, which is already unit-tested (Task 1) — no separate test file for the wrapper itself; verify it manually in Step 2.

- [ ] **Step 2: Manually verify the script**

Run: `printf 'README.md\nmodels/catalog.yaml\n' | npx tsx scripts/promotion-gate-check.ts`
Expected output: `true`

Run: `printf 'README.md\npackages/composition/src/regression-gate.ts\n' | npx tsx scripts/promotion-gate-check.ts`
Expected output: `false`

Run: `printf '' | npx tsx scripts/promotion-gate-check.ts`
Expected output: `false`

- [ ] **Step 3: Typecheck**

Run: `npx tsc -b --force --pretty false`
Expected: no errors (this compiles the whole workspace including `scripts/`; if `scripts/*.ts` isn't part of any `tsconfig` project, confirm by running `npx tsx scripts/promotion-gate-check.ts < /dev/null` instead, which will surface any type error at execution since `tsx` type-strips without checking — if so, also run `npx tsc --noEmit scripts/promotion-gate-check.ts` to be sure).

- [ ] **Step 4: Add the CI job**

In `.github/workflows/ci.yml`, insert this new job immediately before the `sandbox-sbom:` job (i.e., right after the `build:` job's steps end and before the `sandbox-sbom:` job starts):

```yaml
  # ponytail: mock-executor-mode fresh run only, ~20-25 min — this repo has
  # no CI-available real provider credentials, so it can only ever compare
  # against a mock-mode baseline. See docs/OPERATIONS.md "Regression gate de
  # promoção" for what that does and doesn't catch.
  regression-gate:
    name: regression-gate
    needs: preflight
    runs-on: ubuntu-latest
    timeout-minutes: 35
    steps:
      - uses: actions/checkout@v7
        with:
          # The promotion-sensitive-path diff below needs real history to
          # diff against, not just the shallow default checkout of the PR tip.
          fetch-depth: 0
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - name: Decide whether this change touches a promotion-sensitive path
        id: gate-check
        run: |
          BASE_SHA="${{ github.event.pull_request.base.sha || github.event.before }}"
          if [ -z "$BASE_SHA" ] || ! git cat-file -e "$BASE_SHA" 2>/dev/null; then
            echo "run=true" >> "$GITHUB_OUTPUT"
          else
            RUN=$(git diff --name-only "$BASE_SHA" HEAD | npx tsx scripts/promotion-gate-check.ts)
            echo "run=$RUN" >> "$GITHUB_OUTPUT"
          fi
      - name: Generate fresh benchmark results (mock executor)
        if: steps.gate-check.outputs.run == 'true'
        run: npx tsx scripts/benchmark.ts --all --executor-mode mock
      - name: Compare against the frozen v0.9 baseline
        if: steps.gate-check.outputs.run == 'true'
        run: npx tsx scripts/benchmark.ts --gate
```

- [ ] **Step 5: Validate the YAML**

Run: `npx yaml-lint .github/workflows/ci.yml 2>/dev/null || node -e "require('node:fs').readFileSync('.github/workflows/ci.yml','utf8')" ` — if `yaml-lint` isn't installed (it likely isn't; that's fine), instead run the repo's own governance check, which parses every workflow file:

Run: `npm run github-config:check`
Expected: exits 0, no error about `ci.yml`.

- [ ] **Step 6: Commit**

```bash
git add scripts/promotion-gate-check.ts .github/workflows/ci.yml
git commit -m "ci: gate catalog/harness promotions on the v0.9 regression baseline"
```

---

### Task 4: Complete the experiment registration web form

**Files:**
- Modify: `apps/web/app/router/dashboard-view.tsx`
- Modify: `apps/web/app/router/page.tsx`
- Modify: `apps/web/app/router/dashboard-view.test.tsx`

**Interfaces:**
- Produces: `ExperimentFormState` (interface), `EMPTY_EXPERIMENT_FORM` (const), `buildExperimentRequest(form: ExperimentFormState): CreateExperimentRequest` (function) — all exported from `apps/web/app/router/dashboard-view.tsx`. `RouterDashboardView`'s props change from `hypothesis: string; onHypothesisChange: (value: string) => void;` to `form: ExperimentFormState; onFormChange: (form: ExperimentFormState) => void;`.
- Consumes: `CreateExperimentRequest`, `ExperimentStopRule`, `TaskKind`, `TaskKindSchema`, `ExperimentStopRuleSchema` from `@agent-foundry/contracts` (all already exist; `TaskKindSchema`/`ExperimentStopRuleSchema` need to be added to this file's imports — there's existing precedent for importing a runtime Zod schema into a web component and using `.options` at `apps/web/app/project/[id]/preview-panel.tsx:419` and `:449`).

- [ ] **Step 1: Write the failing test for the pure builder function**

In `apps/web/app/router/dashboard-view.test.tsx`, change the import line

```ts
import { EMPTY_ROUTER_FILTERS, RouterDashboardView, activeRouterQuery } from './dashboard-view.js';
```

to

```ts
import {
  buildExperimentRequest,
  EMPTY_EXPERIMENT_FORM,
  EMPTY_ROUTER_FILTERS,
  RouterDashboardView,
  activeRouterQuery,
} from './dashboard-view.js';
```

Then add this new `describe` block:

```ts
describe('buildExperimentRequest', () => {
  it('builds two model-target variants, population, and stop rule from form state', () => {
    const request = buildExperimentRequest({
      ...EMPTY_EXPERIMENT_FORM,
      hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
      variantADescription: 'Sonnet 5',
      variantBDescription: 'Opus 4.8',
      taskKinds: ['implementation', 'code-review'],
      targetSampleSize: '40',
      stopRuleThreshold: '0.75',
      stopRuleMinSamples: '15',
    });

    expect(request).toEqual({
      hypothesis: 'Opus beats Sonnet on frontend first-pass rate.',
      variants: [
        { key: 'control', description: 'Sonnet 5', target: { kind: 'model', modelId: 'sonnet' } },
        { key: 'treatment', description: 'Opus 4.8', target: { kind: 'model', modelId: 'opus' } },
      ],
      population: { taskKinds: ['implementation', 'code-review'], targetSampleSize: 40 },
      stopRule: { metric: 'first-pass-rate', comparator: 'gte', threshold: 0.75, minSamples: 15 },
    });
  });
});
```

Also update the existing `RouterDashboardView` render test's props — replace

```ts
        hypothesis=""
        onHypothesisChange={() => {}}
```

with

```ts
        form={EMPTY_EXPERIMENT_FORM}
        onFormChange={() => {}}
```

and add these two assertions right after the existing `expect(markup).toContain(experiment.hypothesis);` line:

```ts
    expect(markup).toContain('Variante A');
    expect(markup).toContain('Regra de parada');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/app/router/dashboard-view.test.tsx`
Expected: FAIL — `buildExperimentRequest`/`EMPTY_EXPERIMENT_FORM` not exported from `./dashboard-view.js`, and the render test fails because `RouterDashboardView` doesn't accept `form`/`onFormChange` yet.

- [ ] **Step 3: Implement the form state and builder in dashboard-view.tsx**

In `apps/web/app/router/dashboard-view.tsx`, change the top import block from:

```tsx
import React, { type FormEvent } from 'react';
import type {
  ExperimentRecord,
  RouterDashboardResponse,
  RouterDecisionLogEntry,
} from '@agent-foundry/contracts';
```

to:

```tsx
import React, { type FormEvent } from 'react';
import {
  ExperimentStopRuleSchema,
  TaskKindSchema,
  type CreateExperimentRequest,
  type ExperimentRecord,
  type ExperimentStopRule,
  type RouterDashboardResponse,
  type RouterDecisionLogEntry,
  type TaskKind,
} from '@agent-foundry/contracts';
```

Add this block right after the `EMPTY_ROUTER_FILTERS` constant (before `activeRouterQuery`):

```tsx
export interface ExperimentFormState {
  hypothesis: string;
  variantAKey: string;
  variantADescription: string;
  variantAModelId: string;
  variantBKey: string;
  variantBDescription: string;
  variantBModelId: string;
  taskKinds: TaskKind[];
  targetSampleSize: string;
  stopRuleMetric: ExperimentStopRule['metric'];
  stopRuleComparator: ExperimentStopRule['comparator'];
  stopRuleThreshold: string;
  stopRuleMinSamples: string;
}

export const EMPTY_EXPERIMENT_FORM: ExperimentFormState = {
  hypothesis: '',
  variantAKey: 'control',
  variantADescription: '',
  variantAModelId: 'sonnet',
  variantBKey: 'treatment',
  variantBDescription: '',
  variantBModelId: 'opus',
  taskKinds: ['implementation'],
  targetSampleSize: '30',
  stopRuleMetric: 'first-pass-rate',
  stopRuleComparator: 'gte',
  stopRuleThreshold: '0.8',
  stopRuleMinSamples: '20',
};

// ponytail: exactly two model-target variants, matching the schema's
// .min(2) floor. A dynamic add/remove variant list (arbitrary count,
// harness/catalog target kinds) is unrequested generality until an operator
// actually needs a 3+ arm or non-model-target experiment.
export function buildExperimentRequest(form: ExperimentFormState): CreateExperimentRequest {
  return {
    hypothesis: form.hypothesis,
    variants: [
      {
        key: form.variantAKey,
        description: form.variantADescription,
        target: { kind: 'model', modelId: form.variantAModelId },
      },
      {
        key: form.variantBKey,
        description: form.variantBDescription,
        target: { kind: 'model', modelId: form.variantBModelId },
      },
    ],
    population: { taskKinds: form.taskKinds, targetSampleSize: Number(form.targetSampleSize) },
    stopRule: {
      metric: form.stopRuleMetric,
      comparator: form.stopRuleComparator,
      threshold: Number(form.stopRuleThreshold),
      minSamples: Number(form.stopRuleMinSamples),
    },
  };
}
```

- [ ] **Step 4: Replace the `hypothesis`/`onHypothesisChange` props and form JSX**

In the `RouterDashboardView` function signature, replace:

```tsx
  hypothesis,
  onHypothesisChange,
  onSubmitExperiment,
}: {
  filters: RouterFilters;
  onFiltersChange: (filters: RouterFilters) => void;
  dashboard: RouterDashboardResponse;
  decisions: RouterDecisionLogEntry[];
  experiments: ExperimentRecord[];
  exportHref: string;
  hypothesis: string;
  onHypothesisChange: (value: string) => void;
  onSubmitExperiment: (event: FormEvent) => void;
}) {
```

with:

```tsx
  form,
  onFormChange,
  onSubmitExperiment,
}: {
  filters: RouterFilters;
  onFiltersChange: (filters: RouterFilters) => void;
  dashboard: RouterDashboardResponse;
  decisions: RouterDecisionLogEntry[];
  experiments: ExperimentRecord[];
  exportHref: string;
  form: ExperimentFormState;
  onFormChange: (form: ExperimentFormState) => void;
  onSubmitExperiment: (event: FormEvent) => void;
}) {
```

Then replace the entire existing form block:

```tsx
        <form onSubmit={onSubmitExperiment}>
          <label>
            Hipótese
            <textarea
              className="compactTextarea"
              value={hypothesis}
              onChange={(event) => onHypothesisChange(event.target.value)}
            />
          </label>
          <button type="submit" className="primaryButton">
            Registrar experimento
          </button>
        </form>
```

with:

```tsx
        <form onSubmit={onSubmitExperiment}>
          <label>
            Hipótese
            <textarea
              className="compactTextarea"
              value={form.hypothesis}
              onChange={(event) => onFormChange({ ...form, hypothesis: event.target.value })}
            />
          </label>

          <fieldset>
            <legend>Variante A</legend>
            <label>
              Chave (A)
              <input
                value={form.variantAKey}
                onChange={(event) => onFormChange({ ...form, variantAKey: event.target.value })}
              />
            </label>
            <label>
              Descrição (A)
              <input
                value={form.variantADescription}
                onChange={(event) =>
                  onFormChange({ ...form, variantADescription: event.target.value })
                }
              />
            </label>
            <label>
              Modelo alvo (A)
              <input
                value={form.variantAModelId}
                onChange={(event) =>
                  onFormChange({ ...form, variantAModelId: event.target.value })
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Variante B</legend>
            <label>
              Chave (B)
              <input
                value={form.variantBKey}
                onChange={(event) => onFormChange({ ...form, variantBKey: event.target.value })}
              />
            </label>
            <label>
              Descrição (B)
              <input
                value={form.variantBDescription}
                onChange={(event) =>
                  onFormChange({ ...form, variantBDescription: event.target.value })
                }
              />
            </label>
            <label>
              Modelo alvo (B)
              <input
                value={form.variantBModelId}
                onChange={(event) =>
                  onFormChange({ ...form, variantBModelId: event.target.value })
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>População</legend>
            {TaskKindSchema.options.map((kind) => (
              <label key={kind} className="checkboxLabel">
                <input
                  type="checkbox"
                  checked={form.taskKinds.includes(kind)}
                  onChange={(event) =>
                    onFormChange({
                      ...form,
                      taskKinds: event.target.checked
                        ? [...form.taskKinds, kind]
                        : form.taskKinds.filter((value) => value !== kind),
                    })
                  }
                />
                {kind}
              </label>
            ))}
            <label>
              Tamanho de amostra alvo
              <input
                type="number"
                min={1}
                value={form.targetSampleSize}
                onChange={(event) =>
                  onFormChange({ ...form, targetSampleSize: event.target.value })
                }
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Regra de parada</legend>
            <label>
              Métrica
              <select
                value={form.stopRuleMetric}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    stopRuleMetric: event.target.value as ExperimentFormState['stopRuleMetric'],
                  })
                }
              >
                {ExperimentStopRuleSchema.shape.metric.options.map((metric) => (
                  <option key={metric} value={metric}>
                    {metric}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Comparador
              <select
                value={form.stopRuleComparator}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    stopRuleComparator: event.target
                      .value as ExperimentFormState['stopRuleComparator'],
                  })
                }
              >
                {ExperimentStopRuleSchema.shape.comparator.options.map((comparator) => (
                  <option key={comparator} value={comparator}>
                    {comparator}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Limite
              <input
                type="number"
                step="any"
                value={form.stopRuleThreshold}
                onChange={(event) =>
                  onFormChange({ ...form, stopRuleThreshold: event.target.value })
                }
              />
            </label>
            <label>
              Amostras mínimas
              <input
                type="number"
                min={1}
                value={form.stopRuleMinSamples}
                onChange={(event) =>
                  onFormChange({ ...form, stopRuleMinSamples: event.target.value })
                }
              />
            </label>
          </fieldset>

          <button type="submit" className="primaryButton">
            Registrar experimento
          </button>
        </form>
```

- [ ] **Step 5: Update page.tsx**

In `apps/web/app/router/page.tsx`, replace the whole file with:

```tsx
'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type {
  ExperimentRecord,
  RouterDashboardResponse,
  RouterDecisionLogEntry,
} from '@agent-foundry/contracts';
import {
  createExperiment,
  getRouterDashboard,
  listExperiments,
  listRouterDecisions,
  routerExportUrl,
} from '../../lib/api.js';
import {
  activeRouterQuery,
  buildExperimentRequest,
  EMPTY_EXPERIMENT_FORM,
  EMPTY_ROUTER_FILTERS,
  RouterDashboardView,
  type ExperimentFormState,
  type RouterFilters,
} from './dashboard-view.js';

export default function RouterDashboardPage() {
  const [filters, setFilters] = useState<RouterFilters>(EMPTY_ROUTER_FILTERS);
  const [dashboard, setDashboard] = useState<RouterDashboardResponse | null>(null);
  const [decisions, setDecisions] = useState<RouterDecisionLogEntry[]>([]);
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([]);
  const [form, setForm] = useState<ExperimentFormState>(EMPTY_EXPERIMENT_FORM);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const query = activeRouterQuery(filters);
    void Promise.all([getRouterDashboard(query), listRouterDecisions(query), listExperiments()])
      .then(([dashboardResponse, decisionsResponse, experimentsResponse]) => {
        setDashboard(dashboardResponse);
        setDecisions(decisionsResponse.decisions);
        setExperiments(experimentsResponse.experiments);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [filters]);

  async function handleSubmitExperiment(event: FormEvent) {
    event.preventDefault();
    if (form.hypothesis.trim().length === 0) return;
    const experiment = await createExperiment(buildExperimentRequest(form));
    setExperiments((current) => [experiment, ...current]);
    setForm(EMPTY_EXPERIMENT_FORM);
  }

  if (error) return <p className="error">{error}</p>;
  if (!dashboard) return <p>Carregando…</p>;

  return (
    <RouterDashboardView
      filters={filters}
      onFiltersChange={setFilters}
      dashboard={dashboard}
      decisions={decisions}
      experiments={experiments}
      exportHref={routerExportUrl(activeRouterQuery(filters))}
      form={form}
      onFormChange={setForm}
      onSubmitExperiment={handleSubmitExperiment}
    />
  );
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run apps/web/app/router/dashboard-view.test.tsx`
Expected: PASS — all tests including the new `buildExperimentRequest` test and the updated render assertions.

- [ ] **Step 7: Typecheck the web app**

Run: `npx tsc -b apps/web --force --pretty false`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/router/dashboard-view.tsx apps/web/app/router/page.tsx apps/web/app/router/dashboard-view.test.tsx
git commit -m "feat(web): capture variants, population, and stop rule on experiment registration"
```

---

### Task 5: E2E coverage — regression gate against the baseline, and a full-form experiment registration

**Files:**
- Modify: `apps/api/e2e/golden-flow.spec.ts`

**Interfaces:**
- Consumes: `docs/baselines/v0.9-benchmark.json` (Task 2, must be complete first), the new experiment form fields' labels — `'Limite'`, `'Amostras mínimas'` (Task 4, must be complete first), `POST /router/regression-gate` (already exists, unchanged).

- [ ] **Step 1: Extend the existing router-dashboard test to fill and verify the new form fields**

In `apps/api/e2e/golden-flow.spec.ts`, inside the `test('router dashboard shows decisions and filters, an experiment can be registered, and export is PII-free', ...)` block, replace:

```ts
  const hypothesis = `E2E hypothesis ${Date.now()}`;
  await page.getByLabel('Hipótese').fill(hypothesis);
  await page.getByRole('button', { name: 'Registrar experimento' }).click();
  await expect(page.getByText(hypothesis)).toBeVisible({ timeout: 10_000 });
```

with:

```ts
  const hypothesis = `E2E hypothesis ${Date.now()}`;
  await page.getByLabel('Hipótese').fill(hypothesis);
  await page.getByLabel('Limite').fill('0.65');
  await page.getByLabel('Amostras mínimas').fill('12');
  await page.getByRole('button', { name: 'Registrar experimento' }).click();
  await expect(page.getByText(hypothesis)).toBeVisible({ timeout: 10_000 });

  const experimentsResponse = await fetch(`${apiBaseUrl}/experiments`);
  const { experiments } = (await experimentsResponse.json()) as {
    experiments: { hypothesis: string; stopRule: { threshold: number; minSamples: number } }[];
  };
  const registered = experiments.find((experiment) => experiment.hypothesis === hypothesis);
  expect(registered?.stopRule).toMatchObject({ threshold: 0.65, minSamples: 12 });
```

- [ ] **Step 2: Add a new test for the regression gate against the frozen baseline**

Add this new top-level `test(...)` block immediately after the closing `});` of the `'router dashboard shows decisions and filters, an experiment can be registered, and export is PII-free'` test (i.e., at the end of the file):

```ts

test('regression gate passes an unchanged report and fails one missing a baseline case', async () => {
  const baselinePath = resolve(REPO_ROOT, 'docs/baselines/v0.9-benchmark.json');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as { runs: unknown[] };
  expect(baseline.runs.length).toBeGreaterThan(1);

  const passResponse = await fetch(`${apiBaseUrl}/router/regression-gate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: baseline }),
  });
  expect(passResponse.ok).toBe(true);
  const { result: passResult } = (await passResponse.json()) as { result: { verdict: string } };
  expect(passResult.verdict).toBe('pass');

  const missingOneCase = { ...baseline, runs: baseline.runs.slice(1) };
  const failResponse = await fetch(`${apiBaseUrl}/router/regression-gate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: missingOneCase }),
  });
  expect(failResponse.ok).toBe(true);
  const { result: failResult } = (await failResponse.json()) as {
    result: { verdict: string; reasons: string[] };
  };
  expect(failResult.verdict).toBe('fail');
  expect(failResult.reasons.some((reason) => reason.includes('missing'))).toBe(true);
});
```

This deliberately triggers the gate's "missing from fresh report" failure path (`packages/composition/src/regression-gate.ts:22-24`) rather than the "passed → failed" status-regression path (`regression-gate.ts:26-27`): the real committed v0.9 baseline is expected to be all-`failed` (see Global Constraints — the mock executor can't satisfy any of these cases' `verifyScript`s), so there is no `passed` run available to flip into a regression. The missing-case trigger works unconditionally regardless of the baseline's pass/fail composition and is already covered at the unit level by `regression-gate.test.ts`'s `'fails when a baseline case is missing from the fresh report'` test — this e2e test proves the same behavior is reachable through the real HTTP endpoint against the real committed file, which is what the issue's required test asks for.

- [ ] **Step 3: Run the e2e suite**

Run: `npm run e2e --workspace @agent-foundry/api -- --grep "router dashboard|regression gate"`
Expected: PASS — both the extended router-dashboard test and the new regression-gate test.

- [ ] **Step 4: Commit**

```bash
git add apps/api/e2e/golden-flow.spec.ts
git commit -m "test(e2e): cover regression gate against baseline and stop-rule registration"
```

---

### Task 6: Document the promotion gate in OPERATIONS.md

**Files:**
- Modify: `docs/OPERATIONS.md`

**Interfaces:**
- Consumes: the `regression-gate` CI job name from Task 3 (must be complete first, so this doc accurately describes what CI actually does).

- [ ] **Step 1: Add a cross-reference sentence to the "Catálogo de modelos" section**

In `docs/OPERATIONS.md`, after the line `Evite editar priors para “forçar” a escolha desejada sem dados. Nesse caso, use \`allowedProviders\`, tags ou uma política explícita no workflow. Manipular o score às escondidas só torna a decisão menos legível.` (end of the "Catálogo de modelos" section, right before `## Harness`), add:

```markdown

Mudanças em `models/catalog.yaml` disparam automaticamente o job `regression-gate` do CI contra o baseline `v0.9` congelado (veja "Regression gate de promoção" abaixo). O gate cobre regressões estruturais/de status, não substitui o registro manual acima.
```

- [ ] **Step 2: Add a cross-reference sentence to the "Harness" section**

After the line `Teste mudanças de harness em projetos fixos e compare:` list (`- aprovação; - retrabalho; - tamanho do prompt; - decisões produzidas; - regressões de segurança.`), before `## Migração para Postgres`, add:

```markdown

Mudanças em `harness/manifest.json` também disparam o job `regression-gate` do CI, pelo mesmo baseline `v0.9` (veja abaixo).

## Regression gate de promoção

O job `regression-gate` (`.github/workflows/ci.yml`) roda `scripts/benchmark.ts --all --executor-mode mock` seguido de `scripts/benchmark.ts --gate` sempre que um PR ou push muda `models/catalog.yaml` ou `harness/manifest.json`. Ele compara o resultado fresco contra `docs/baselines/v0.9-benchmark.json` via `compareBenchmarkReports`: falha o check apenas se algum caso regredir de `passed` para `failed` em relação ao baseline, ou se um caso do baseline sumir do resultado fresco. Duração e número de reparos são reportados mas não bloqueiam (ver comentário `ponytail` em `packages/composition/src/regression-gate.ts`).

**Limitação importante:** o baseline `v0.9-benchmark.json` foi congelado com `--executor-mode mock`, e todo caso do corpus de benchmark atual falha nesse modo (o executor mock não resolve o `verifyScript` específico de cada caso — isso é esperado, não um bug). Isso significa que o gate de CI hoje só detecta regressões estruturais (um caso sumir, uma execução travar antes do teto de reparos), não regressões de qualidade de modelo. Detectar regressão de qualidade real exige congelar um baseline com `--executor-mode real` (requer credenciais de provider, que o CI não tem) e comparar execuções frescas também em modo `real` — **nunca** troque o arquivo que o CI lê por um baseline `real` sem também trocar o modo do executor no job de CI, ou toda PR vai falhar permanentemente (o fresco mock nunca teria como "passar" um caso que o baseline real registrou como `passed`).

Para recongelar o baseline depois de uma mudança deliberada no catálogo ou no harness:

```bash
rm -rf .data/benchmark
npx tsx scripts/benchmark.ts --all --executor-mode mock
npx tsx scripts/benchmark.ts --freeze
```

O job `regression-gate` ainda não é um required status check em branch protection — isso é uma ação de governança separada (`npm run github:governance:apply`), fora do escopo desta mudança.
```

- [ ] **Step 3: Verify the doc renders sensibly**

Run: `sed -n '520,575p' docs/OPERATIONS.md`
Expected: the new sections read in order — "Catálogo de modelos" (with new sentence) → "Harness" (with new sentence) → "Regression gate de promoção" (new section) → "Migração para Postgres" (unchanged, following section).

- [ ] **Step 4: Commit**

```bash
git add docs/OPERATIONS.md
git commit -m "docs: document the regression-gate CI check and its mock-mode limitation"
```

---

### Task 7: Add ADR 0037 for the regression-gate CI decision

**Files:**
- Create: `docs/adr/0037-regression-gate-ci-check.md`

**Interfaces:**
- Consumes: the exact CI job name and behavior from Task 3 (must be complete first).

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0037-regression-gate-ci-check.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0037-regression-gate-ci-check.md
git commit -m "docs: add ADR 0037 for the regression-gate CI check"
```

---

### Task 8: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full check suite**

Run: `npm run check`
Expected: exits 0 — format, lint, architecture, roadmap, typecheck, test, build, secrets all pass.

- [ ] **Step 2: Run the full e2e suite**

Run: `npm run e2e --workspace @agent-foundry/api`
Expected: exits 0, all tests pass including the two router-dashboard tests from Task 5.

- [ ] **Step 3: Confirm the regression-gate CI job would actually trigger and pass on a real catalog change**

Run this local dry run (does not modify tracked files — reverted at the end):

```bash
echo '' >> models/catalog.yaml
git diff --name-only | npx tsx scripts/promotion-gate-check.ts
git checkout -- models/catalog.yaml
```

Expected: prints `true` (confirms the path-detection logic actually flags a real catalog change), then the file is restored untouched.

- [ ] **Step 4: Review the full diff for stray debug output or leftover `.data/benchmark` artifacts**

Run: `git status --short`
Expected: only the files touched by Tasks 1-7 are listed; `.data/benchmark` must NOT appear (it's gitignored — verify with `git check-ignore -q .data/benchmark && echo ignored`).
