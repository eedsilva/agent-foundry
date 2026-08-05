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
persistence. Two rules bound what "redacted" means, both amended after the first real preflight
run produced evidence that was empty rather than redacted:

- Personal paths keep the path and lose the account name (`/Users/[REDACTED]/dist/sidecar.js`),
  not the whole path. A gate failure is only actionable if the operator can see which file was
  missing. `redactPersonalPaths` in `@agent-foundry/domain` is the single definition; every
  evidence surface calls it.
- Preflight boundary messages are redacted as diagnostics, not as prompts. Instruction keywords
  (`build`, `create`, `list`, `app`) are ordinary English in an ops diagnostic, and matching on
  them published `[REDACTED_PROMPT]` for every real gate failure. Role markers (`system:`),
  addresses, database shapes, secrets, and personal paths are still redacted; free-form model
  text and model identity fields keep the stricter keyword rule.

Boundary causes carry the tail of a failing tool's stderr, falling back to stdout when stderr is
empty — pnpm reports a failing child script on stdout, and a stderr-only reading published
"No output." for every real build failure. The stream is redacted whole before it is cut to length:
slicing first can start mid-token and strip the prefix that identifies a key.
The preflight report is redacted by one shared function for all three of its boundaries — the
persisted file, the run-bound artifact, and the `POST /validation/campaign/preflight` response,
which no longer returns the operator's data directory.

Repeated publication of the same campaign/run/input is idempotent; a different
observation set receives a distinct immutable artifact revision. A run cannot be `accepted` unless
the terminal run and persisted project, plan approval, implementation, deterministic, preview,
browser, database, and terminal proofs are present. Missing or skipped mandatory evidence remains
non-accepted.

Terminal validation-campaign runs invoke the publisher from the orchestrator. The campaign-only
blocking verification adds `database-row-match`; the orchestrator turns its bounded fingerprint
into a run/step/attempt-bound `database.evidence` artifact and event. A preflight report is copied
to a run-bound artifact when the project is created. The public publish/readback routes remain
available for bounded browser/database observations captured after the run; outcome classification
uses persisted run, attempt, and run-bound preflight state rather than caller labels, and the
artifact store validates every referenced revision, digest, and available lineage.

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
