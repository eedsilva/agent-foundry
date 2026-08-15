# Architecture Decision Records

ADRs record decisions whose consequences outlive a pull request. Create one for changes to security boundaries, persistence, workflow contracts, provider strategy, public APIs, or package boundaries.

Status values: `Proposed`, `Accepted`, `Superseded`, `Rejected`.

Use [0000-template.md](0000-template.md). Do not rewrite history after acceptance; supersede it with a new ADR.

Latest accepted: [0066 a RESTRICTIVE policy drop is detected in security-lint, not in the migration gate](0066-restrictive-policy-drop-detected-in-security-lint.md) — closes the accepted negative of [0064](0064-destructive-migrations-classified-by-effect.md).

Proposed (Harness Alignment, milestone `Harness Alignment`):

- [0058 UI quality gate lives inside the browser-verification loop](0058-ui-quality-gate-in-browser-verification.md) — epic #469
- [0059 app-shape contract in the plan artifact](0059-app-shape-contract-in-plan-artifact.md) — epic #470
- [0060 schema-first plan artifact for the generated data model](0060-schema-first-plan-artifact.md) — epic #471

Proposed (builder's own UI):

- [0061 builder defaults to a simple two-pane view; execution detail moves behind an "Avançado" toggle](0061-builder-simple-by-default-advanced-toggle.md) — issue #489
- [0062 read-only workspace-file API for the builder's Files tab](0062-workspace-files-read-only-api.md) — issue #491, epic #488, ADR 0061
