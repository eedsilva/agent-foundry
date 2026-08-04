# ADR 0055: Publish redacted validation evidence bundles

- Status: Accepted
- Date: 2026-08-04
- Owners: Core, Orchestrator, Persistence
- Amends issue #395 and parent #390

## Context

The real TODO campaign persisted run-scoped attempts, artifacts, preflight state, and terminal
events, but had no bounded durable record that joined those facts into one reviewable result.
Publishing arbitrary provider output would expose secrets, personal paths, prompts, and generated
application data. Treating a caller's gate labels as proof would also allow a false `accepted`
result.

## Decision

The campaign publishes a versioned `validation-evidence-<campaign>` artifact for each run. The
bundle contains only bounded summaries, model identities, usage classes, checkpoint and immutable
run/step/attempt/artifact references, terminal state, skipped gates, and the four-way outcome.
Provider-reported cost, catalog estimates, metered unknowns, and subscription quota remain
separate fields.

The publisher redacts summaries, errors, preflight model fields, and personal paths before
persistence. Repeated publication of the same campaign/run/input is idempotent; a different
observation set receives a distinct immutable artifact revision. A run cannot be `accepted` unless
the terminal run and persisted project, plan approval, implementation, deterministic, preview,
browser, database, and terminal proofs are present. Missing or skipped mandatory evidence remains
non-accepted.

Terminal validation-campaign runs invoke the publisher from the orchestrator. The public
publish/readback routes remain available for bounded browser/database observations that are
captured after the run; the artifact store validates every referenced revision and digest.

## Alternatives considered

- Trusting caller-provided gate statuses was rejected because it could produce accepted evidence
  without durable proof.
- Persisting raw provider/browser/database payloads was rejected because the bundle is a review
  artifact, not an unbounded log or data export.
- Overwriting one campaign artifact was rejected because prior run evidence must remain immutable.

## Consequences

Evidence is directly reviewable and safe to retain under the existing artifact policies. A missing
database or browser proof is visible as unavailable/product-failed rather than silently accepted.
The bundle schema is additive and run-scoped; no existing run or artifact is rewritten.

## Validation and rollback

Contract, publisher, public API, fast unit, and runtime integration tests cover all four outcomes,
redaction, proof validation, readback isolation, and idempotent replay. To contain or roll back the
feature, stop API and worker, preserve `DATA_DIR` for audit, deploy the prior binary, and remove
`VALIDATION_CAMPAIGN` before restarting. Existing evidence artifacts remain readable by the prior
binary as ordinary artifacts; do not delete them during rollback.
