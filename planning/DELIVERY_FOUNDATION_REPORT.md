# Delivery Foundation migration report

Generated on 2026-07-11 for `eedsilva/agent-foundry`.

## Status

**Applied.** The migration was applied to GitHub on 2026-07-12; `planning/github-state.json` (`appliedAt`) records the reconciliation of all 129 managed issues, including the 28 new ones. The rest of this report is the point-in-time migration record from generation on 2026-07-11.

The public repository baseline used for the migration is commit:

```text
92b071ceb3365cb74d954cc67c496e3e5ecc9e6a
```

At inspection time, the published backlog had 101 issues. `planning/github-state.json` records the managed issue numbers and body hashes needed for safe reconciliation.

## What changes

### Product and roadmap

- Splits `Personal Builder v1` from `Hosted Platform v2`.
- Moves multi-tenancy, collaboration, credits, and billing out of the Personal v1 critical path.
- Introduces `Delivery Foundation` before feature delivery.
- Introduces `v0.4.5 - Safe Runtime Foundation` before live preview.
- Replaces the single linear milestone chain with an explicit dependency DAG.
- Keeps Adaptive Routing as a parallel, evidence-driven research track.
- Removes the legacy top-level `agent-foundry-roadmap/` bootstrap package so the repository has one roadmap source and one reconciler.
- Reduces P0 inflation and validates that future/experimental work cannot be P0.

### Managed backlog after reconciliation

| Measure                 | Value |
| ----------------------- | ----: |
| Labels                  |    43 |
| Milestones              |    15 |
| Root roadmaps           |     1 |
| Epics                   |    15 |
| Tasks                   |   113 |
| Managed issues total    |   129 |
| Existing managed issues |   101 |
| New managed issues      |    28 |
| Retired managed issues  |     0 |
| P0 tasks                |    22 |

### GitHub Project

The governance spec declares one user-owned Project named `Agent Foundry Delivery` with:

- 9 fields: Status, Commitment, Size, Risk, Confidence, Track, Target, Priority, and Evidence;
- 9 views: Now, Next, Roadmap, Blocked, High Risk, Epics, Personal v1, Hosted v2, and Research;
- a WIP limit of 2 for `In Progress`;
- reconciliation that preserves operational values edited by humans.

Built-in Project workflows are intentionally documented for one-time configuration in the UI because the public API does not expose every workflow setting with a stable mutation surface.

### Repository governance

- Issue Forms for bugs, features, architecture, and risks.
- Pull request template focused on evidence, security, migration, and rollback.
- CONTRIBUTING, Product Contract, DoR, DoD, deployment profiles, and a live risk register.
- Six initial ADRs plus a reusable template.
- Independent CI checks for format, lint, architecture, roadmap, typecheck, tests, and build.
- Dependency Review and scheduled security audit workflows.
- Dependabot and release-note category configuration.
- Main ruleset generated in `disabled` state and activated only after the new checks have completed on GitHub.
- Baseline `v0.1.0` release generated only with an explicit publish flag and an exact commit SHA.

### Runtime safety guardrail

Real CLI execution now refuses to bind the API to a non-loopback address unless `ALLOW_UNSAFE_REMOTE_REAL_EXECUTION=true` is set explicitly. Mock Docker execution remains available on `0.0.0.0`.

This is a guardrail, not a sandbox. Public or untrusted use still requires the Safe Runtime milestone.

## Validation performed

The following checks passed in the prepared tree:

```text
Prettier format check
ESLint with zero warnings
Architecture graph: 11 workspaces, no forbidden edges or cycles
Roadmap validation: 15 milestones, 113 tasks, 129 managed issues
GitHub config validation: 4 issue forms, 3 workflows, 9 check contexts
TypeScript project build
Vitest: 9 files, 42 tests
Node script tests: 21 tests
Package builds
API build
Worker build
Next.js production build
npm audit --omit=dev: 0 vulnerabilities
npm audit: 0 vulnerabilities
git diff --check
```

The check-context count above is the number of job contexts defined across the CI workflows at generation time; the ruleset intentionally requires only 8 of them (scheduled security-audit jobs are not required checks).

Dry-run results:

```text
Roadmap: 101 known, 28 new, 0 retired
Project: 9 fields, 9 views, 129 items
Ruleset: 8 required checks, disabled until explicit activation
Release: not published without explicit flag
```

## Apply sequence

From a clean checkout of the public baseline:

```bash
npm ci
npm run check
npm run github:roadmap:dry-run
npm run github:governance:dry-run
```

After reviewing the dry-run:

```bash
npm run github:roadmap:apply
npm run github:governance:apply
```

Commit and push the repository changes. Wait for every new CI context to complete successfully. Then:

```bash
npm run github:governance:activate-ruleset
npm run github:release:publish-baseline
```

Finish the one-time Project workflow setup described in `planning/PROJECT_AUTOMATIONS.md`.

## Token and permission notes

- The roadmap reconciliation requires repository issue write access.
- Repository settings, security toggles, and rulesets require administration access.
- A user-owned GitHub Project requires token permissions compatible with the user Project APIs. The script verifies the authenticated login before creating or changing the Project.
- The scripts are dry-run by default and stop on unmanaged body drift unless an explicit override is supplied.
