# HA-0.2 proof: a 4th scenario needs no code changes

Issue #474's acceptance criterion: "Running the tracer with a scenario file
requires no code edits; a 4th toy scenario proves it."

`examples/tracer/scenarios/` holds 4 scenario files:
`crud-heavy.json`, `dashboard-heavy.json`, `auth-heavy.json` (the 3 shapes
from #473/HA-0.1, migrated verbatim from their `prd.md` files) and `toy.json`
(new, added purely as a JSON file — `scripts/tracer.ts` and
`packages/composition/src/tracer.ts` were written once, before this file
existed, and were not touched to add it).

## Run log (mock mode, per the agent guidance — real-mode cost is out of scope for this proof)

Command:

```
npx tsx scripts/tracer.ts --scenario toy --executor-mode mock
```

Output (2026-08-11T01:16:07Z):

```
toy: project 01KZQ683Q0HMKQ9ZPS6JTA6MGW, run 01KZQ683Q1H1FJ7NKTCTT3K5C7 → awaiting_approval
```

The run reached `awaiting_approval` — the workflow accepted `toy.json`'s
`prompt` as the project PRD and `workflowId` ("web-app-v1") exactly as it
does for the 3 real shapes, through the same `runTracerScenario` call, with
no branching on scenario identity anywhere in the runner.

## Expected-capability checklist (human-checked, per scenario file)

`toy.json`'s `expectedCapabilities`:

- Clicking Increment updates the displayed count.
- The count survives a page reload.

This scenario stopped at the plan-approval gate (mock executor mode
short-circuits before a build step), so these are not yet checkable against a
running app — that's expected for a mock-mode proof run. A real-mode run
would carry the tracer through to a build, at which point these become the
manual-review checklist for that run's evidence doc, matching how the 3
HA-0.1 shapes' `## Acceptance sketch` bullets were used in
`docs/evidence/harness-alignment/defect-list.md`.
