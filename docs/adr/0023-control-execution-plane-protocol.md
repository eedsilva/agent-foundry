# ADR 0023: Control/execution plane protocol

- Status: Accepted
- Date: 2026-07-18
- Owners: Orchestrator and Executors

## Context

`WorkflowOrchestrator` called `ExecutorRegistry.get(provider).execute(...)` directly: the CLI subprocess
that mutates a project workspace ran in the same process, on the same host, as the control plane that
decides workflow state, routing, and policy. There was no seam at which a request to run an agent could
be handed to something other than an in-process `AgentExecutor` — no shape a remote runner could accept,
no boundary a sandbox or container backend could sit behind. Issue #45 (roadmap task
`v07-control-execution-plane`, part of the `v0.7 - Secure Execution` milestone) asks for that seam: a
versioned protocol and a port the orchestrator submits work through, so a real sandboxed/remote runner can
later replace the in-process executor without changing orchestrator code. This task only defines and wires
that boundary — it does not build sandboxing, a container backend, network policy enforcement, or a secret
broker. Those are separate, dependent roadmap tasks (`v07-sandbox-runner`, `v07-container-backend`,
`v07-network-policy`, `v07-secret-broker`) that this ADR explicitly does not claim to deliver.

## Decision

Add an `ExecutionRequest`/`ExecutionResult` protocol in `packages/contracts/src/execution-plane.ts`,
carried under `EXECUTION_PROTOCOL_VERSION = '1'` (a `z.literal` on both schemas, so a version mismatch
fails Zod parsing rather than silently misinterpreting fields):

- `ExecutionRequest`: `protocolVersion`, `executionId`, `agent` (the existing `AgentExecutionRequest`
  shape minus `cwd` — see below), `workspace` (`{ projectId, ref }`), `tools` (string array, default
  `[]`), `limits` (`{ timeoutMs }`), `networkPolicy` (`{ mode: 'none' | 'allowlist', allowedHosts }`),
  `secrets` (array of `{ name, ref }`, default `[]`).
- `ExecutionResult`: `protocolVersion`, `executionId`, `state` (`'completed' | 'failed' | 'cancelled'`),
  optional `agent` (the existing `AgentExecutionResult`, required by a `.refine` when `state ===
'completed'`), optional `error` (`{ message, exitCode?, stdout?, stderr? }`, required by a `.refine`
  when `state === 'failed'`).

Field choices, and why:

- **`workspace` is a snapshot (`projectId` + `ref`), not `cwd`.** `AgentExecutionRequest.cwd` is an
  absolute local filesystem path — meaningless (and a local-path leak) once the executor is not
  guaranteed to share a filesystem with the control plane. `ExecutionAgentRequestSchema` is
  `AgentExecutionRequestSchema.omit({ cwd: true })` for exactly this reason. `ref` is a Git ref the
  workflow orchestrator resolves per attempt (the step's checkpoint, else `workspaces.head()`, else the
  `runId` as a last resort — see `executeCandidate` in `workflow-orchestrator.ts`), so a remote runner
  can in principle check out the exact commit it should run against instead of trusting a live shared
  path. `LocalExecutionPlane` does not need that: it shares the control plane's filesystem, so it
  resolves `cwd` itself from `workspace.projectId` via `WorkspaceManager.workspacePath` and ignores `ref`
  entirely. `ExecutionResult` mirrors this: no local paths come back either, only the structured
  `AgentExecutionResult` (or `error.stdout`/`error.stderr` text) — a network transport doesn't leak
  filesystem shape in either direction.
- **`tools`, `networkPolicy`, `secrets` are shape-only placeholders.** They are threaded through the
  protocol and populated by the orchestrator on every submit (`tools: []`, `networkPolicy: { mode:
'none', allowedHosts: [] }`, `secrets: []`), but nothing in this change enforces them — no allowlist
  check, no egress control, no broker lookup. They exist now so the wire shape doesn't change again when
  `v07-network-policy` and `v07-secret-broker` land; enforcing them is explicitly out of scope here.
- **`state` is a three-value machine (`completed | failed | cancelled`), not a boolean.** `submit` always
  _resolves_ — a failed or cancelled run is a normal response, not a rejection — so callers branch on
  `state` instead of catching. Only a genuine transport failure (the call itself never completing) should
  reject the promise. The two `.refine`s make the completed/failed payload requirements structural
  instead of a runtime `if` the caller could get wrong.

Add the `ExecutionPlane` port to `packages/domain/src/ports.ts`:

```ts
export interface ExecutionPlane {
  submit(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
  cancel(executionId: string): Promise<void>;
  status(executionId: string): Promise<ExecutionStatus>;
}
```

`submit` is the only method `LocalExecutionPlane` needs today; `cancel`/`status` are the explicit,
out-of-band remote-observability surface a real remote implementation needs (reconciling state after a
control-plane restart, cancelling work the control plane no longer holds a live `AbortSignal` for). A real
remote implementation is expected to also wire the `AbortSignal` passed to `submit` into its own
transport-level cancel, so callers keep the same call-and-await shape they use today.

Add `LocalExecutionPlane` in `packages/executors/src/local-execution-plane.ts` as the **sole**
implementation of the port. It runs agent CLIs in-process — the same trusted, local-development execution
that existed before this change, just reached through the new port instead of a direct
`ExecutorRegistry.get(...).execute(...)` call:

- `submit` resolves `cwd` from `workspace.projectId` via `WorkspaceManager.workspacePath`, delegates to
  the existing `AgentExecutor`, and maps the outcome to `ExecutionResult`: success → `state: 'completed'`
  with the `agent` result; `RunCancelledError` → `state: 'cancelled'`; any other thrown error → `state:
'failed'` with `error` built from `ExecutionError.details` when available. An `EmergencyCeilingError`
  is re-thrown rather than mapped, because it is an orchestrator-level circuit breaker the orchestrator's
  existing `instanceof EmergencyCeilingError` handling must still see as a rejection, exactly as it did
  via the aborted signal's `reason` before this change.
- `cancel` and `status` both throw: local execution is synchronous under the caller's own `AbortSignal`,
  so there is nothing to cancel or observe out-of-band. They become load-bearing only once a real remote
  `ExecutionPlane` exists.

`WorkflowOrchestrator` (`packages/orchestrator/src/workflow-orchestrator.ts`) now takes an
`ExecutionPlane` constructor argument in place of the `ExecutorRegistry` it used to call directly, and
`executeCandidate` calls `this.executionPlane.submit(...)` instead of
`this.executors.get(candidate.model.provider).execute(...)`. `packages/composition/src/runtime.ts` still
builds an `ExecutorRegistry` (`StaticExecutorRegistry` or `MockExecutorRegistry`, selected by
`config.executorMode`, unchanged from before) but now wraps it in `new LocalExecutionPlane(executors,
workspaces)` and hands that to `WorkflowOrchestrator` instead of the registry itself.

## Alternatives considered

- **Extend `AgentExecutionRequest`/`AgentExecutionResult` in place** (add `tools`/`networkPolicy`/`secrets`
  fields directly to the existing CLI-facing shapes): rejected. `AgentExecutionRequest` is the
  CLI-specific compiled-prompt shape (`prompt`, `cwd`, `outputSchema`); the execution plane needs a
  transport envelope around it (`executionId`, `workspace` snapshot, protocol version) that a CLI request
  itself has no reason to know about. Conflating the two would make it impossible to version the
  transport independently of the CLI request shape, and would leak `cwd` (a local path) into whatever
  wire format a remote runner uses.
- **Build the real sandboxed/remote runner now**: rejected as out of scope for this task. The roadmap
  tracks that work as separate, dependent tasks (`v07-sandbox-runner`, `v07-container-backend`,
  `v07-network-policy`, `v07-secret-broker`) that need this protocol boundary to exist first. Building
  them here would have coupled an unrelated, much larger change to this one and delayed the boundary
  itself.

## Consequences

- No behavior change for existing runs: `LocalExecutionPlane` performs the same in-process CLI execution
  `WorkflowOrchestrator` already did through `ExecutorRegistry`, just reached through one more layer of
  indirection.
- `cancel`/`status` are unused (indeed, they throw) on `LocalExecutionPlane` today. They become load-bearing
  the moment a remote `ExecutionPlane` implementation exists; until then they are dead code paths, by
  design — a caller that reaches them is a bug now (nothing calls them), not a missing feature.
- `tools`, `networkPolicy`, and `secrets` are validated shapes with no enforcement behind them yet. A
  workflow step cannot actually be restricted to a tool allowlist, a network policy, or a scoped secret
  today — the fields exist so wiring them up later (`v07-sandbox-runner`, `v07-network-policy`,
  `v07-secret-broker`) is additive to the protocol rather than another breaking version bump.
- The trust boundary is unchanged: `LocalExecutionPlane` still runs CLIs in the control plane's own
  process with the host user's permissions. This ADR introduces the seam a sandboxed/remote runner will
  eventually sit behind; it does not itself introduce any isolation. See `docs/SECURITY.md`.

## Validation and rollback

Validated by unit suites added across the four prior tasks in this plan: `packages/contracts`
(`ExecutionRequestSchema`/`ExecutionResultSchema` parsing, including the two `.refine` branches and the
`protocolVersion` literal), `packages/executors` (`LocalExecutionPlane` success/failure/cancelled mapping,
`EmergencyCeilingError` re-throw, `cancel`/`status` throwing), and `packages/orchestrator`
(`executeCandidate` submitting through `ExecutionPlane` and branching on `ExecutionResult.state`) — plus
the full `npm run check` gate.

Rollback: revert the change. `ExecutionRequest`/`ExecutionResult` are transient values passed to `submit`
and returned from it; neither is persisted to `DATA_DIR`, so there is no data migration to undo. Reverting
restores direct `ExecutorRegistry` calls from the orchestrator with no stored state left behind.
