# ADR 0014: ProjectPolicy as hard constraints enforced outside the prompt

- Status: Accepted
- Date: 2026-07-15
- Owners: Core and Orchestrator

## Context

Important restrictions — which model providers may run, which stack a workflow must target, which dependencies generated code may declare, which verification commands may execute — lived only in prompts and conventions. A prompt is advisory: an agent can ignore it, and nothing audits the violation. Issue #15 requires hard policies validated before and after execution, versioned, and pinned to each run so a policy edit cannot silently change the rules of an in-flight run.

## Decision

Model a `ProjectPolicy` contract (`schemaVersion`, `id`, `version`, `requiredStack?`, `allowedProviders?`, `forbiddenDependencies`, `allowedCommands?`) stored as YAML files in `policies/<id>.yaml`, loaded by a `YamlPolicyRepository` (same pattern as workflows). Each project selects a policy at creation via `CreateProjectRequest.policyId` (default `default`; a permissive `policies/default.yaml` ships with the repo).

Enforcement points:

- **Run start (before execution):** the orchestrator resolves the project's policy, stamps `{id, version, hash}` on the `WorkflowRun` (sha256 of the stable-stringified policy, same helper family as `workflowHash`), and fails the run with a `policy.violation` event when `requiredStack` mismatches the workflow's `stack`.
- **Routing (before execution):** the policy's `allowedProviders` ride inside `TaskProfile.policy`; the router rejects forbidden candidates with the reason `provider <p> is forbidden by policy <id>@v<n>`, recorded in `RouteDecision.rejected` and persisted with every attempt.
- **Verification (after execution):** the verifier refuses to run scripts outside `allowedCommands` (a failing `policy` command result, script never executed) and fails the report when `package.json` declares a package in `forbiddenDependencies` (`policy-dependency-check`).
- **Mid-run change:** at every step boundary the orchestrator re-resolves the policy and compares its hash against the run's pinned record; a mismatch emits `policy.violation` and fails the run. Retrying the project — which always creates a fresh run — is the explicit fork that adopts the new policy. Pause snapshots capture `policyHash`, and resume is blocked with a `policyVersion` diagnostic on drift, reusing the `ResumeBlockedError` machinery.

## Alternatives considered

- **Policy inside the workflow definition:** rejected — a policy governs a project across workflows and must be able to change on its own versioning cadence; coupling it to the workflow hash would conflate two change vectors.
- **Per-project policy documents stored in project state:** rejected for v1 — duplicating policy content per project loses the single point of revision; file-per-id with `policyId` selection gives per-project choice without new storage.
- **Prompt-level instructions only:** rejected — the entire point is constraints a model cannot talk its way out of.
- **Confirmation API to accept a mid-run policy change:** deferred — project retry (fork) already exists, is idempotent, and preserves the audit trail; an accept-in-place endpoint can be added if forking proves too blunt.

## Consequences

- Positive: violations are auditable (`policy.violation` events, router rejections, verifier command results) and runs are pinned to exact policy content, not just a version number.
- Negative: the policy file is re-read at every step boundary (one small YAML read per step; cache if it ever matters). Dependency checking is exact-name over `package.json` manifests only — transitive/lockfile scanning is a known ceiling, marked in code.
- Migration: none. All new persisted fields (`Project.policyId`, `WorkflowRun.policy`, `RunPauseSnapshot.policyHash`) are optional; entities written before this ADR parse unchanged, and legacy projects resolve to the `default` policy.
- Security: policies are local YAML under repo control; no new permissions, network, or secret surface.

## Validation and rollback

Validated by unit suites in contracts, model-router, executors, persistence, and orchestrator (provider block, forbidden package, disallowed command, hash stamping, mid-run change block + fork, resume block) plus the full `npm run check` gate.

Rollback: revert the change. Runs written with a `policy` field would fail strict parsing under pre-ADR schemas, so a rollback that must read existing data should revert code but keep the schema's optional `policy`/`policyId`/`policyHash` fields (they are additive and harmless); alternatively strip those fields from `.data` run files. New runs never depend on a policy file existing beyond `policies/default.yaml`.
