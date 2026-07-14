# Validation record

Latest validation date: 2026-07-14.

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

Real-provider coverage is a one-run canary matrix, not a reliability or quality benchmark. It proves the three authenticated CLIs can execute the bounded scenarios and report a known model on this host at the recorded versions. It does not prove performance under concurrency, long-running repositories, provider outages, quota exhaustion or future CLI versions.

The final attempt to query npm's remote audit endpoint failed because DNS resolution for the registry was temporarily unavailable. Run `npm audit` in your own environment before a production deployment.

Docker Compose configuration is included, but Docker was not installed in the validation environment, so the image itself was not built here.

## Real provider canary baseline — 2026-07-14

The versioned v0.2 baseline invoked Codex, Claude Code and AGY independently for planning, greenfield implementation and repository repair. All nine runs passed. Planning produced no diff; every mutation scenario passed `node --test`, `git diff --check` and its exact file allowlist.

| Provider | CLI     | Selected model         | Executed model         | Scenarios  |
| -------- | ------- | ---------------------- | ---------------------- | ---------- |
| Codex    | 0.144.1 | `gpt-5.6-sol`          | `gpt-5.6-sol`          | 3/3 passed |
| Claude   | 2.1.208 | `sonnet`               | `claude-sonnet-5`      | 3/3 passed |
| AGY      | 1.1.2   | `Gemini 3.1 Pro (Low)` | `Gemini 3.1 Pro (Low)` | 3/3 passed |

Evidence:

- [`docs/baselines/v0.2-provider-canaries.json`](baselines/v0.2-provider-canaries.json) is the machine-readable source of truth.
- [`docs/baselines/v0.2-provider-canaries.md`](baselines/v0.2-provider-canaries.md) records versions, durations, usage where reported, aliases and limitations.
- Frozen evidence excludes raw provider output, authentication payloads, identities, credentials, session identifiers and machine-specific temporary paths.
- AGY is invoked with `--new-project` so each temporary repository is isolated from its cached project selection.

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

## Persisted workflow run domain — 2026-07-14

Issue #4 was validated from the isolated `agent/issue-4-workflow-run-domain` worktree after a clean `npm ci`. The final implementation persists independently versioned workflow runs, step runs, and attempts; exercises v0.1 project/job reads; and verifies successful, fallback, verifier, and coordinated-failure paths in the mock runtime.

Each required command was run separately against the final implementation:

- `npm run format:check` passed.
- `npm run lint` passed with zero warnings.
- `npm run architecture:check` passed for 11 workspaces and both architecture tests.
- `npm run roadmap:check` passed for 16 milestones, 114 tasks, 131 managed issues, eight roadmap/governance tests, GitHub configuration, and rendered-roadmap synchronization.
- `npm run typecheck` passed.
- `npm test` passed 16 Vitest files with 149 tests and 42 Node script tests.
- `npm run build` passed all eight packages, the API, the worker, and the Next.js production build.
- `git diff --check` passed.

Focused run-domain coverage includes seven contract tests, seven state-transition tests, six filesystem persistence/concurrency tests, and four mock-runtime integration tests. These verify timestamp and terminal-error invariants, every illegal state transition, compare-and-swap conflicts, legacy reads, attempt metadata/artifact linkage, fallback ordering, nested request context, and closure of the attempt/step/run hierarchy on failure.
