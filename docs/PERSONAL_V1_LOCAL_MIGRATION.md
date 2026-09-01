# Personal Builder v1 local-project migration guide

This runbook covers one scope only: an existing **local** Agent Foundry v0.x project moving forward into the Personal v1 runtime and operating model. It does **not** add pricing, launch, hosted migration, cloud recovery, or any dependent work from [#98](https://github.com/eedsilva/agent-foundry/issues/98) or [#143](https://github.com/eedsilva/agent-foundry/issues/143). Those issues still own release-proof and traceability closure; this guide gives operators a concrete upgrade path for the local project they already have.

The path is forward-only. Agent Foundry does not ship an automatic `v0.x -> v1` migrator, automatic down-migration, or automatic database restore. Operators migrate by inventorying the project, taking explicit backups, upgrading the app, reconciling the runtime, applying forward migrations, and verifying the result.

## Scope and safety boundary

- Target: an existing local project under `DATA_DIR/projects/<projectId>/`.
- Source: any prior local v0.x project state that the operator still controls on disk.
- Destination: Personal v1 local runtime and operating rules.
- Non-goals: hosted migration, VPS publish, launch readiness, release sign-off, automatic database rollback, and import of arbitrary external repositories.

If any required snapshot or backup cannot be created and verified, stop. Do not continue with a destructive or irreversible step.

## 1. Preflight: stop writers and confirm operator prerequisites

Before inspecting or changing project state:

1. stop the Agent Foundry API, worker, preview sessions, and any manual Supabase/Compose process still writing to the project;
2. identify the exact `DATA_DIR` and `projectId`;
3. confirm the target Personal v1 checkout can run its normal host preflight.

Useful host checks:

```bash
npm run doctor -- --json
supabase --version
docker info
```

If `supabase --version` or `docker info` fails, do not continue into runtime reconciliation or migration. Fix host prerequisites first.

## 2. Detect the source project version and inventory what exists

Set reusable shell variables first:

```bash
PROJECT_ID="<project-id>"
DATA_DIR="<absolute-data-dir>"
PROJECT_DIR="$DATA_DIR/projects/$PROJECT_ID"
WORKSPACE_DIR="$PROJECT_DIR/workspace"
BACKUP_ROOT="$HOME/agent-foundry-migration-backups/$PROJECT_ID-$(date +%Y%m%d-%H%M%S)"
```

Verify the project exists and capture a lightweight inventory:

```bash
test -d "$PROJECT_DIR"
test -d "$WORKSPACE_DIR/.git"
jq '{id,name,version,currentRunId}' "$PROJECT_DIR/project.json"
find "$PROJECT_DIR" -maxdepth 2 \( -name workspace -o -name environment -o -name conversation -o -name versions -o -name artifacts \) -print | sort
git -C "$WORKSPACE_DIR" status --short --branch
git -C "$WORKSPACE_DIR" rev-parse HEAD
```

Interpret the result conservatively:

- if `project.json` lacks a usable `version`, treat the project as legacy v0.x and continue only with a fresh snapshot;
- if `environment/` is absent, the project has not yet been reconciled into the Personal v1 generated-project runtime and will need runtime initialization under v1;
- if `conversation/` or `versions/` is absent, treat that as expected legacy shape unless the current app already wrote those directories;
- if the workspace Git repo is missing or dirty in an unexpected way, stop and preserve the current tree before any runtime change.

Save the inventory next to the backup:

```bash
mkdir -p "$BACKUP_ROOT"
jq '{id,name,version,currentRunId}' "$PROJECT_DIR/project.json" > "$BACKUP_ROOT/project-inventory.json"
git -C "$WORKSPACE_DIR" status --short --branch > "$BACKUP_ROOT/workspace-git-status.txt"
git -C "$WORKSPACE_DIR" rev-parse HEAD > "$BACKUP_ROOT/workspace-head.txt"
find "$PROJECT_DIR" -maxdepth 2 \( -name workspace -o -name environment -o -name conversation -o -name versions -o -name artifacts \) -print | sort > "$BACKUP_ROOT/project-tree.txt"
```

## 3. Back up both filesystem state and the project runtime

Take a filesystem snapshot before opening the project in Personal v1:

```bash
rsync -a "$PROJECT_DIR/" "$BACKUP_ROOT/project/"
```

That snapshot must preserve:

- `project.json` and any project metadata under `DATA_DIR`;
- the full Git workspace, including `.git/`;
- any existing `environment/`, `conversation/`, `versions/`, and artifact trees already present.

If the project already has a generated-project runtime with a real local Postgres/Supabase environment, take a database backup **before** any destructive migration apply. Use the generated-project migration flow described in [docs/OPERATIONS.md](OPERATIONS.md) and [ADR 0031](adr/0031-forward-only-generated-project-migrations.md): create the explicit combined backup artifact (schema dump plus `--data-only` dump), keep its manifest, and verify its checksums before approval.

Do **not** treat an app-only Git snapshot as a substitute for a database backup.

## 4. Upgrade the application, then reconcile the project under Personal v1

After the old writers are stopped and the backup is verified, inspect the inventory **before**
starting Personal v1:

1. if runtime metadata has an explicit `identity`, start Personal v1 and reconcile that exact
   `projectId` + `environmentId` with `inspect`, `health`, and `start` when stopped;
2. if `DATA_DIR/projects/<projectId>/environment/` exists without an identity, stop the upgrade.
   #618 keeps that root listable for inventory but rejects it as a lifecycle target;
3. preserve the project and database backups, then migrate the legacy state through a separately
   reviewed procedure that assigns an explicit identity. This repository does not convert it
   automatically, and starting another run does not perform the migration;
4. without an approved conversion procedure, keep or restore the pre-#618 application version.

Never copy metadata to the new layout, infer candidate/accepted/manual-preview, delete the workdir,
call `supabase db reset`, or remove runtime directories by hand. Once conversion has completed, the
workspace must remain the same Git repository captured in the inventory and `inspect`/`health` must
address the converted environment explicitly.

## 5. Execute the migration forward-only

Once the Personal v1 runtime is healthy enough to operate:

1. review pending project SQL migrations under `supabase/migrations/*.sql`;
2. preview the batch and read the recorded SHA-256 values for the SQL to be applied;
3. if the batch is destructive, confirm the fresh backup artifact and manifest from step 3 are still intact and within the required freshness window;
4. run the normal Personal v1 migration apply path;
5. if needed, run seed/health actions that are already part of the generated-project runtime contract.

Rules that do not change during migration:

- Personal v1 applies migrations forward with `migration up`;
- there is no automatic `down` path;
- application rollback never triggers database rollback;
- a data restore is a separate explicit operator action against a chosen backup.

## 6. Verify the migrated project before normal work resumes

Before declaring the project migrated:

1. rerun `inspect` and `health`;
2. confirm the workspace Git repo still points to the expected repository and `HEAD`;
3. boot the project preview/runtime successfully under Personal v1;
4. confirm the project can read its existing local state without inventing missing data;
5. capture the new runtime/app version and any migration identifiers next to the backup records.

A lightweight post-migration record can be captured with:

```bash
git -C "$WORKSPACE_DIR" rev-parse HEAD > "$BACKUP_ROOT/post-migration-workspace-head.txt"
git -C "$WORKSPACE_DIR" status --short --branch > "$BACKUP_ROOT/post-migration-workspace-status.txt"
```

This guide does **not** replace the broader release evidence owned by [#98](https://github.com/eedsilva/agent-foundry/issues/98) and [#143](https://github.com/eedsilva/agent-foundry/issues/143). It only proves that one existing local project reached the Personal v1 runtime safely.

## 7. App rollback versus database restore

Keep these two actions separate:

- **Application rollback:** redeploy or reopen a prior compatible application code/configuration version. This is valid only when the already-applied schema still supports that app version.
- **Database restore:** stop the project, choose an explicit verified backup, and restore data/schema intentionally. This is a recovery workflow, not a side effect of app rollback.

Never assume that “roll back the app” means “undo the database.” Personal v1 does not promise that, and this guide does not authorize it.

## 8. Abort and restore procedure

### Abort before any migration apply

If the operator stops before a forward migration is applied:

1. stop the Personal v1 app and any preview/runtime process writing to the project;
2. restore the filesystem snapshot from `"$BACKUP_ROOT/project/"` back into `"$PROJECT_DIR"`;
3. start the old application version again only after the restore is complete.

### Restore after a failed forward migration

If a migration was already applied and the project is not viable:

1. stop the project runtime and the Agent Foundry processes that can write to it;
2. decide whether the failure is recoverable by a **roll-forward** of the application;
3. only if roll-forward is not the chosen path, restore the explicit selected runtime/database backup created before the migration;
4. restore the filesystem snapshot when project metadata/workspace state also needs to return to the pre-migration state;
5. restart the recovered application version only after the restore is complete.

Do not mix “old app binary” and “newly migrated data” optimistically. If compatibility is not proven, either roll forward the app or perform the explicit restore.

## 9. Failure handling checklist

Stop and preserve evidence instead of improvising when any of these occurs:

- backup path missing, incomplete, or checksum verification fails;
- `project.json` cannot be read or the workspace Git repo is missing;
- `inspect`/`health` disagree with the on-disk runtime in a way the normal lifecycle cannot reconcile;
- a destructive migration batch lacks the fresh verified backup artifact or approval record;
- the project boots only after deleting runtime/workspace state manually.

In those cases:

1. keep the project stopped;
2. preserve `DATA_DIR`, workspace, manifests, and diagnostics;
3. choose either explicit restore or a deliberate roll-forward plan;
4. do not run destructive reset/down-migration commands to “see if it helps.”

## Ownership note

Issue [#212](https://github.com/eedsilva/agent-foundry/issues/212) owns this runbook so the existing local v0.x migration criterion is no longer ownerless after the #101 re-scope. It complements — but does not replace — the Personal v1 traceability and release owners already recorded in [docs/PERSONAL_V1_TRACEABILITY.md](PERSONAL_V1_TRACEABILITY.md).
