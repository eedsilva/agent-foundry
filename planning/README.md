# Planning source of truth

- `roadmap-spec.json` defines labels, milestones, dependency graph, epics, tasks, priorities, targets, and acceptance criteria.
- `ROADMAP.md` is generated. `npm run roadmap:render` updates it; CI uses `--check`.
- `github-state.json` maps managed keys to published issue numbers and body hashes. It is not a generic GitHub backup.
- `project-spec.json` defines Project fields/views and WIP policy.
- `governance-spec.json` defines repository settings, ruleset checks, security toggles, and baseline release.
- `DELIVERY_FOUNDATION_REPORT.md` records migration scope, validation evidence, and the exact apply sequence.

The legacy top-level `agent-foundry-roadmap/` package is retired by this migration to avoid two competing sources of truth.

The scripts are dry-run by default. See [APPLY.md](APPLY.md).
