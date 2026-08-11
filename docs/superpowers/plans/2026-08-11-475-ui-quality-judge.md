# Plan: [HA-A.1] UI-quality rubric and advisory judge stage (issue #475)

Repo: eedsilva/agent-foundry. Branch: `feat/475-ui-quality-judge`. Worktree:
`.claude/worktrees/475-ui-quality-judge`. Parent epic: #469. Governing ADR: 0058
(judge lives INSIDE the existing browser-verification loop — no new pipeline
stage). Forward-compat precedent: ADR 0056 (new/retired fields stay
`.optional()`, no schema-version bump for additive changes).

## Global Constraints

- **No new pipeline stage, no new artifact-store category, no new event kind.**
  Extend `BrowserVerificationReportSchema` (`packages/contracts/src/preview.ts`)
  with new OPTIONAL fields only. The judge output persists inside the existing
  `browser-verification.report` artifact — never a second artifact.
- **Forward compatibility**: every new field must be `.optional()`. A
  pre-existing `browser-verification.report` artifact (`schemaVersion: '1'`, no
  `uiQuality` field) must still parse under the updated schema unchanged. Do
  NOT bump `schemaVersion` — this is an additive optional-field change, not a
  version bump, per ADR 0056's precedent.
- **Advisory means advisory.** The judge's score/output must NEVER be read by:
  `conditionApproved` (`packages/orchestrator/src/workflow-orchestrator.ts`),
  `assertTask`'s `approved` check
  (`packages/orchestrator/src/task-graph-runner.ts`),
  `recordCompletedRepair`/`resetConsecutiveRepairs`, or any `reachCeiling`
  trigger condition. `report.approved` must be computed identically before and
  after this change — verify by grepping every read site of `.approved` on a
  `BrowserVerificationReport`, not just by intent.
- **`exactOptionalPropertyTypes` is repo-wide** (`tsconfig.base.json`). Every
  new optional field must use real optionality (`field?: T`, never assigned
  `undefined` explicitly). Run `npx tsc -b packages/contracts
  packages/orchestrator packages/executors` after every task — this has
  slipped past vitest-only verification twice before in this repo.
- **Reuse, do not reinvent:**
  - The judge's actual model call goes through the existing
    `AgentExecutionRequest`/`AgentExecutor` port
    (`packages/domain/src/ports.ts`, request shape in
    `packages/contracts/src/agent.ts`). This is what makes
    `EXECUTOR_MODE=mock` work for the judge automatically, with no separate
    mock-handling code to write.
  - Reuse `redact()`/`sanitizeUrl()` from
    `packages/executors/src/browser-verifier.ts` for any judge-authored text
    that could echo a preview URL/token. Export `redact` from that file if it
    isn't already exported — do not duplicate its logic.
  - Reuse the `materializeBrowserEvidence` mechanism
    (`packages/orchestrator/src/workflow-orchestrator.ts`) for writing
    screenshot files to disk for the judge to read. Extend or call it — do not
    write a second screenshot-materialization path.
- **Cap judge arrays** analogous to the existing `MAX_OBSERVATIONS = 100`
  pattern in `packages/executors/src/browser-verifier.ts`. Use a cap of 20 for
  the judge's `criteria` array, enforced both at construction (silently
  truncate, never throw) and via `superRefine` on the new schema (hard parse
  error only if a writer somehow violates the cap).
- **Testing convention**: hand-written fake objects implementing narrow
  `Pick<...>` interfaces (no mocking library), matching
  `packages/orchestrator/src/browser-verification-coordinator.test.ts`'s
  style. Build fixtures via the real zod schemas (`Schema.parse({...})`), not
  hand-typed objects that bypass validation.
- **Agent role/task kind**: reuse existing enum members — do not add a new one.
  `AgentRoleSchema` (`packages/contracts/src/primitives.ts`) has no dedicated
  "judge" role; use `role: 'tester'` and `taskKind: 'verification'` — the
  closest existing fit, matching the conceptual category the browser-
  verification step itself already runs under.

## Task 1: Rubric artifact schema and versioned content

New file: `packages/contracts/src/ui-quality-rubric.ts`.

```ts
import { z } from 'zod';

export const UiQualityRubricCriterionSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();
export type UiQualityRubricCriterion = z.infer<typeof UiQualityRubricCriterionSchema>;

export const UiQualityRubricSchema = z
  .object({
    version: z.literal('1'),
    criteria: z.array(UiQualityRubricCriterionSchema).min(1),
  })
  .strict();
export type UiQualityRubric = z.infer<typeof UiQualityRubricSchema>;

export const CURRENT_UI_QUALITY_RUBRIC_VERSION = '1' as const;
```

Below that, define and export `UI_QUALITY_RUBRIC_V1: UiQualityRubric`, parsed
through `UiQualityRubricSchema.parse(...)`, with exactly these 5 criteria (ids
verbatim — the report schema and tests in later tasks reference these exact
ids):

- `id: 'layout-coherence'`, `title: 'Layout coherence'`
- `id: 'navigation'`, `title: 'Navigation'`
- `id: 'empty-loading-error-states'`, `title: 'Empty/loading/error states'`
- `id: 'contrast-readability'`, `title: 'Contrast & readability'`
- `id: 'responsive-sanity'`, `title: 'Responsive sanity'`

Write a one-sentence `description` for each, plain enough to prompt a judge
model — no scoring-rubric prose beyond that.

Add `export * from './ui-quality-rubric.js';` to `packages/contracts/src/index.ts`.

**Test** — new file `packages/contracts/src/ui-quality-rubric.test.ts`:
`UI_QUALITY_RUBRIC_V1` parses against `UiQualityRubricSchema`; has exactly 5
criteria; the criteria ids equal exactly the 5 ids above (order-independent
set comparison); `version === CURRENT_UI_QUALITY_RUBRIC_VERSION`.

## Task 2: Extend `BrowserVerificationReportSchema` with an optional `uiQuality` field

Edit `packages/contracts/src/preview.ts`. Add, near
`BrowserVerificationReportSchema`:

```ts
export const UiQualityCriterionScoreSchema = z
  .object({
    criterionId: z.string().min(1),
    score: z.number().min(0).max(1),
    finding: z.string().min(1).max(500).optional(),
  })
  .strict();
export type UiQualityCriterionScore = z.infer<typeof UiQualityCriterionScoreSchema>;

export const UiQualityJudgeResultSchema = z
  .object({
    rubricVersion: z.literal('1'),
    judgeModel: z.string().min(1),
    overallScore: z.number().min(0).max(1),
    criteria: z.array(UiQualityCriterionScoreSchema).min(1),
    screenshotsReviewed: z.array(ArtifactReferenceSchema).max(20),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.criteria.length > 20) {
      ctx.addIssue({
        code: 'custom',
        message: 'A UI-quality judge result may contain at most 20 criterion scores',
        path: ['criteria'],
      });
    }
  });
export type UiQualityJudgeResult = z.infer<typeof UiQualityJudgeResultSchema>;
```

Add `uiQuality: UiQualityJudgeResultSchema.optional()` to
`BrowserVerificationReportSchema`'s base object shape — add it as a new
property alongside the existing ones (`schemaVersion`, `approved`, `summary`,
`planArtifact`, `previewSession`, `planValidationError`, `steps`). Do not
touch the existing `.strict().superRefine(...)` chain's logic (the
observations cap etc.) beyond adding this one field to the base shape it
wraps.

Export `UiQualityCriterionScoreSchema`/`UiQualityJudgeResultSchema` and their
inferred types (they're already covered by `preview.ts`'s existing re-export
from `packages/contracts/src/index.ts` — verify, don't add a duplicate
export line).

**Test** — extend `packages/contracts/src/preview.test.ts` with a new
`describe('BrowserVerificationReportSchema uiQuality field', ...)` block:
- A report built from an existing valid fixture, WITHOUT `uiQuality`, still
  parses (forward-compat with pre-existing `schemaVersion: '1'` reports).
- The same report WITH a valid `uiQuality` (use the 5 criteria ids from Task
  1) parses.
- The same report WITH `uiQuality.criteria` containing 21 entries fails to
  parse with a message containing "at most 20".

## Task 3: Judge invocation seam and wiring into the browser-verification step

New file: `packages/orchestrator/src/ui-quality-judge.ts`.

Export:

```ts
export interface EvaluateUiQualityInput {
  runId: string;
  stepRunId: string;
  attemptId: string;
  projectId: string;
  stepId: string;
  cwd: string;
  screenshotFiles: Array<{ stepId: string; localPath: string; ref: ArtifactReference }>;
  rubric: UiQualityRubric;
  executor: Pick<AgentExecutor, 'execute'>;
  provider: Provider;
  model: string;
  timeoutMs: number;
}

export async function evaluateUiQuality(
  input: EvaluateUiQualityInput,
): Promise<UiQualityJudgeResult | undefined> { ... }
```

Behavior:
- Build an `AgentExecutionRequest` (`role: 'tester'`, `taskKind:
  'verification'`, using `input.runId`/`stepRunId`/`attemptId`/`projectId`/
  `stepId`/`cwd`/`provider`/`model`/`timeoutMs`) whose `prompt` embeds the
  rubric's criteria (id + title + description from `input.rubric.criteria`)
  and lists the relative screenshot file paths (from `input.screenshotFiles`,
  relative to `cwd`) the model may read. Set `outputSchema` to a JSON Schema
  constraining the model's output to `{ overallScore: number, criteria:
  [{ criterionId: string, score: number, finding?: string }] }` — mirror
  `AGENT_ARTIFACT_JSON_SCHEMA`'s literal style in
  `packages/contracts/src/agent.ts` for how a JSON Schema is written in this
  codebase.
- Call `input.executor.execute(request)`. Parse `result.output.data` against
  a small internal zod schema matching the `outputSchema` shape above. Map to
  `UiQualityJudgeResult`: `rubricVersion` from `input.rubric.version`,
  `judgeModel: result.executedModel ?? result.model`, `overallScore` and
  `criteria` from the parsed output (truncate `criteria` to 20 entries if the
  model returns more), `screenshotsReviewed: input.screenshotFiles.map(f =>
  f.ref)`. Pass every `finding` string through the reused `redact()` (Global
  Constraints) before including it.
- On ANY failure — `executor.execute` throws, the output fails to parse, or
  the call times out — `evaluateUiQuality` must NOT throw. Catch internally
  and return `undefined`. A missing `uiQuality` field is a valid,
  forward-compatible "judge unavailable this run" outcome (Task 2's test
  already covers a report with no `uiQuality`).

Edit `packages/orchestrator/src/workflow-orchestrator.ts`'s
`executeBrowserVerifyStepAttempt` (or `browser-verification-coordinator.ts`'s
`attachEvidence` — read both first and pick whichever seam the actual current
code makes cleaner; document the choice in your report). After the normal
report is built and evidence is attached, but BEFORE the final
`this.artifacts.put(...)`/`BrowserVerificationReportSchema.parse(...)` call:
materialize the screenshots needed (reuse `materializeBrowserEvidence`'s
mechanism — extend its signature to return the written file paths if it
doesn't already, rather than duplicating its file-write logic), call
`evaluateUiQuality(...)` with `UI_QUALITY_RUBRIC_V1` from Task 1, and if it
returns a result, merge it into the report object as `uiQuality` before the
final parse/persist. If it returns `undefined`, persist the report exactly as
before (no `uiQuality` field).

The judge call must not be gated behind, or influence, `report.approved` in
any way — `approved` is computed from the pre-existing verification logic
exactly as before this change.

**Test** — extend the relevant existing test file for whichever seam you
picked (`workflow-orchestrator.test.ts` or
`browser-verification-coordinator.test.ts`) with a fake `executor`/judge
input returning a scripted `UiQualityJudgeResult`-shaped output. Assert: the
persisted `browser-verification.report` artifact contains `uiQuality`
populated with the scripted values, AND the run's `approved`/repair-routing
behavior is byte-identical to the equivalent run with no judge wired in at
all.

## Task 4: Emergency-ceiling and repair-routing non-interference test

Extend `packages/orchestrator/src/workflow-orchestrator.test.ts` (or
`task-graph-runner.test.ts`, matching wherever Task 3's wiring landed) with a
focused regression test, separate from Task 3's happy-path test:

Construct a scenario where the judge (via a fake `executor`) returns the
lowest possible score on every criterion (`score: 0` for all 5). Assert:
- `resetConsecutiveRepairs`/`recordCompletedRepair` are invoked (or not) based
  purely on the pre-existing `approved` boolean, unaffected by the judge
  score.
- No `reachCeiling` trigger condition fires as a result of the judge score
  alone.
- No `quality.repair_requested` event is emitted because of the judge score
  (only because of pre-existing `approved: false`, if that's what the
  fixture's underlying verification produces — construct the fixture so the
  underlying verification is `approved: true` and only the judge score is
  low, to isolate the judge as the sole variable).

This test exists specifically to catch a regression the Global Constraints
name directly — do not skip it even if Task 3's test already touches
`approved`.

## Task 5: Full run-through integration test

New file: `packages/composition/src/ui-quality-judge.integration.test.ts`
(mirror `packages/composition/src/plan-approval.integration.test.ts`'s setup
style — real `createRuntime`, `EXECUTOR_MODE: 'mock'`, a temp `DATA_DIR`).

Drive a real, in-process run through `projectService.create(...)` and
repeated `runtime.worker.runOnce()` calls until a browser-verification step
executes (this will require advancing past the plan-approval gate — read
`packages/composition/src/plan-approval.integration.test.ts` and
`apps/api/e2e/golden-flow.spec.ts` for how existing tests decide an approval
and continue a run to reach later steps, and mirror that same sequence of
calls in-process rather than over HTTP). Once a browser-verification step has
executed, fetch the persisted `browser-verification.report` artifact via
`runtime.artifacts.getLatest(...)` and assert it contains a populated
`uiQuality` field (`rubricVersion`, `judgeModel`, `overallScore`, `criteria`
with entries matching the 5 rubric criterion ids).

This is the test whose real, actual console/artifact output becomes issue
#475's required evidence ("Judge report artifact from a real run") — the
plan's author will capture this test's real run output into a
`docs/evidence/` file after this task passes review; that capture step is
not part of this task's own scope.
