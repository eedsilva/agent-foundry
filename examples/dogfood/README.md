# Dogfooding agent-foundry on itself (v0.2)

This directory defines the real v0.2 "dogfood" tasks: small, real subtasks of issues [#10](https://github.com/eedsilva/agent-foundry/issues/10)
and [#11](https://github.com/eedsilva/agent-foundry/issues/11), each run through the _actual_
product pipeline (`ProjectService.create` → queue → `WorkerLoop` → orchestrator → model router →
real CLI executor → deterministic verification) instead of calling executors directly on
synthetic toy repos, the way the provider canaries (`npm run canary:providers`) do. Every run
lands in the normal `WorkflowRun` / `StepRun` / `StepAttempt` / artifact / event / metrics
shapes, so the pipeline is exercised exactly as it would be for a real user.

## What's here

- `../../workflows/dogfood-task-v1.yaml` — implementation-gate (developer → code-reviewer →
  fixer) then deterministic-verification (`dogfood:verify` script → fixer), for tasks that
  produce a code diff.
- `../../workflows/dogfood-plan-v1.yaml` — a single plan-gate (planner → plan-reviewer →
  planner), for analysis-only tasks that must not touch the workspace.
- `tasks/*.json` — one `DogfoodTask` (see `packages/contracts/src/dogfood.ts`) per task: the
  workflow to run, the PRD prompt, the git ref the workspace is seeded from, the file allowlist,
  any seed files (e.g. a pre-written failing test the agent must make pass), and the
  `dogfood:verify` script to inject into the seeded workspace's `package.json`.

## Running a task

The runner (`packages/composition/src/dogfood.ts`, invoked via `npm run dogfood:run`) seeds a
fresh project workspace from `task.baselineRef`, writes `task.seedFiles`, wires up
`dogfood:verify`, enqueues the job, and drives the worker loop for real — it does not fake or
skip any pipeline step.

```bash
# run one task
npm run dogfood:run -- --task domain-redaction

# run every task in examples/dogfood/tasks/
npm run dogfood:run -- --all

# after a task's real PR has merged, compare the agent's diff against what a human actually shipped
npm run dogfood:run -- --annotate-human-edits <merged-ref>

# freeze the accumulated run records into docs/baselines/v0.2-dogfood.{json,md}
npm run dogfood:run -- --freeze
```

## Where records land

Every invocation appends — it never overwrites. Reruns of the same task keep every prior record,
distinguished by an incrementing `attempt` number, because failures are data, not noise.

- Local, gitignored, per-run detail (`.data/dogfood/`): the full `DogfoodRunRecord`, a
  `<task>-attempt<N>.patch.txt` of the raw git diff, and copies of the agent's changed files (used
  later for human-edit comparison). This is where raw stdout/stderr and other unsanitized detail
  may live — it never leaves the local machine.
- Frozen, committed baseline (`docs/baselines/v0.2-dogfood.{json,md}`): the sanitized
  `DogfoodReport` — no raw provider output, no auth payloads, no machine paths (see ADR 0009).
  Diffs are reduced to `stat` + `filesChanged`; failures keep only `kind` / `code` / `message`.

## Safety gates

- **Opt-in, fail-closed real execution.** `RUN_REAL_DOGFOOD=true` is required to run against real
  CLIs; without it (or in CI) the runner refuses. Real mode also requires `npm run doctor` to
  report every relevant provider as `ready`.
- **File allowlist enforcement.** Every task declares `allowedFiles`; a task whose diff touches
  any other path fails the run, regardless of whether its tests passed. `allowedFiles: []` (the
  planning task) requires an empty diff — no exceptions.
- **Failures are never deleted.** A failed run still writes its record with a `failure`
  (`kind`/`code`/`message`) — the freeze step requires ≥5 distinct task ids but does _not_ require
  every run to have passed.
- **CI never runs real CLIs.** The only dogfood coverage in CI is a mock-mode integration test
  against a tiny synthetic fixture repo, not this repo's real tasks.
