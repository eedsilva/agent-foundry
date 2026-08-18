# Issue #592: luna-canary preflight — root cause and the instrumentation that was missing

## What #592 actually contained

Two defects, filed together:

| Reported | Where it lives | Status |
| --- | --- | --- |
| `luna-canary` fails the campaign preflight with `status=failed executedModel=missing`, so no golden-journey rerun proves anything | `extractSingletonCodexModel` anchored on `provider=ModelProviderInfo`, which Codex CLI 0.147.0 renamed | fixed by #593 / PR #594 (`b8e1999e`), already on `main` |
| "Defeito adjacente": a canary that fails without throwing persists no cause — not in `preflight-<sha>.json`, not in `events.jsonl` — so diagnosing it required instrumenting the code by hand first | `runValidationCampaignCanary` dropped `ProviderCanaryRun.error` and `.verification` at the seam into `ValidationCanaryResult` | fixed here |

The hypothesis in the issue — "the CLI started printing noise before the answer and the parser does not survive it" — was **not** the cause. The parser reads `Configuring session:` lines out of stderr and ignores everything else; what broke was the struct name that used to follow the model field on that same line.

## Root cause is closed: real-mode luna canary

The same canary the preflight boundary runs, executed in isolation against the real Codex CLI 0.147.0 on this branch — no Docker, Supabase or API needed, because only the executed-model contract was ever in question:

```bash
CODEX_DEFAULT_MODEL=gpt-5.6-luna npx tsx <<'TS'
import {
  createValidationCampaignCanaryDependencies,
  runValidationCampaignCanary,
} from '@agent-foundry/composition';

console.log(
  JSON.stringify(
    await runValidationCampaignCanary({
      model: { id: 'codex-default', provider: 'codex', model: 'gpt-5.6-luna' },
      taskKind: 'implementation',
      dependencies: createValidationCampaignCanaryDependencies(),
    }),
    null,
    2,
  ),
);
TS
```

2026-08-18 result:

```json
{
  "provider": "codex",
  "selectedModel": "gpt-5.6-luna",
  "executedModel": "gpt-5.6-luna",
  "status": "passed"
}
```

`executedModel` is proven and the greenfield scenario's deterministic checks (`node-test`, `git-diff-check`, `allowed-files`) all pass, which is exactly what the `luna-canary` boundary asserts. The preflight boundary that produced `model-failed` on 2026-08-18 has no failing input left.

## What the instrumentation changes

`ValidationCanaryResult` now carries the run's `SanitizedError`, with the names of the deterministic checks that failed folded into its message, and `recordCanaryCheck` reports that code and cause instead of a fixed string.

Before — every failure mode collapsed to one line, and `errorCode` only distinguished "no executed model" from "everything else":

```text
luna-canary failed — luna-canary did not prove its executed model and output contract.
status=failed executedModel=missing            errorCode=UNKNOWN_EXECUTED_MODEL
```

After — the runner's own classification survives, so a verification failure names the checks that broke instead of looking identical to a dead CLI:

```text
luna-canary failed — luna-canary did not prove its executed model and output contract.
status=failed executedModel=gpt-5.6-luna verification: One or more deterministic scenario checks failed. Failed checks: node-test, allowed-files.
                                               errorCode=VERIFICATION_FAILED
```

The four codes the operator can now tell apart on the preflight surface: `VERIFICATION_FAILED`, `ARTIFACT_NOT_COMPLETED`, `UNKNOWN_EXECUTED_MODEL`, `EXECUTION_FAILED`.

## Deliberate limit

Raw provider stdout/stderr stays out of the report. `packages/composition/src/provider-canary.test.ts` guards that the canary report never carries provider output or temporary workspace paths, and `redactString` / `redactPersonalPaths` do not scrub `/var/folders/...` workspace paths. Diagnosing #593 needed that stderr — the classification and the check names are what this change buys without weakening the leak guarantee. A `ponytail:` comment on `canaryFailureCause` records the ceiling and the upgrade path.

## Full campaign preflight acceptance

After the review fixes, the real API from code commit `0ad17c7d15836da9a94e662e85aa5df39b0aad0f` ran with an external disposable `DATA_DIR`, Docker 29.4.0, Supabase CLI 2.62.5, Codex CLI 0.147.0 and Claude Code 2.1.234:

```bash
DATA_DIR=/absolute/path/outside-the-repository \
API_HOST=127.0.0.1 API_PORT=4000 RUN_WORKER_INLINE=false \
EXECUTOR_MODE=real VALIDATION_CAMPAIGN=real-todo-v1 \
CODEX_DEFAULT_MODEL=gpt-5.6-luna \
CLAUDE_FAST_MODEL=claude-haiku-4-5-20251001 \
npx tsx apps/api/src/index.ts

curl --fail-with-body --request POST \
  http://127.0.0.1:4000/validation/campaign/preflight
```

Result from 2026-08-18T22:47:53.515Z through 2026-08-18T22:51:09.328Z:

```json
{
  "schemaVersion": "1",
  "campaignId": "real-todo-v1",
  "sourceRevision": "0ad17c7d15836da9a94e662e85aa5df39b0aad0f",
  "dataDirectory": "[REDACTED]",
  "executorMode": "real",
  "status": "passed",
  "checks": [
    "source-revision:passed",
    "data-directory:passed",
    "executor-mode:passed",
    "disposable-environment:passed",
    "docker:passed",
    "supabase:passed",
    "scaffold:passed",
    "application-health:passed",
    "preview-gateway:passed",
    "haiku-canary:passed selected=claude-haiku-4-5-20251001 executed=claude-haiku-4-5-20251001",
    "luna-canary:passed selected=gpt-5.6-luna executed=gpt-5.6-luna"
  ],
  "generatedProjectCreated": false
}
```

The preflight objective in #592 is therefore demonstrated on the corrected code revision. The 4-shape golden-journey rerun that #589 and #564 are waiting on remains their own acceptance step.
