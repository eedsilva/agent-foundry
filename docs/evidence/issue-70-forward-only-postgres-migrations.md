# Issue #70 — forward-only generated-project Postgres migrations evidence

Date: 2026-07-23

## Acceptance mapping

| Intent                    | Implemented boundary                                                                                                             | Automated evidence                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Isolated project database | #69 supplies one Supabase CLI workdir and Postgres runtime per generated project                                                 | `packages/platform/src/supabase-runtime.test.ts` lifecycle/isolation coverage |
| Review before apply       | Preview calculates migration SHA-256 and reports destructive statements                                                          | Adapter preview tests                                                         |
| Safe destructive apply    | Approval covers the full destructive batch; a generated manifest verifies a fresh, untampered combined schema-plus-data artifact | Adapter backup/provenance, changed-SQL, tamper, stale, and batch tests        |
| Forward-only operation    | Apply invokes only `supabase migration up`                                                                                       | Adapter assertions reject any `migration down` lifecycle                      |
| Recovery                  | Operator chooses application roll-forward or explicit selected-backup restore; no automatic restore exists                       | ADR 0031 and operations contract                                              |

## Verification

- `npx vitest run packages/platform/src/supabase-runtime.test.ts --pool=threads --maxWorkers=1` covers preview detection, generated combined backups, approval/provenance, and forward apply.
- Documentation contract checks that operations state `forward-only` and the roll-forward-before-restore recovery path.
- `npm run check` is the repository-wide documentation/project gate for this change.

## Operational limits

- The destructive detector is deliberately a conservative gate, not a full SQL parser.
- The backup artifact is local to the isolated project runtime. Preserve it and its generated manifest until the migration is accepted.
- A code rollback is safe only when compatible with the current schema; otherwise stop the project and roll forward or explicitly restore the selected backup.
