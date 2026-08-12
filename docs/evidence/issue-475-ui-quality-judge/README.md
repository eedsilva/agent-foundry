# UI-quality judge — real-run evidence (#475)

#475's acceptance criteria require "at least one tracer rerun shows judge
output attached to run evidence" / "judge report artifact from a real run".
PR #506 shipped the rubric, `evaluateUiQuality()`, and its orchestrator wiring
(ADR 0058), but its own test evidence is a scripted mock executor — real
enough structurally, not semantically. This closes that gap.

## Method

A full real-mode tracer run (`EXECUTOR_MODE=real`, toy Counter scenario,
`uiQualityJudge: { provider: claude, model: haiku }` policy) was attempted
first and driven through `projectService.create` → `worker.runOnce()` →
`approveAllGates`. It ran for ~50 minutes of real wall-clock/API time and then
hard-crashed at task T5 with `ExecutionError: "Task T5 declares
browser-visible acceptance, but its browser plan refused the assertion"` —
this reproduces defect #2 in
[`docs/evidence/harness-alignment/defect-list.md`](../harness-alignment/defect-list.md)
(orchestrator has no recovery path for a tester's correct browser-plan
refusal) on a 4th, minimal app shape. It never reached the browser-verify
step, so no judge evidence came out of it. Its leaked Supabase Docker stack
was torn down after the crash.

Per the same precedent
[`docs/evidence/harness-alignment/scaffold-baseline-487/README.md`](../harness-alignment/scaffold-baseline-487/README.md)
set (real tracer runs blocked → fastest available *genuinely real* route
instead of a scripted mock), this instead calls
`evaluateUiQuality()` (`packages/orchestrator/src/ui-quality-judge.ts`)
directly against a real `claude` `AgentExecutor` from the production
`ExecutorRegistry` (`EXECUTOR_MODE=real`, no orchestration, no Docker) and a
real screenshot: [`screenshot.jpg`](screenshot.jpg), the same
`/sign-in` capture from #487's scaffold-baseline evidence
(`after-sign-in.jpg`, current `main` scaffold post-#476). This isolates the
judge stage itself — the thing #475 asked to see evidence of — from the
unrelated orchestration defect that blocks a full run.

Real model used: `claude-sonnet-5` (`packages/orchestrator/src/ui-quality-judge.ts`'s
`buildPrompt` + `UI_QUALITY_JUDGE_JSON_SCHEMA`, same code path production
runs use). Full result: [`judge-result.json`](judge-result.json).

## Result

The judge produced genuine, screenshot-specific findings across all 5 rubric
criteria (`rubricVersion: "1"`) — not templated text:

| Criterion | Score | Finding |
|---|---|---|
| layout-coherence | 0.55 | Large unbalanced dead zone below the vertically-uncentered form |
| navigation | 0.45 | Unlabeled circular "N" icon with no visible affordance |
| empty-loading-error-states | 0.20 | No error/loading feedback shown after a sign-in attempt |
| contrast-readability | 0.45 | "Sign in" button nearly indistinguishable from the near-black background |
| responsive-sanity | 0.50 | Only one viewport captured; can't verify adaptive behavior |

Overall score: 0.43. The low contrast/empty-state findings track real,
plausible scaffold gaps — consistent with the judge doing real visual
assessment rather than returning fixed output.

## Scope note

This is not new #475 scope — #475's implementation (PR #506) is unchanged.
This only supplies the real-run evidence artifact its own acceptance
criteria required. The orchestration defect that blocked the full tracer
rerun is tracked separately (defect #2, harness-alignment defect-list); #475
does not fix it.
