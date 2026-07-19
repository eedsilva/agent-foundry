# ADR 0024: Attributable quality observations

- Status: Accepted
- Date: 2026-07-18
- Owners: Contracts, Orchestrator, Persistence, Model Router, and API

## Context

Execution success and a single quality-gate result are not enough to explain whether a model's output
was useful. The router needs comparable deterministic checks, blind review, human edits, and delayed
post-merge regressions without losing the evidence that produced a score.

## Decision

Store each outcome as an immutable `QualityObservation` in the append-only
`DATA_DIR/quality/observations.json` file. An observation records its source, exact producing artifact
revision and SHA, producer route identity, evaluator, blind flag, rubric, normalized score, bounded
evidence, and timestamp. Repeated observation ids are idempotent.

The router queries observations by model, task kind, role, taxonomy version, and category, then exposes
the raw records alongside independent component averages. Its optional aggregate uses only present
sources and these fixed weights: deterministic `0.50`, blind review `0.25`, human edit `0.15`, and
post-merge regression `0.10`. It supplements legacy quality metrics; it never replaces or rewrites the
source observations.

Verifier reports and reviewer outputs are captured by the orchestrator. Reviewer prompts omit producer
identity and route metadata while retaining the artifact content, revision, and SHA. Human-edit and
post-merge-regression observations enter through `POST /projects/:projectId/quality-observations`; the
request must identify the exact routed artifact revision and SHA. There is deliberately no aggregate
write endpoint.

## Security and privacy

Evidence is limited to a short summary and an optional artifact reference. The contract does not accept
raw CLI output, workspace paths, credentials, or arbitrary payloads. Blind-review prompts do not include
`createdBy`, producer model identity, route decisions, or actor metadata. Delayed sources enforce their
evaluator kinds (`human` for edits and `system` for regressions).

## Alternatives considered

Keeping only a single metric counter was rejected because it collapses deterministic, LLM, and human
signals. A separate database index was deferred: the initial file scan is small, lock-protected, and
transparent. Add a route-key index when observed routing volume makes the scan material, not in advance.

## Migration and rollback

This is additive and requires no backfill. Existing metrics remain readable and are used when no quality
observations are available. Rollback removes the new router, orchestrator, and API wiring; old runtimes
ignore the new file, which remains intact for a later re-enable. No persisted records need deletion or
rewrite.
