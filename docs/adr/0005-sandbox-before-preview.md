# ADR 0005: Require a sandbox boundary before exposed preview execution

- Status: Accepted
- Date: 2026-07-11
- Owners: Safety

## Context

Generated dependencies, build scripts, tests, and preview servers are executable code. Running them on the control host exposes credentials, filesystem, network, and process capabilities.

## Decision

Personal real execution remains loopback and trusted-only. Any preview offered beyond that profile requires an ephemeral rootless sandbox with host credential isolation, resource limits, deny-by-default egress, and external artifact collection.

## Alternatives considered

Relying solely on provider CLI sandbox flags does not constrain verifier or generated application processes. A normal container improves packaging but is not automatically a sufficient hostile-code boundary.

## Consequences

Live Preview depends on Safe Runtime Foundation. This deliberately slows visible UX to avoid baking an unsafe execution model into the product.

## Validation and rollback

Adversarial canaries attempt host-file, socket, network, PID, and resource escape. Failure blocks the preview release.
