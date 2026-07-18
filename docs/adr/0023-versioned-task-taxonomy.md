# ADR 0023: Versioned hierarchical task taxonomy

- Status: Accepted
- Date: 2026-07-18
- Owners: Contracts, Orchestrator, Persistence, Model Router, and Web

## Context

`TaskKind` is the stable v1 workflow, routing, metrics, and execution-plane key, but its eight values
cannot distinguish domains such as frontend, database, or tests. Replacing it would break persisted
workflows, route decisions, metrics, and the execution request protocol.

## Decision

Keep `TaskKind` unchanged as the compatibility key and execution-plane field. Taxonomy v2 adds a
versioned category path and extracted feature list to `TaskProfile`. Workflow-declared categories win;
when omitted, the profiler deterministically classifies the existing task kind from instructions,
harness text, artifact content, and harness tags. Classification does not change the task kind sent to
executors.

Metrics written with taxonomy v2 use `modelId::v2::category::role`. Reads prefer that exact category
and fall back to the retained v1 `modelId::taskKind::role` key. Legacy profile and metric records are
normalized to taxonomy v1 when parsed; the next metrics write serializes the normalized legacy records
alongside new data. No backfill or destructive migration is required.

The route dashboard groups decisions by the first category level while preserving the full category,
taxonomy version, extracted features, model scores, and fallback evidence on each card.

## Compatibility and security

Old workflows that only declare `taskKind` continue to parse. `TaskKind` and
`AgentExecutionRequest.taskKind` remain unchanged. Taxonomy fields are additive, and v1 metric keys are
retained.

The taxonomy changes labels, routing-metric partitions, and dashboard presentation only. It grants no
permissions and changes no secret handling, filesystem reach, process execution, or network behavior.
Classification reads only context already available to the profiler and persists enum values, not the
source text that matched them.

## Alternatives considered

Replacing or expanding `TaskKind` was rejected because it would turn a routing refinement into a wire
and persistence migration. Using only v2 metric keys was rejected because it would discard existing
routing evidence during adoption.

## Migration and rollback

Deploy the code without a data migration. New profiles and metric writes use taxonomy v2; legacy
records remain readable and provide fallback evidence until exact category history accumulates.

Rollback is a code revert. Retained v1 keys remain authoritative for old runtimes, which ignore v2
metric keys and additive profile fields. No stored record must be deleted or rewritten before rollback.
