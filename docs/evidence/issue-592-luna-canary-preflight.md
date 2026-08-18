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

## Not covered here

A full `POST /validation/campaign/preflight` run against the live API was not executed for this branch: it needs Docker, a Supabase stack and an API on `:4000`, and the only boundary #592 reported red is the one proven above in isolation. The 4-shape golden-journey rerun that #589 and #564 are waiting on remains their own acceptance step.
