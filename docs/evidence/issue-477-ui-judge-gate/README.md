# UI-quality blocking gate — induced-ugly fail → repair → pass evidence (#477)

#477's acceptance criteria require "one induced-ugly run demonstrates fail →
repair → pass". This is that run.

## Method

Per the same precedent
[`docs/evidence/issue-475-ui-quality-judge/README.md`](../issue-475-ui-quality-judge/README.md)
set: a full `EXECUTOR_MODE=real` tracer run is currently blocked by an unrelated
orchestration defect (defect #2, `docs/evidence/harness-alignment/defect-list.md`
— no recovery path for a tester's correct browser-plan refusal), which that
earlier evidence run hit directly and which would equally block a real-mode
attempt here. Rather than a scripted mock standing in for real orchestrator
code, this instead drives a **real, in-process, mock-executor run through every
layer this feature touches** — `projectService.create` → `worker.runOnce()` →
`approveAllGates`, the same sequence `apps/api/e2e/golden-flow.spec.ts` drives
over HTTP — with only the UI-quality judge's model call scripted
(`packages/composition/src/ui-quality-judge.integration.test.ts`, `describe('#477:
a low UI-quality score gates the run, repairs, then passes', ...)`). Everything
else — the orchestrator's `gateOnUiQuality` flip, `task-graph-runner.ts`'s
`assertBrowserTask` repair loop, the emergency-ceiling counter, the artifact
store, the event log — is real production code, not mocked or scripted.

The judge is scripted to return `overallScore: 0.1` on its first call and `0.8`
on every call after, against a policy setting `uiQualityJudge.minOverallScore:
0.3`. `0.3` is chosen against real data: HA-A.1's real judge run
([`docs/evidence/issue-475-ui-quality-judge/judge-result.json`](../issue-475-ui-quality-judge/judge-result.json))
scored the current, shipped, post-#476 scaffold `overallScore: 0.43` — a
threshold must sit clearly below that or the gate would fail real, accepted
output on day one ("thresholds start lenient", per the issue). `0.3` is
comfortably below that one real data point.

Reproduce with:

```
npx vitest run packages/composition/src/ui-quality-judge.integration.test.ts
```

## Result

The induced-ugly round (first browser-verify attempt) genuinely gated and
repaired, on the first real run — no wiring changes were needed after this test
was written:

```
task.started               ...:task:task-execution:T2:started          T2: Implement the core flow
agent.completed             implement.T2                               Mock developer completed implement.T2
verification.completed      verify-task.T2                             All configured deterministic checks passed.
quality.approved            ...:task:task-execution:T2:1:approved       T2: All configured deterministic checks passed.
agent.completed              plan-task-browser-test.T2                  Mock tester completed plan-task-browser-test.T2
verification.completed      (browser check, round 1)                   Mock browser verification passed. UI-quality gate failed: overall score 0.10 is below the configured minimum 0.30.
artifact.created            browser-verification.report:r1
quality.repair_requested    ...:T2:browser:1:repair_requested          T2: ... UI-quality gate failed ...
agent.routed                repair-task-browser.T2
verification.completed      (browser check, round 2)                   Mock browser verification passed.
artifact.created            browser-verification.report:r2
quality.approved            ...:T2:browser:2:approved                  T2: Mock browser verification passed.
quality.approved            ...:task:task-execution:T2:4:approved      T2: All configured deterministic checks passed.
task.completed               ...:task:task-execution:T2:completed
... full-suite-verification, release-assessment, diff-approval (approved) ...
verification.completed      (browser check re-run on resume)           Mock browser verification passed.
artifact.created            browser-verification.report:r3
quality.approved            ...:T2:browser:1:approved
project.completed                                                     Workflow web-app-v1 completed.
```

The round-1 browser-verification report was functionally passing (every step
`passed`) but the judge scored it `0.10` — below the `0.30` threshold — so
`gateOnUiQuality` flipped `approved` to `false` and the summary recorded why:
`"Mock browser verification passed. UI-quality gate failed: overall score 0.10
is below the configured minimum 0.30."` That routed through the *exact same*
repair mechanics a functional failure already uses: a `quality.repair_requested`
event, `repair-task-browser.T2` invoked with the gated report as a pinned input
artifact, and the emergency-ceiling counter incremented for the round. Round 2's
judge call scored `0.8` — above threshold — so the gate left `approved: true`
alone, the task completed, and `consecutiveRepairs` reset to `0`.

Full assertions on the test (from
[`docs/superpowers/plans/2026-08-12-477-ui-judge-blocking-gate.md`](../../superpowers/plans/2026-08-12-477-ui-judge-blocking-gate.md)'s
Task 5):

| Assertion | Result |
|---|---|
| `project.status` | `'completed'` — the run finished despite the induced mid-run failure |
| Judge call trail | `[0.1, 0.8, 0.8]`, all for `assert-task.T2` (mock mode's one browser-visible task) — first two exactly `[0.1, 0.8]`, no later call serves `0.1` |
| `:browser:`-scoped `quality.repair_requested` events | Exactly 1, message contains `UI-quality gate failed` |
| Final `browser-verification.report` | `approved: true`, `uiQuality.overallScore === 0.8` (the post-repair score, not the gated one) |
| `execution.consecutiveRepairs` after completion | `0` — the real run reset the emergency-ceiling counter after the gate-caused repair |

Full judge-scored final report (round 2's passing score, matching the schema
`UiQualityJudgeResultSchema`):

```json
{
  "rubricVersion": "1",
  "judgeModel": "mock:mock/ui-quality-judge-mock",
  "overallScore": 0.8,
  "criteria": [
    { "criterionId": "layout-coherence", "score": 0.8, "finding": "Mock finding for layout-coherence." },
    { "criterionId": "navigation", "score": 0.82, "finding": "Mock finding for navigation." },
    { "criterionId": "empty-loading-error-states", "score": 0.84, "finding": "Mock finding for empty-loading-error-states." },
    { "criterionId": "contrast-readability", "score": 0.86, "finding": "Mock finding for contrast-readability." },
    { "criterionId": "responsive-sanity", "score": 0.88, "finding": "Mock finding for responsive-sanity." }
  ],
  "screenshotsReviewed": [
    { "name": "browser-screenshot-mock-preview-3-open-root", "revision": 1, "sha256": "d76c4b64a136006cb040529b94d867501e54f897eda8f47fe56b4128d084bc93", "sizeBytes": 70 }
  ]
}
```

## A note on a third judge call

The event trail shows a third judge call (round-1's browser check re-running on
resume, after the `diff-approval` gate) — resuming a run past that gate replays
the workflow, and while most steps' artifacts are reused, the browser plan/check
steps require a live preview session and re-execute. That third call also scores
`0.8` (the repeating passing score) and does not affect any of the assertions
above, which key off the round-1 gate event and the final persisted report, not
a fixed call count. This is a pre-existing replay characteristic of the mock
pipeline, unrelated to #477's gate logic.

## Scope note

This is not #475 scope — #475's implementation (PR #506) and its own evidence
(`docs/evidence/issue-475-ui-quality-judge/`) are unchanged. This documents
#477's own required evidence: a real fail → repair → pass cycle through the
blocking gate this issue adds.
