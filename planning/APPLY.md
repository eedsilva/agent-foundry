# Applying the GitHub migration

The scripts require a token with repository write/admin access and, for the user-owned Project, classic project scope compatible with GitHub's user Project endpoints.

```bash
gh auth status
npm run github:roadmap:dry-run
npm run github:governance:dry-run
```

Apply in this order:

```bash
# Creates 28 new managed issues and 3 milestones, migrates labels/titles/bodies,
# restores hierarchy, and replaces only managed stale blockers.
npm run github:roadmap:apply

# Creates/reconciles Project, fields, views, items, repository settings,
# security toggles, and a disabled main ruleset.
npm run github:governance:apply
```

Push the governance commit and let every named check complete successfully. GitHub normally requires a status check to have run recently before it can be selected as required.

```bash
npm run github:governance:activate-ruleset
npm run github:release:publish-baseline
```

## Drift policy

`--reconcile` replaces fields generated from the spec only when the current body hash matches the last applied or legacy hash. A manual edit stops the migration. Review it, move durable information into the spec, then reconcile. `--force-drift` is deliberately sharp and should not be part of routine automation.

## Project workflows

GitHub exposes project fields, items, and views programmatically, but built-in workflow configuration is maintained in the Project UI. Follow [PROJECT_AUTOMATIONS.md](PROJECT_AUTOMATIONS.md) after project creation.
