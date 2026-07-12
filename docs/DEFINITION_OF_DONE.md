# Definition of Done

A change is done only when all applicable items below are satisfied.

## Behavior

- Acceptance criteria are demonstrated, not merely asserted.
- Deterministic checks pass.
- Failure states, cancellation, retry, and rollback are tested when affected.
- The result does not depend on undocumented local state.

## Engineering

- Typecheck, lint, formatting, architecture, tests, and build pass.
- Tests cover the failure mode or contract introduced by the change.
- Public schemas, artifacts, workflows, and APIs remain compatible or include a migration.
- Logs and events are sufficient to diagnose a failure without reproducing it blindly.

## Safety and operations

- Filesystem, process, network, secret, provider, and data exposure were evaluated.
- New permissions are minimal and explicit.
- Rollback or containment is documented.
- Sensitive data is not placed in logs, screenshots, fixtures, artifacts, or issue bodies.

## Delivery evidence

- The pull request links the issue.
- The issue contains relevant evidence: test output, screenshot, trace, benchmark, release note, or decision record.
- User-facing and operator documentation is updated.
- An ADR exists for a durable architectural decision.
