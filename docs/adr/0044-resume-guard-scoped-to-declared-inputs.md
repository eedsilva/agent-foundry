# ADR 0044: the resume guard checks the resuming node's declared inputs, not every artifact

- Status: Accepted
- Date: 2026-07-27
- Owners: Core
- Amends: ADR 0011's resume compatibility check, artifact clause only

## Context

ADR 0011 has resume re-validate "the latest hash of every artifact" against the pause snapshot. In practice sibling services keep writing while a run is paused — the preview service records boot failures, and #346 will add more writers — so any such write read as drift and blocked resume permanently, with restarting the project the only escape (#319, run `01KYCH4FJFZ5HDJTNX986B6P9Q`). A guard that fires on noise teaches the operator to distrust it, and per-task execution (#313) makes pauses frequent rather than rare.

## Decision

`resumeDiagnostics` compares only the artifacts the resuming node declares as inputs: `inputArtifacts` for agent steps, `browserTestPlanArtifact` for verify steps, the gated `artifact` for approval gates, and the union of those plus `approval.artifact` for quality loops. When the snapshot carries no `resumeNodeId` (a pause acked before the graph walk), any node may execute next, so the guard falls back to the union of every node's declared inputs. Workflow hash, harness version, policy hash, and workspace HEAD drift block exactly as before, and a blocked field is still named in the diagnostic. The pause snapshot format is unchanged — it still records every artifact hash; only the comparison narrowed, so no persisted state migrates and previously wedged runs resume on their next attempt.

## Consequences

A blocked resume now means an input to the remaining work actually changed. An artifact a node reads without declaring it is no longer guarded — declaring inputs is already what routes artifacts into the executor, so an undeclared read is a workflow bug, not a resume concern.
