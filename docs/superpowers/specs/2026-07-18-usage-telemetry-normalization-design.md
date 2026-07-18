# Normalize tokens, cost, quota, and rate limits across providers

Issue: [#62](https://github.com/eedsilva/agent-foundry/issues/62) — v0.9 usage telemetry.
Parent: #60. Track: Research. Target: Shared. Commitment: Exploratory.

## Problem

Subscriptions and metered APIs expose different signals. Today the system
collapses them into a single optional `ExecutionUsage` (tokens + one
`estimatedCostUsd`) and, at the aggregate level, treats missing data as `0`.
That conflates three distinct things:

- **Monetary cost** (USD, for metered providers).
- **Quota consumption** (subscription "units" — messages/credits — that cost no
  marginal dollars but are still finite).
- **Data provenance** — whether a number was reported by the provider,
  computed by us, pre-run estimated, or simply unknown.

It also has no notion of provider **rate limits** (limit / remaining / reset),
so the router cannot avoid a provider that is temporarily exhausted, and cannot
budget by the unit that is actually scarce.

## Goals (issue acceptance criteria)

1. UsageReport carries input/output/cache tokens, cost, quota units, and source
   quality.
2. Missing data stays **unknown**, never an invented zero.
3. Rate limit and reset live in ProviderHealth.
4. Router can apply a budget by the available unit.
5. UI shows estimated versus observed.

Mandatory tests: partial-usage fixtures for Codex, Claude, and AGY.

## Non-goals

- No cumulative per-run budget ledger persisted across steps (deferred; this
  track only needs the router to *apply* a budget it is handed).
- No new provider integrations; only richer parsing of existing CLI output.
- No pricing-catalog changes beyond what already feeds cost estimation.

## Design

All changes are **additive and optional/defaulted**, so persisted records and
existing call sites keep working without migration.

### 1. Contracts (`packages/contracts`)

**`run.ts` — `ExecutionUsageSchema` (the UsageReport):**

- Add `quotaUnits?: number` (nonnegative) — subscription units consumed when the
  provider exposes them.
- Add `sourceQuality: 'provider-reported' | 'computed' | 'estimated' | 'unknown'`
  with default `'unknown'` — provenance/confidence of the report.
- Export `type UsageReport = ExecutionUsage` (issue vocabulary; no new schema).

All token/cost/quota fields remain **optional** — absence means unknown, never
zero.

`sourceQuality` semantics:
- `provider-reported` — parsed from the provider's own usage JSON.
- `computed` — derived by us (e.g. cost = tokens × catalog pricing).
- `estimated` — a pre-run estimate, not an observation.
- `unknown` — nothing usable was found.

**`project.ts` — `ExecutorHealthSchema`:**

- Add optional `rateLimit?: { limit?: number; remaining?: number; resetAt?:
  string (datetime) }`. All fields optional → unknown, never invented.

**`model.ts` — `ModelMetricSchema`:**

- Add `quotaUnitsTotal` (nonnegative, default 0).
- Add per-signal known counts, all int nonnegative default 0:
  `inputTokensKnownCount`, `outputTokensKnownCount`,
  `cachedInputTokensKnownCount`, `costKnownCount`, `quotaUnitsKnownCount`.
- Totals accumulate **only defined** values; the known-count distinguishes
  "aggregate of zero known samples" (unknown) from "known samples that summed to
  zero".

### 2. Executors (`packages/executors`)

**`json-output.ts`:**

- `extractUsage` sets `sourceQuality` (`provider-reported` when any real usage
  field is parsed from provider JSON; `unknown` otherwise) and parses
  `quotaUnits` where a provider exposes it.
- New `extractRateLimit(provider, stdout)` → `{ limit?, remaining?, resetAt? } |
  undefined`, defensively parsed from provider output (reusing the existing
  `numberFrom` guards).

**`base-cli-executor.ts`:**

- Cache the most recent parsed rate-limit on the executor instance after a run.
- `health()` spreads the cached `rateLimit` into the returned `ExecutorHealth`
  (health's `--version` probe cannot see rate limits; the last run can).

### 3. Model router (`packages/model-router`)

**`score-router.ts`** gains two optional inputs:

- `providerHealth?: Map<Provider, ExecutorHealth>` — exclude a model when its
  provider's `rateLimit.remaining === 0 && resetAt > now`; push to the existing
  `rejected[]` with reason `rate-limited`.
- `budget?: { maxCostUsd?: number; maxQuotaUnits?: number }` — reject a model
  when its estimated cost (or quota) would exceed the remaining budget; reason
  `over-budget`.

Both are optional; absent inputs preserve current behavior exactly.

### 4. Persistence (`packages/persistence`)

**`metrics-repository.ts`:**

- Accumulate token/cost/quota totals only for **defined** values; increment the
  matching known-count; sum `quotaUnits` into `quotaUnitsTotal`.
- Remove the `?? 0` inventions on write; default known-counts to 0 on the
  empty/getOrEmpty path.

### 5. UI (`apps/web`)

- Route-decision panel: show observed usage from the step attempt's `usage`
  (in/out/cached tokens, cost, quota) beside the existing estimated cost.
- Render `unknown` where a field is absent; display `sourceQuality`.

### 6. Tests / fixtures

- Partial-usage fixtures for Codex, Claude, AGY (some fields present, some
  missing) → `extractUsage` yields `undefined` (not 0) for missing fields, and
  the correct `sourceQuality`; `extractRateLimit` parses limit/remaining/reset.
- Router: rate-limited provider excluded; over-budget model rejected; absent
  inputs unchanged.
- `metrics-repository`: an unknown sample does not increment a total and does
  not raise its known-count; a real-zero sample raises the known-count.

## Data flow

```
provider CLI stdout
  → extractUsage  → UsageReport (tokens/cost/quota + sourceQuality)  → step attempt.usage
  → extractRateLimit → cached on executor → health() → ExecutorHealth.rateLimit
step attempt.usage → metrics-repository → ModelMetric (totals + known counts)
ExecutorHealth.rateLimit + budget → score-router → RouteDecision.rejected[]
step attempt.usage → apps/web route panel (observed vs estimated)
```

## Error handling

- All parsing is defensive (`numberFrom` guards, try/catch already in place);
  malformed provider output yields `undefined`, never a throw and never a 0.
- Router treats absent health/budget as "no constraint", never as "block".

## Migration & rollback

- Purely additive schema changes with defaults → no data migration; old
  persisted `ModelMetric`/usage records validate under Zod defaults on read.
- Rollback = revert the PR; no persisted shape becomes unreadable.

## Security

- Only defensive parsing of already-trusted CLI output; no new external inputs,
  secrets, or network calls. Numeric fields are bounded by existing guards.

## Definition of Done

- `docs/DEFINITION_OF_DONE.md` satisfied: tests, observable evidence, and
  security/migration/rollback assessed (this section).
- CI green (format, lint, architecture, roadmap, typecheck, test, build) and
  e2e passing.
