# ADR 0012: Approval gates as another idempotent, invalidation-driven node

- Status: Accepted
- Date: 2026-07-15
- Owners: Core and Persistence

## Context

Issue #13 (roadmap key `v03-approval-domain`) asks for a workflow node type that halts a run
until a persisted human decision, so a declarative workflow can require sign-off on an artifact
before continuing. The acceptance criteria require: workflow YAML support for an approval node
with a reviewed artifact, allowed actions, and a timeout policy; immutable `ApprovalRequest` and
`ApprovalDecision` records linked to a `StepRun`; approve advancing the run, reject ending it or
returning to a configured step, and request-changes producing a repair input; and idempotent
resume after a decision, including across a worker restart.

ADR 0010 and ADR 0011 already gave the orchestrator a full-replay execution model: every
`runProject` call walks the entire workflow from the first node, reusing already-completed
`StepRun`s by a deterministic idempotency key, and "redo step X" is implemented by marking old
`StepRun`s `invalidatedAt` rather than by persisting a resume cursor. ADR 0011 explicitly
rejected a persisted "next node index" because it duplicates state the walk can derive and
breaks silently when the workflow shape changes.

## Decision

Add `approval-gate` as a fourth `WorkflowNode` type (alongside `agent`, `verify`, and
`quality-loop`), distinct in name from `QualityLoopStep`'s unrelated `approval:
ArtifactCondition` field. An approval-gate node names the artifact to review, an
`outputArtifact` for the decision record, the allowed actions, what a reject without a return
step does (`onReject: 'end' | 'return-to-step'`), an optional `returnToStepId` and
`repairArtifact`, and a schema-only timeout policy (no enforcement yet — the required tests
only cover approve/reject/request-changes after a worker restart, not timeout auto-action).

Two new immutable, create-only contracts — `ApprovalRequest` and `ApprovalDecision` — are
persisted under `DATA_DIR/runs/<runId>/approvals/<requestId>/`. Neither repository port exposes
an `update` method; immutability is structural, not just documented convention. `StepRun.stepType`
gains `'approval-gate'`, and `WorkflowRunStatus`/`ProjectStatus` gain two values: `awaiting_approval`
(non-terminal, reached only from `running`) and `rejected` (terminal, reached from `running` or
`awaiting_approval`).

Reusing the existing replay model directly:

- **First encounter / still pending**: the orchestrator creates a `StepRun` and an
  `ApprovalRequest`, then throws a new `ApprovalRequiredError` — caught in `runProject`'s
  existing catch block exactly like `RunPausedError`, parking the run at `awaiting_approval`.
  Replaying with no decision yet throws the same error again: an idempotent halt, which is the
  "worker restarted before a decision arrived" required test.
- **Decision recorded, approve**: the `StepRun` completes and returns an artifact recording the
  decision, exactly like reusing any other completed step; the replay continues to the next
  node in the same pass. Reuse is keyed on the output artifact's idempotency key rather than on
  `StepAttempt`s (a gate has none) — the keyed artifact alone proves the gate already resolved.
- **Decision recorded, reject with `onReject: 'end'`**: the orchestrator throws a new
  `ApprovalRejectedError`, caught in `runProject` to transition the run to the terminal
  `rejected` status. No requeue is needed.
- **Reject with `return-to-step`, or request-changes**: `ProjectService.decideApproval` handles
  these entirely at decision time by invalidating every `StepRun` from the configured
  `returnToStepId` node through the gate node inclusive — reusing the same position-based
  downstream computation and checkpoint-rollback directive `retryStep` already uses (extracted
  into shared private helpers `downstreamOf` and `invalidateFromStep`). Because the gate's own
  `StepRun` is inside that invalidated range, the orchestrator never observes a `reject` or
  `request-changes` decision attached to a *live* `StepRun` — by construction, those two actions
  only ever reach the orchestrator indirectly, as "no non-invalidated StepRun for this node,"
  which is handled by the first-encounter branch above. For `request-changes`, the decision's
  note is also written as a plain artifact under the configured `repairArtifact` name — not
  wired into the repair step's `inputArtifacts` (which are strictly required at runtime), so a
  workflow author's repair step reads it as optional context, the same way steps already
  consult artifacts like `decision-log` without declaring them a hard dependency.
- **Every decision, in every branch**: `decideApproval` transitions the run
  `awaiting_approval -> queued` and enqueues a fresh job. It never decides what the action means
  for execution — only the orchestrator's next replay does, matching the existing split between
  control-plane requests (`ProjectService`) and execution (`WorkflowOrchestrator`).

`decideApproval` is idempotent on more than a simple repeat: if a decision already exists but the
run is still `awaiting_approval`, the original call recorded the decision and crashed before
requeuing — the retry completes the requeue using the *originally recorded* decision, not the
retry's input, rather than silently no-op'ing. Once the run has moved on, a repeat is a true
no-op. A second, independent crash-safety fix: the plain approve/reject-end path now explicitly
clears any retry directive a *prior* request-changes/reject-return cycle on the same run may have
left behind — otherwise a later replay could mistake an already-superseded step for a stale
retry target and re-execute it a third time, rolling the workspace back to an outdated
checkpoint. Both gaps were found by writing the approval-gate test suite, not anticipated
up front.

## Alternatives considered

Reusing the existing `paused`/`resumeRun` status and mechanism instead of a new
`awaiting_approval` status was rejected: `resumeRun` runs workflow/harness/workspace/artifact
drift diagnostics that model "did the world change while parked," which is the wrong question
for "a decision arrived, continue."

Making the orchestrator itself understand `reject-with-return` and `request-changes` — i.e.,
having `executeApprovalGate` invalidate steps and loop the `runProject` node walk backwards —
was rejected. `WorkflowOrchestrator` has no `JobQueue` and never re-enqueues; giving it one to
support an in-process rewind would blur the boundary ADR 0011 established between "control-plane
request" and "single-execution replay." Doing the invalidation in `ProjectService` at decision
time, and letting the ordinary next replay discover the consequences, needed no new boundary at
all.

Wiring `repairArtifact` into the repair step's `inputArtifacts` was rejected: the repair step
also executes on the very first pass, before any rejection ever happened, when the repair
artifact cannot exist yet — a required input would fail that first pass. Treating it as ordinary
optional context (readable, not required) sidesteps the temporal cycle entirely.

## Consequences

Approval gates cost one new `WorkflowNode` variant, two small immutable repositories, one new
orchestrator method, and two `ProjectService` methods — no changes to the core replay loop, and
the two shared helpers (`downstreamOf`, `invalidateFromStep`) reduce, rather than grow, the
duplication between step retry and approval decisions. `WorkflowRunStatus` and `ProjectStatus`
each grow by two values; `docs/adr/0010`'s and `0011`'s statement that "downstream ordering uses
workflow node order and assumes sequential execution" continues to hold and now also governs
approval rewinds. Timeout enforcement (auto-approve/auto-reject on expiry) is schema-only in this
change — a follow-up issue can add a reaper mirroring `queue-lease-reaper.ts` without touching
this contract.

## Validation and rollback

`packages/orchestrator/src/approval-gate.test.ts` covers: approve advancing to completion;
reject with `onReject: 'end'` terminating as `rejected`; reject-with-return-to-step and
request-changes rewinding the repair step and re-halting with a fresh request; a simulated
worker restart before any decision (no duplicate `ApprovalRequest`); and a simulated crash
between recording a decision and requeuing (recovers using the original decision, no duplicate
side effects). `packages/persistence/src/approval-repositories.test.ts` covers create/get (plus list
for requests) and duplicate-create rejection for both repositories. A manual HTTP smoke test against a mock
runtime exercised `POST /projects`, `GET /runs/:runId/approvals`, and
`POST /runs/:runId/approvals/:requestId/decide` for both approve and reject.

Rollback: stop workers first. Older code ignores the new optional `WorkflowRun`/`Project` status
values and the new `approvals/` directory tree, but any run currently `awaiting_approval` should
be cancelled before downgrading, since older code has no path to resume it.
