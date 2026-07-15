# ADR 0013: Dogfood v0.2 through the product pipeline with append-only run records

- Status: Accepted
- Date: 2026-07-15
- Owners: Core and Composition

<!--
Numbered 0013, not 0012: the concurrent SSE-timeline branch (issue #10) reserves
0012 for its own ADR. The two branches were authored in parallel, so this record
skips ahead one to avoid a merge collision. No 0012 exists on this branch.
-->

## Context

ADR 0009 gave the provider canary a versioned, sanitized report contract: it invokes each CLI directly against bounded scenarios, records the executed model, and freezes closed — any non-pass or unknown model blocks the baseline. That proves the three CLIs run and report a model on this host. It does not exercise the thing users actually depend on: the full `project -> run -> step -> attempt` pipeline with real workflows, routing, the quality loop, and the deterministic verifier. Issue #118 asked for the smaller, honest question — does the real loop produce useful diffs on real tasks, and what happens when it does not — recorded as evidence rather than a green wall.

## Decision

Dogfood runs execute **through the product pipeline**, not around it. `runDogfoodTask` seeds a workspace from a baseline ref, calls the same `projectService.create` + worker + declarative workflow (`dogfood-task-v1` / `dogfood-plan-v1`) a user would, and reads back the persisted route decision, usage, verification report, and diff. A task passes only when the run completes, the deterministic verifier approves, and the diff respects the task's file allowlist. This is deliberately heavier than the canary's direct-CLI style: the canary answers "can the CLI run?"; the dogfood answers "does our pipeline turn a prompt into an accepted change?".

Records are **append-only, failure-as-data**. Each attempt writes `<task>-attempt<NN>.json` plus verbatim changed-file copies, the raw patch, and the assembled prompt; reruns append a new attempt and never overwrite a prior one. A failed run is a first-class record carrying a sanitized `failure { kind, message }`, frozen alongside the passes. The v0.2 baseline includes a real failure -> root-cause fix -> rerun cycle: `web-merge-events` attempt 1 failed a whole-tree `git diff --check` seeded from baseline `*.patch` files, was fixed at the harness (`34da954`), and attempt 2 passed — both attempts are retained.

The **freeze gate differs from the canary's**. The canary fails closed on any non-passing run or unknown executed model. The dogfood freeze does _not_ block on failures: it requires only that at least five distinct tasks are present and that every failed record actually carries its failure (schema-enforced), then freezes passes and failures together into `docs/baselines/v0.2-dogfood.{json,md}`. Failures are the point, not a blocker. Freezing reuses the canary's sanitization boundary — records are built through strict schemas that admit no stdout, stderr, credentials, identities, or machine paths, so the committed JSON carries only whitelisted fields.

Human-edit annotation compares each agent output against the **merged, human-reviewed sibling branch** for its task, classifying every changed file as `same`, `modified`, `absent`, or `agent-only`. These classifications are the signal #118 wants, including the awkward ones: where a human simplified the merge or relocated code, the record honestly says `modified` or `agent-only`.

"**Quota**" here means tokens and estimated cost, per ADR 0009's usage fields and the standing rule that a subscription is not unlimited capacity — provider rate limits and policies still apply. Each record's `usage` carries input/output/cached tokens and, where the provider reports it, `estimatedCostUsd`; that is the cost side of the baseline, not a spend cap this runner enforces.

## Alternatives considered

Extending the canary contract to cover dogfooding was rejected: the canary's fail-closed freeze and direct-CLI shape are wrong for failure-as-data, and conflating "the CLI answered" with "our pipeline delivered" would blur two different guarantees. Overwriting a task's record on rerun was rejected because the failure -> fix -> rerun history is the evidence. Blocking the freeze on any failure was rejected because it would incentivize hiding failed attempts — the opposite of the exercise. Inferring the executed model from the requested alias was rejected for the same reason as ADR 0009; where a provider CLI reports no resolved model string (Codex), the record leaves top-level `executedModel` unset and the route's `executed.model.id` carries the truth.

## Consequences

The baseline reflects the real product path, so a regression in routing, the quality loop, or the verifier shows up here, not only in unit tests. Records are gitignored working evidence; the frozen `docs/baselines/v0.2-dogfood.{json,md}` pair is the committed, sanitized artifact. Because failures are retained and freezing tolerates them, the baseline is an honest snapshot of loop reliability at a point in time — not a benchmark. It feeds the pre-adaptive-routing baseline: the routing feedback loop can later be measured against these numbers. Plan tasks (`dogfood-plan-v1`) produce an empty code diff and have no merged code counterpart; their human-edit record is `recorded` with zero files and a note, not a per-file comparison.

## Validation and rollback

`packages/composition/src/dogfood.test.ts` covers the mock-mode pipeline run (append-only records, copied files, patch, prompt artifact), the baseline `*.patch` whitespace regression, second-attempt append, failure records with populated `failure`, git-failure sanitization, allowlist violations, the five-distinct-task freeze gate, the markdown fallback to `route.executed.model.id`, and human-edit `same`/`modified`/`absent` classification with notes. The v0.2 baseline was frozen from six real records (five tasks) against baseline ref `8896a3c`. Rollback: the frozen pair and this ADR are additive documentation; delete them to revert. The contracts (`DogfoodTask`, `DogfoodRunRecord`, `DogfoodReport`) are schema-version-1 and independent of the canary contract.
