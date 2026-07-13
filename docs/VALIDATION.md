# Validation record

Validation date: 2026-07-11.

This repository was validated from a clean dependency installation using the public npm registry.

## Completed checks

- `npm ci` completed from `package-lock.json`.
- `npm run typecheck` passed.
- `npm test` passed with 8 test files and 27 tests.
- All TypeScript packages, API and worker production builds passed.
- The Next.js production build passed when run directly for the web workspace.
- `npm run doctor` passed in mock mode.
- An HTTP smoke test created a project, ran the complete workflow and finished with:
  - project status `completed`;
  - 57 events;
  - 17 current artifacts;
  - all required planning, architecture, implementation, review, verification and decision-log artifacts;
  - valid `selected`, `attemptedModelIds` and `executed` route audit fields.

## Boundaries of this validation

The Codex, Claude Code and AGY executors were not invoked against live authenticated provider sessions in the validation environment. Their argument construction is covered by contract tests, while real-provider behavior still requires a canary run on the host where the CLIs are installed and authenticated.

The final attempt to query npm's remote audit endpoint failed because DNS resolution for the registry was temporarily unavailable. Run `npm audit` in your own environment before a production deployment.

Docker Compose configuration is included, but Docker was not installed in the validation environment, so the image itself was not built here.

## Personal Builder v1 roadmap alignment — 2026-07-13

The approved Personal Builder contract was encoded in repository documentation, `planning/roadmap-spec.json`, rendered planning output and live GitHub issues.

### Structural evidence

- Roadmap validation reports 16 milestones, 114 tasks and 131 managed issues.
- Twelve normative Personal v1 requirement groups map to milestones, task keys and Issue Radar release evidence.
- Validation rejects missing task references, empty evidence and milestones outside the transitive Personal v1 path.
- Personal v1 depends on Conversational Builder, Local Full-stack App Platform, Self-hosted Publish and Safe Runtime Foundation.
- Existing Repositories, Linux, browser code editing and Windows are explicitly post-v1.
- Live reconciliation reused 125 managed issues and created six: #138–#143.
- Live checks confirmed new sub-issue parents and the v1 blockers: v0.6, v0.10, v0.11 and v0.4.5.

### Verification performed

`npm run check` completed successfully after the final documentation and roadmap changes:

- Prettier format check passed.
- ESLint passed with zero warnings.
- Architecture validation found 11 workspaces with no forbidden edges or cycles.
- Roadmap and GitHub configuration validation passed.
- TypeScript project build passed.
- Vitest passed 9 files and 42 tests.
- Node script tests passed 23 tests, including the new Personal v1 traceability negative cases.
- All packages, API, worker and Next.js production application built successfully.
- `git diff --check` passed.

### Confidence statement

Planning coverage is above the requested 95% threshold because every normative capability group has structural issue coverage and named release evidence; the current structural coverage is 12/12. This is not a guarantee of implementation success. Delivery confidence must be earned incrementally by closing issues with the required evidence and finally passing the complete Issue Radar journey on clean macOS and Ubuntu LTS environments.
