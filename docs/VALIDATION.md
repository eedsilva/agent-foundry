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
