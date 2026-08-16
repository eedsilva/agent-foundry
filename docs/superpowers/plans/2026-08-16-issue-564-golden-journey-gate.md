# Issue #564 — the golden-journey gate, 4/4

## Problem

`#564` asks for four real golden journeys — `toy`, `crud-heavy`, `dashboard-heavy`,
`auth-heavy` — to end in a terminal pass, in a real browser, against a real local
Supabase, with trace, logs, executed model, duration, cost and tested commit attached
to each run.

The pieces to run one journey exist. The gate does not.

- `scripts/tracer.ts --all` runs the four scenarios and prints one line each. It exits
  `0` whether a run completed or crashed, so it can be scripted but cannot gate.
- The per-run `ValidationEvidenceBundle` already carries everything AC5 asks for —
  `sourceRevision` (the tested commit), per-attempt `executedModel`/`durationMs`/`usage`,
  the eight gates, browser and database evidence references, `terminalState`. But it
  lives inside `DATA_DIR` as an artifact. Every prior evidence document under
  `docs/evidence/` was assembled out of it **by hand**.
- A budget-exhausted run and a genuinely broken run are indistinguishable from the
  bundle's top-level fields: both read `outcome: "product-failed"`, the difference
  recoverable only from `terminalState.error.code` (defect #6 in
  `docs/evidence/harness-alignment/defect-list.md`).

So the gate is four manual runs plus a human reading four artifact trees. That is what
#564 has to stop being.

## What this builds

**A verdict, a runner, and a budget that a four-shape run can actually fit inside.**

### 1. `evaluateGoldenJourneyGate` — the verdict (pure)

New `packages/composition/src/golden-journey-gate.ts`. Takes a scenario's run status
plus its `ValidationEvidenceResponse` (or the absence of one) and returns:

```ts
type GoldenJourneyStatus =
  | 'passed'
  | 'failed'
  | 'exhausted'
  | 'environment-blocked'
  | 'no-evidence';
```

`passed` requires **all three**, because they are three different claims and the issue's
phrase "terminal `passed`" collapses them:

1. `terminalState.status === 'completed'` — the run reached a terminal state, and the
   terminal state it reached was success. (`WorkflowRunStatus` has no `passed`; the
   terminal set is `cancelled | completed | failed | rejected`.)
2. `outcome === 'accepted'` — the bundle's own classification.
3. every one of the eight mandatory gates is `status: 'passed'`.

Condition 3 is redundant today: `classifyOutcome` already refuses `accepted` to any bundle
with a gate that is not `passed`, `skipped` and `unavailable` included. It is asserted
anyway. `outcome` is one classifier's summary of the evidence, living in a package the gate
does not own; the gates are the evidence. Reading the summary instead of the evidence is one
refactor away from signing off a run whose `database-match` was never captured — precisely
what AC2 ("confirma persistência real no banco local") demands be proven.

`exhausted` is split out from `failed` on
`terminalState.error.code === 'VALIDATION_CAMPAIGN_LIMIT'`. This is defect #6, fixed at
the reporting layer rather than in the bundle schema: an exhausted run is a sizing
finding, not a product defect, and the operator needs to see that in the summary table
without opening four JSON files. The bundle keeps saying `product-failed`; nothing about
the persisted contract changes.

`no-evidence` is what mock mode produces — the evidence publisher is only wired when a
campaign is selected, and a campaign is only accepted in real mode. It is a distinct
status rather than a failure so `--executor-mode mock` stays a usable smoke test of the
runner itself.

### 2. `--evidence-dir` and `--gate` — the runner

`scripts/tracer.ts` gains two flags:

- `--evidence-dir <dir>` writes, per scenario, `<dir>/<scenarioId>/bundle.json` (the
  redacted bundle verbatim, as published) and `<dir>/README.md` — one summary table over
  all scenarios carrying, per AC5, the tested commit, executed models, wall-clock
  duration, attempt and quota totals, and the run/project ULIDs that address the trace
  and logs inside `DATA_DIR`.
- `--gate` makes any non-`passed` verdict exit non-zero.

`--gate` is opt-in rather than the default because `--all` today is also how a shape is
smoke-tested in mock mode, and a runner that fails on `no-evidence` would break that.
The documented gate command passes both flags.

The runner does not stop at the first failure. Four shapes cost hours; discovering three
defects in one sitting beats discovering one.

### 3. `VALIDATION_ACTIVE_TIME_MINUTES` — a budget four shapes can fit

`real-todo-v1` pins `activeTimeMinutes: 60`. That number was set for the single-shape
TODO campaign. The measured evidence says it does not fit the shapes #564 names:
`auth-heavy` completed 6 of 15 tasks and terminated **at** the cap
(`activeElapsedMs: 3,600,725`), and #527's `toy` run alone took 72 minutes of wall clock.
With the cap as shipped, three of the four shapes cannot reach a terminal pass — the gate
would be measuring the budget, not the product.

The campaign builder reads `VALIDATION_ACTIVE_TIME_MINUTES` and fails closed: absent →
60, present and not a positive integer → throw. The value flows into the campaign preview
and therefore into every bundle's campaign snapshot, so evidence always records the
budget the run was given. Raising the ceiling silently in the campaign definition would
have removed that record.

### 4. `crud-heavy` gains an attachment

AC3 names attachment among the surfaces the journey must exercise. No tracer scenario had
one — attachment existed only in `issue-radar-golden-journey.spec.ts`, against a
hand-authored reference app. `crud-heavy` is the right host: it already owns file-shaped
domain objects and the storage path is the same one RLS covers.

## What this does not build

**The runs themselves.** Four real journeys are the QA campaign, not a diff. This change
is what makes that campaign one command with a machine-checkable verdict; it does not
assert that the verdict comes back green. #564 closes on that evidence, not on this PR.

**Defect #2 — a refused browser plan kills the run.**
`packages/orchestrator/src/task-graph-runner.ts:771-776`: when a `browser-visible` task's
plan step answers `blocked`, the runner throws `ExecutionError` and the whole run fails.
The tester is answering correctly — the component is not yet on a reachable route — and
the orchestrator has no way to defer or re-sequence on that verdict. This is what killed
`dashboard-heavy` and it is still unfixed. Deferring a task's browser acceptance to
end-of-graph verification changes what a task-level acceptance means, which needs its own
ADR and its own evidence. Filed as #571; the gate's job here is to surface it.

**Asserting `expectedCapabilities`.** They remain a human checklist
(`packages/contracts/src/tracer-scenario.ts:14-15`). The real browser assertions are the
agent-authored `browser-test.plan` artifacts, per task.

**Visual edit and revert.** Those are builder operations, not generated-app features, and
`apps/api/e2e/golden-flow.spec.ts:986` already covers them. The runbook maps each AC3
surface to where it is proven rather than duplicating them into a scenario PRD.

## Verification

- `golden-journey-gate.test.ts` — verdict truth table: completed+accepted+8 passed gates;
  accepted with a skipped `database-match`; `VALIDATION_CAMPAIGN_LIMIT`; an environment
  failure class; a missing bundle; evidence-file layout.
- `validation-campaign.test.ts` — budget default, override, and each fail-closed rejection.
- `npm run tracer:run -- --all --executor-mode mock` — the four-scenario loop and the
  summary table, end to end, no providers.
- `npm run check`.
