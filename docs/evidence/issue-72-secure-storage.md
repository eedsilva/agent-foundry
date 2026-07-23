# Issue #72: secure generated-project storage evidence

## Acceptance

| Acceptance intent                 | Implementation                                                                                       | Evidence                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Compose/environment scoped bucket | private `uploads` bucket inside #69 isolated workdir/stack                                           | runtime two-project isolation + config test |
| Size/type policy and signed URL   | native 10MiB/MIME bucket limits; signed upload/download                                              | real storage E2E                            |
| Ownership and authorization       | owner path plus read-only metadata and `storage.objects` RLS                                         | real A/B and direct-DML denial E2E          |
| Malware hook and quarantine       | service-role queue/completion; clean-only read policy                                                | unit SQL contract + real quarantine denial  |
| Retention export and cleanup      | manifest, explicit export confirmation, expired-candidate selection, API byte delete before metadata | real lifecycle E2E                          |

## Results

Focused storage/runtime unit suite:

```bash
npx vitest run packages/platform/src/supabase-storage.test.ts packages/platform/src/supabase-runtime.test.ts --pool=threads --maxWorkers=1
```

Result: 2 files passed, 27 / 27 tests green.

Authoritative branch CI storage E2E: run `30035930063`, job `89303808401`, at storage
implementation head `3cb9d41a89d29cea48dd14f45cb991533700e656`; passed in 3m11s.
[Open storage-e2e job](https://github.com/eedsilva/agent-foundry/actions/runs/30035930063/job/89303808401).

The prior run `30031557014` exposed an incompatibility in parsing `supabase start` output. The
`25184c8` runtime fix reads the authoritative `supabase status --output json` result after start. This
is engineering evidence for the fix, not an acceptance failure for the green storage E2E. Run
`30035930063` verifies the signed-upload wire contract, a valid PNG round trip, cross-user denial,
native bucket limits, quarantine, export, and cleanup on the security-fixed implementation. The broad
CI `test` job is reported only when its GitHub job reaches a successful terminal state; no broad-suite
count is inferred from the storage job.

## Contract checks

- `uploads` is private and native bucket limits enforce 10 MiB plus the three allowed MIME types.
- `prepare_storage_upload` creates quarantine metadata for an owner path; authenticated signed upload
  and download URLs are bearer credentials and are never public or persistent. Authenticated clients
  can select their metadata but cannot insert, update, or delete it directly; write transitions remain
  inside the guarded RPC contract.
- `storage_scan_queue` and `complete_storage_scan` are service-role-only. Only `clean` objects are
  readable; `quarantine` and `rejected` remain unavailable.
- `storage_export_manifest` lists clean, unexpired owner records. Bytes are copied before
  `confirm_storage_export` records completion.
- `storage_cleanup_candidates` selects only eligible expired records. The worker deletes bytes through
  the Storage API, verifies they are absent, then calls `confirm_storage_cleanup` to remove metadata.
