# Contributing to Agent Foundry

Agent Foundry treats a change as complete only when its behavior is observable and its risks are explicit. A green compiler alone is not evidence.

## Before starting

1. Pick an issue in `Ready`; do not keep more than two items in `In Progress` across the project.
2. Confirm `docs/DEFINITION_OF_READY.md` is satisfied.
3. For architectural, security, persistence, provider, or public-contract changes, add or update an ADR.
4. Work from a branch and keep the issue linked to the pull request.

## Local checks

```bash
npm ci
npm run check
```

The check suite validates formatting, lint, package boundaries, roadmap drift, GitHub configuration, TypeScript, tests, and builds.

## Pull requests

A pull request must explain the observable result, evidence, risks, security impact, migration, and rollback. Use `Closes #<issue>` only when the issue's acceptance criteria and Definition of Done are actually satisfied.

Do not hide failed agent attempts or repair loops. They are product evidence, not litter to sweep under a rug.

## Commit and merge policy

- Prefer small, reviewable commits.
- Use squash or rebase merge.
- Do not force-push `main`.
- Do not commit `.env`, CLI credentials, `DATA_DIR`, generated workspaces, or raw artifacts containing user data.
