# Plan: [HA-A.3] Promote the UI judge to a blocking gate with repair wiring (issue #477)

Repo: eedsilva/agent-foundry. Branch: `feat/477-ui-judge-blocking-gate`. Worktree:
`.claude/worktrees/477-ui-judge-gate`. Parent epic: #469. Blocked-by: #475 (merged,
`main`@0a37c6a). Governing ADR: 0058 (this issue is the "promotion to blocking is a
data-driven follow-up decision" the ADR explicitly deferred).

## Investigation findings (read before touching code)

- `report.approved` (`BrowserVerificationReportSchema`, `packages/contracts/src/preview.ts`)
  is the ONE field every downstream consumer reads to decide pass/fail — no new
  path needed:
  - `task-graph-runner.ts`'s `assertBrowserTask` (the real per-task browser-assertion
    repair loop, #325) reads `parsed.data.approved` directly (~line 478) to decide
    `quality.approved` vs `repair`, and calls `recordCompletedRepair` (→
    `consecutiveRepairs++` → `reachCeiling` at 10) on every repair round exactly as
    it does for a functional failure.
  - `workflow-orchestrator.ts`'s `conditionApproved` (quality-loop nodes, ~line 1723)
    and `assertBlockingVerification` (~line 2065) both read the same field.
  - `executeBrowserVerifyStepAttempt` (~line 2697) only checkpoints
    (`lastVerifiedCheckpoint`) when `persistedReport.approved` — an ugly-but-passing
    build correctly stops being treated as a verified checkpoint once gated.
  - **Conclusion**: flipping `approved` (true → false only, never the reverse) at
    the point `uiQuality` is computed, before the report is persisted, makes every
    one of these mechanics apply for free. Do not add a second gate/condition/event.
- **Gap found — screenshots do NOT reach repair for free.** `materializeBrowserEvidence`
  (`workflow-orchestrator.ts` ~line 3374), which turns a `browser-verification.report`
  input artifact into files a repair `AgentStep` can open, only attaches screenshots
  for `report.steps` entries with `status === 'failed'`. A UI-quality-only failure
  leaves every functional step `passed`, so today that selector yields zero files —
  the judge's findings (already embedded as JSON in the report artifact, which the
  repair prompt already renders) would reach repair, but the actual screenshots would
  not. This is the one place this issue requires a real (small, targeted) code change
  rather than pure reuse.
- `UiQualityJudgePolicySchema` (`packages/contracts/src/policy.ts`) is `{ provider,
  model }`, `.strict()`, optional on `ProjectPolicy`. Absent = judge never runs
  (unchanged since #475). No project's `policies/*.yaml` sets it today.
- HA-A.1 real-run evidence (`docs/evidence/issue-475-ui-quality-judge/judge-result.json`):
  a real Claude Sonnet 5 judge scored the CURRENT (imperfect but shipped, post-#476)
  scaffold sign-in screen `overallScore: 0.43`, with per-criterion lows as low as 0.20
  (empty/loading/error states). This is the concrete "what does today's real, accepted
  output score" data point the issue asks the threshold to be justified against —
  the default threshold must sit clearly below 0.43 or every real run would gate-fail
  on day one.

## Global Constraints

- **Reuse, do not reinvent** (mirrors #475's own constraint): the gate is a value
  computed once, at the existing `uiQuality` computation seam in
  `executeBrowserVerifyStepAttempt`. No new artifact field beyond the threshold
  config, no new event kind, no new repair path, no second ceiling counter.
- **`approved` only ever moves true → false**, never false → true. A functionally
  failing report stays failing regardless of judge score.
- **Config-gated, not code-defaulted.** The threshold is a new optional field on
  `UiQualityJudgePolicySchema`. Its absence (including on every policy that already
  opts into the advisory judge via `{ provider, model }` with no threshold) preserves
  #475's exact advisory-only behavior — this is what keeps the change backward
  compatible for any project already using the judge. Do not give the zod schema a
  numeric `.default(...)` — "start lenient" is a config/evidence concern (Task 5's
  fixture and any real policy that opts in), not a hidden code default.
- **`exactOptionalPropertyTypes` is repo-wide.** Every new optional field uses real
  optionality (`field?: T`). Run `npx tsc -b packages/contracts packages/orchestrator`
  after every task.
- **No `schemaVersion` bump** — additive optional field only, same precedent #475
  and ADR 0056 already established.
- **Testing convention**: hand-written fakes via narrow `Pick<...>` interfaces, no
  mocking library, fixtures built through the real zod schemas — matches
  `workflow-orchestrator.test.ts` / `task-graph-runner.test.ts`'s existing style.

## Task 1: Threshold config field

Edit `packages/contracts/src/policy.ts`. Add to `UiQualityJudgePolicySchema`:

```ts
export const UiQualityJudgePolicySchema = z
  .object({
    provider: ProviderSchema,
    model: z.string().min(1),
    /**
     * Promotes the judge from advisory to a blocking gate (#477, ADR 0058): a
     * report whose uiQuality.overallScore falls below this value flips
     * `approved` to false, routing through the same repair loop a failed
     * functional check would. Absent (the default, including every policy
     * that only set `provider`/`model` under #475) keeps the judge purely
     * advisory — unchanged behavior.
     */
    minOverallScore: z.number().min(0).max(1).optional(),
  })
  .strict();
```

**Test** — extend `packages/contracts/src/policy.test.ts`: a policy with
`uiQualityJudge: { provider, model }` (no threshold) still parses (regression guard
for #475 backward compat); a policy with `minOverallScore: 0.3` parses; `-0.1` and
`1.1` are rejected.

## Task 2: Gate function + wiring

New exported pure function in `packages/orchestrator/src/ui-quality-judge.ts`:

```ts
export function gateOnUiQuality(
  report: BrowserVerificationReport,
  uiQuality: UiQualityJudgeResult | undefined,
  minOverallScore: number | undefined,
): BrowserVerificationReport {
  if (!report.approved || !uiQuality || minOverallScore === undefined) return report;
  if (uiQuality.overallScore >= minOverallScore) return report;
  return {
    ...report,
    approved: false,
    summary: `${report.summary} UI-quality gate failed: overall score ${uiQuality.overallScore.toFixed(2)} is below the configured minimum ${minOverallScore.toFixed(2)}.`,
  };
}
```

Pure and unit-testable in isolation — no orchestrator/executor scaffolding needed for
its own tests. Wire it into `workflow-orchestrator.ts`'s `executeBrowserVerifyStepAttempt`
right after `uiQuality` is computed (~line 2651-2664), before the report is merged with
`uiQuality` and persisted:

```ts
const uiQuality = await this.judgeUiQuality(/* ... unchanged ... */);
const gated = gateOnUiQuality(report, uiQuality, policy.uiQualityJudge?.minOverallScore);
artifact = await this.artifacts.put({
  ...
  content: uiQuality ? { ...gated, uiQuality } : gated,
  ...
});
```

**Test** — new unit tests for `gateOnUiQuality` in `ui-quality-judge.test.ts` (or a
sibling `ui-quality-judge.gate.test.ts` if that file is already large — check first):
below-threshold flips `approved` true→false and the summary names the gate; at/above
threshold leaves the report byte-identical; `minOverallScore: undefined` (judge
configured with no threshold, or not configured at all) leaves the report unchanged
regardless of how low `overallScore` is (this is the #475 backward-compat guarantee);
a report that was already `approved: false` is returned unchanged (never flips
false→true, and does not double-append the gate sentence to its summary).
Also extend `workflow-orchestrator.test.ts`'s existing UI-quality wiring test (added
under #475) with one case that sets a policy threshold above a scripted judge score and
asserts the persisted artifact's `approved` is `false`.

## Task 3: Screenshots reach repair on a judge-only failure

Edit `materializeBrowserEvidence` (`workflow-orchestrator.ts` ~line 3374). Today:

```ts
const screenshots = report.previewSession.evidence.screenshots.filter((shot) =>
  failedStepIds.has(shot.stepId),
);
```

Extend the selection to also include any screenshot referenced by
`report.uiQuality?.screenshotsReviewed` when present, de-duplicated against the
failed-step set by `(name, revision)` (a screenshot can be in both sets when a step
both failed functionally and was reviewed by the judge — write it once). Keep the
function's existing behavior byte-identical when `uiQuality` is absent (the #475
advisory-only path, and every pre-#477 caller).

**Test** — extend whichever existing test file covers `materializeBrowserEvidence`
(grep for it first; it may only be covered indirectly today via the repair-step
integration test — if so, add a direct unit test rather than relying on an indirect
one). Fixture: a report with all `steps` `passed` and a populated `uiQuality` with
`screenshotsReviewed` naming 2 screenshots that exist in the artifact store. Assert
`materializeBrowserEvidence` returns 2 `inputFiles`. A second case with no `uiQuality`
and one failed step keeps returning exactly that step's screenshot (regression guard).

## Task 4: Repair-routing and emergency-ceiling reuse test

New focused test in `packages/orchestrator/src/task-graph-runner.test.ts` (the real
production consumer of the browser-assertion repair loop — `assertBrowserTask`, not
the quality-loop node type, which current grep shows is exercised only by tests).
Construct a scenario via a fake browser-verify executor/coordinator: the underlying
functional check is `approved: true` (every step passes) and a policy sets
`uiQualityJudge.minOverallScore` above a scripted low judge score. Assert, using this
repo's existing hand-written-fake style:

- `quality.repair_requested` IS emitted for this attempt — driven purely by the gated
  `approved: false`, with no separate "ui-quality-repair-requested" event kind.
- The repair `AgentStep` is invoked with the browser-verification report as a pinned
  input artifact — identical mechanics to a functional-failure repair.
- `recordCompletedRepair` is called exactly once per round, incrementing
  `consecutiveRepairs` exactly as a functional-failure repair would (assert against
  the existing emergency-ceiling counting helpers/fixtures already used in
  `emergency-ceiling.test.ts` — reuse them, do not reimplement the count).
- No second/separate budget or ceiling path is introduced: repeat the scenario past
  10 consecutive rounds (mirroring `emergency-ceiling.test.ts`'s existing "reaches
  ceiling" fixture) and assert `reachCeiling('consecutive-repairs', ...)` fires at
  the same count a functional-failure repair loop would, not a different one.

## Task 5: Induced-ugly evidence run (fail → repair → pass)

Extend `packages/composition/src/ui-quality-judge.integration.test.ts` (real
`createRuntime`, `EXECUTOR_MODE: 'mock'`, temp `DATA_DIR` — same style as the rest of
that file) with a scenario using a policy with `uiQualityJudge: { provider, model,
minOverallScore: 0.3 }` (see justification below) and a scripted mock judge executor
that returns a low score (e.g. `overallScore: 0.1`) on the first browser-verification
attempt and a passing score (e.g. `overallScore: 0.8`) on the attempt following repair.
Drive the run (same `projectService.create` → repeated `worker.runOnce()` pattern
Task 5 of #475's plan used) through: browser-verify #1 (functionally approved, judge
below threshold → gated `approved: false` → repair requested) → repair step runs →
browser-verify #2 (judge above threshold → `approved: true` → run proceeds). Assert
on the persisted artifacts/events: exactly one `quality.repair_requested` for this
step, the final `browser-verification.report` has `approved: true` and a `uiQuality`
matching the second scripted score, and `consecutiveRepairs` was incremented then
reset (Task 4's counting, exercised end-to-end here).

**Threshold justification (cite in the PR description)**: HA-A.1's real judge run
(`docs/evidence/issue-475-ui-quality-judge/judge-result.json`) scored the current,
shipped, post-#476 scaffold `overallScore: 0.43`. A threshold must sit clearly below
that or the gate would fail real, accepted output on day one ("thresholds start
lenient", per the issue). `0.3` is proposed as the fixture/example value: comfortably
below the one real data point available, low enough to only catch UI that scores
noticeably worse than today's imperfect-but-shipped baseline.

**Evidence capture** (after this task passes review, mirroring
`docs/evidence/issue-475-ui-quality-judge/`'s and #487/#511's precedent): write
`docs/evidence/issue-477-ui-judge-gate/README.md` capturing this test's actual run
output (event sequence, the two judge scores, the repair round, the final
`approved: true`) as the "one induced-ugly run demonstrates fail → repair → pass"
acceptance evidence. Note explicitly, as the #475 evidence doc did, that this is the
fastest available *genuinely-exercised* route (real orchestrator/gate/repair code,
scripted judge scores) rather than a full `EXECUTOR_MODE=real` tracer run, per the
same precedent (`docs/evidence/harness-alignment/scaffold-baseline-487/README.md`) —
`docs/evidence/issue-475-ui-quality-judge/README.md` already documents that a full
real-mode tracer run currently hard-crashes at task T5 on an unrelated defect
(defect #2, harness-alignment defect-list) before ever reaching browser-verify.

## Task 6: ADR update

`docs/adr/0058-ui-quality-gate-in-browser-verification.md` explicitly deferred
"promotion to blocking" as a data-driven follow-up — this issue is that follow-up.
Flip `Status: Proposed` → `Status: Accepted` and append a short `## Update
(2026-08-12, #477)` section: the judge is promoted to a blocking gate via
`ProjectPolicy.uiQualityJudge.minOverallScore` (optional — absent keeps it advisory,
matching every pre-existing policy); a below-threshold score flips the existing
`approved` field rather than adding a parallel gate; repair/ceiling mechanics are
100% reused, not reimplemented; link the HA-A.1 evidence data point and Task 5's
induced-ugly evidence as the threshold's justification.
