# Usage Telemetry Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize tokens, cost, quota, and rate limits across providers so usage is honest (unknown ≠ zero), rate limits reach ProviderHealth, and the router can budget by the scarce unit.

**Architecture:** Purely additive, optional schema fields in `@agent-foundry/contracts` + domain ports (Task 1, blocking). Then four independent tasks that touch disjoint files: executor parsing (Task 2), persistence aggregation (Task 3), router budgeting (Task 4), UI observed-vs-estimated (Task 5). Tasks 2–5 have no shared files and run in parallel after Task 1 lands.

**Tech Stack:** TypeScript, Zod, Vitest, Next.js (App Router, RSC). Monorepo npm workspaces.

## Global Constraints

- **Never invent zero.** A missing signal is represented by an absent (`undefined`) field, never `0`. All new numeric fields are `.optional()`. (Issue AC #2.)
- **Additive & backward-compatible.** Every schema change is optional/defaulted; persisted records validate unchanged. No data migration.
- **Zod strict objects stay strict.** `ExecutionUsageSchema` and `ExecutorHealthSchema` use `.strict()`; add fields inside the object, keep `.strict()`.
- **TDD.** Every task: failing test → run (fail) → minimal impl → run (pass) → commit.
- **Commit style.** Conventional commits; footer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **CI gate:** `npm run check` (format:check, lint, architecture:check, roadmap:check, typecheck, test, build) must pass.
- **Provider enum values:** `codex`, `claude`, `agy`, `mock` (from `ProviderSchema`).

---

## Task 1: Contracts + domain ports (FOUNDATION — must land first)

**Files:**

- Modify: `packages/contracts/src/run.ts` (`ExecutionUsageSchema`, `+ UsageReport`)
- Modify: `packages/contracts/src/project.ts` (`ExecutorHealthSchema`)
- Modify: `packages/contracts/src/model.ts` (`ModelMetricSchema`)
- Modify: `packages/contracts/src/index.ts` (export `UsageReport` if not via `export *`)
- Modify: `packages/domain/src/ports.ts` (`MetricsRepository.record`, `ModelRouter.route`, new `RouteConstraints`)
- Test: `packages/contracts/src/run.test.ts`, `packages/contracts/src/model.ts` covered via a new `model.usage.test.ts` (or existing test file if present)

**Interfaces (Produces — later tasks rely on these exact names/types):**

- `ExecutionUsage` / `UsageReport` = `{ inputTokens?, outputTokens?, cachedInputTokens?, quotaUnits?, estimatedCostUsd?, sourceQuality?: 'provider-reported'|'computed'|'estimated'|'unknown' }`
- `ExecutorHealth.rateLimit?: { limit?: number; remaining?: number; resetAt?: string }`
- `ModelMetric` += `quotaUnitsTotal?`, `inputTokensKnownCount?`, `outputTokensKnownCount?`, `cachedInputTokensKnownCount?`, `costKnownCount?`, `quotaUnitsKnownCount?` (all `number`, optional)
- `MetricsRepository.record` input += `cachedInputTokens?: number`, `quotaUnits?: number`
- `ModelRouter.route(profile, explicit?, constraints?: RouteConstraints)`
- `RouteConstraints = { providerHealth?: ReadonlyMap<string, ExecutorHealth>; budget?: { maxCostUsd?: number; maxQuotaUnits?: number } }`

- [ ] **Step 1: Write failing test — ExecutionUsage carries quota + sourceQuality**

Add to `packages/contracts/src/run.test.ts`:

```typescript
import { ExecutionUsageSchema } from './run.js';

describe('ExecutionUsageSchema (usage report)', () => {
  it('accepts quota units and source quality', () => {
    const usage = ExecutionUsageSchema.parse({
      inputTokens: 10,
      quotaUnits: 3,
      sourceQuality: 'provider-reported',
    });
    expect(usage.quotaUnits).toBe(3);
    expect(usage.sourceQuality).toBe('provider-reported');
  });

  it('leaves missing signals undefined, never zero', () => {
    const usage = ExecutionUsageSchema.parse({ inputTokens: 10 });
    expect(usage.outputTokens).toBeUndefined();
    expect(usage.quotaUnits).toBeUndefined();
    expect(usage.sourceQuality).toBeUndefined();
  });

  it('rejects an invalid source quality', () => {
    expect(() => ExecutionUsageSchema.parse({ sourceQuality: 'guess' })).toThrow();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run packages/contracts/src/run.test.ts -t "usage report"`
Expected: FAIL (`Unrecognized key(s) "quotaUnits"` / `sourceQuality`).

- [ ] **Step 3: Implement — extend `ExecutionUsageSchema` in `run.ts`**

Replace the existing schema (currently lines ~46–54):

```typescript
export const UsageSourceQualitySchema = z.enum([
  'provider-reported',
  'computed',
  'estimated',
  'unknown',
]);
export type UsageSourceQuality = z.infer<typeof UsageSourceQualitySchema>;

export const ExecutionUsageSchema = z
  .object({
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    cachedInputTokens: z.number().nonnegative().optional(),
    quotaUnits: z.number().nonnegative().optional(),
    estimatedCostUsd: z.number().nonnegative().optional(),
    sourceQuality: UsageSourceQualitySchema.optional(),
  })
  .strict();
export type ExecutionUsage = z.infer<typeof ExecutionUsageSchema>;

/** Issue #62 vocabulary — normalized usage across providers. */
export type UsageReport = ExecutionUsage;
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run packages/contracts/src/run.test.ts -t "usage report"`
Expected: PASS.

- [ ] **Step 5: Write failing test — ExecutorHealth carries rate limit**

Add to `packages/contracts/src/project.test.ts` (create the `describe` if the file lacks one; import `ExecutorHealthSchema` from `./project.js`):

```typescript
import { ExecutorHealthSchema } from './project.js';

describe('ExecutorHealthSchema rate limit', () => {
  it('accepts optional rate limit with reset', () => {
    const health = ExecutorHealthSchema.parse({
      provider: 'claude',
      available: true,
      message: 'ok',
      rateLimit: { limit: 100, remaining: 4, resetAt: '2026-07-18T12:00:00.000Z' },
    });
    expect(health.rateLimit?.remaining).toBe(4);
  });

  it('omits rate limit when unknown', () => {
    const health = ExecutorHealthSchema.parse({
      provider: 'codex',
      available: true,
      message: 'ok',
    });
    expect(health.rateLimit).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run test — expect FAIL**

Run: `npx vitest run packages/contracts/src/project.test.ts -t "rate limit"`
Expected: FAIL.

- [ ] **Step 7: Implement — add `rateLimit` to `ExecutorHealthSchema` in `project.ts`**

Replace the existing schema (currently lines ~170–176):

```typescript
export const ProviderRateLimitSchema = z
  .object({
    limit: z.number().nonnegative().optional(),
    remaining: z.number().nonnegative().optional(),
    resetAt: z.string().datetime().optional(),
  })
  .strict();
export type ProviderRateLimit = z.infer<typeof ProviderRateLimitSchema>;

export const ExecutorHealthSchema = z.object({
  provider: ProviderSchema,
  available: z.boolean(),
  version: z.string().optional(),
  message: z.string(),
  rateLimit: ProviderRateLimitSchema.optional(),
});
export type ExecutorHealth = z.infer<typeof ExecutorHealthSchema>;
```

- [ ] **Step 8: Run test — expect PASS**

Run: `npx vitest run packages/contracts/src/project.test.ts -t "rate limit"`
Expected: PASS.

- [ ] **Step 9: Write failing test — ModelMetric known-counts**

Add to `packages/contracts/src/model.test.ts` (create the file if absent, with `import { describe, expect, it } from 'vitest'` and `import { ModelMetricSchema } from './model.js'`):

```typescript
describe('ModelMetricSchema known counts', () => {
  const base = {
    modelId: 'm',
    taskKind: 'implementation',
    role: 'developer',
    attempts: 1,
    successes: 1,
    totalDurationMs: 1,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalEstimatedCostUsd: 0,
    consecutiveFailures: 0,
    updatedAt: '2026-07-18T12:00:00.000Z',
  };

  it('defaults known counts and quota total to undefined (unknown, not zero)', () => {
    const metric = ModelMetricSchema.parse(base);
    expect(metric.inputTokensKnownCount).toBeUndefined();
    expect(metric.quotaUnitsTotal).toBeUndefined();
  });

  it('accepts explicit known counts and quota total', () => {
    const metric = ModelMetricSchema.parse({
      ...base,
      quotaUnitsTotal: 5,
      inputTokensKnownCount: 1,
      quotaUnitsKnownCount: 1,
    });
    expect(metric.quotaUnitsTotal).toBe(5);
    expect(metric.inputTokensKnownCount).toBe(1);
  });
});
```

- [ ] **Step 10: Run test — expect FAIL**

Run: `npx vitest run packages/contracts/src/model.test.ts -t "known counts"`
Expected: FAIL (fields stripped/undefined mismatch or unrecognized keys — `ModelMetricSchema` is a non-strict `z.object`, so it strips unknown keys; the `quotaUnitsTotal: 5` assertion fails).

- [ ] **Step 11: Implement — add fields to `ModelMetricSchema` in `model.ts`**

Inside `ModelMetricSchema` (after `qualityApprovals`, before `lastFailureAt`), add:

```typescript
  quotaUnitsTotal: z.number().nonnegative().optional(),
  inputTokensKnownCount: z.number().int().nonnegative().optional(),
  outputTokensKnownCount: z.number().int().nonnegative().optional(),
  cachedInputTokensKnownCount: z.number().int().nonnegative().optional(),
  costKnownCount: z.number().int().nonnegative().optional(),
  quotaUnitsKnownCount: z.number().int().nonnegative().optional(),
```

- [ ] **Step 12: Run test — expect PASS**

Run: `npx vitest run packages/contracts/src/model.test.ts -t "known counts"`
Expected: PASS.

- [ ] **Step 13: Extend domain ports in `packages/domain/src/ports.ts`**

Add `cachedInputTokens?` and `quotaUnits?` to `MetricsRepository.record` input (after `outputTokens?`):

```typescript
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    quotaUnits?: number;
    estimatedCostUsd?: number;
```

Add the `RouteConstraints` interface and extend `ModelRouter.route`. `ExecutorHealth` is already imported in this file:

```typescript
export interface RouteConstraints {
  /** Provider health keyed by provider id (e.g. 'claude'); rate-limited providers are excluded. */
  providerHealth?: ReadonlyMap<string, ExecutorHealth>;
  /** Remaining budget by unit. metered→maxCostUsd, subscription→maxQuotaUnits. */
  budget?: { maxCostUsd?: number; maxQuotaUnits?: number };
}

export interface ModelRouter {
  route(
    profile: TaskProfile,
    explicit?: ExplicitModelRoute,
    constraints?: RouteConstraints,
  ): Promise<RouteDecision>;
  catalog(): Promise<ModelDefinition[]>;
}
```

- [ ] **Step 14: Verify `UsageReport` is exported**

`packages/contracts/src/index.ts` — confirm `run.js` types are re-exported (`export * from './run.js'` or explicit). If explicit, add `UsageReport`, `UsageSourceQuality`. Run:
`grep -n "run.js" packages/contracts/src/index.ts`

- [ ] **Step 15: Full package build + typecheck (proves foundation is green alone)**

Run: `npm run typecheck && npx vitest run packages/contracts packages/domain`
Expected: PASS. No implementation package (executors/persistence/model-router) should break, because every field is optional.

- [ ] **Step 16: Commit**

```bash
git add packages/contracts packages/domain
git commit -m "feat(contracts): normalize usage report, provider rate limit, route constraints (#62)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Executor usage + rate-limit parsing (parallel after Task 1)

**Files:**

- Modify: `packages/executors/src/json-output.ts` (`extractUsage`, new `extractRateLimit`)
- Modify: `packages/executors/src/base-cli-executor.ts` (cache rate limit, surface in `health()`)
- Test: `packages/executors/src/json-output.test.ts`, `packages/executors/src/base-cli-executor.test.ts`
- Create: `packages/executors/src/fixtures/codex.partial-usage.stdout.jsonl`, `claude.partial-usage.stdout.json`, `agy.partial-usage.stdout.json`, `claude.rate-limited.stdout.json`

**Interfaces:**

- Consumes: `ExecutionUsage`/`UsageReport`, `ProviderRateLimit` from Task 1.
- Produces: `extractRateLimit(provider, raw): { limit?, remaining?, resetAt? } | undefined`; `extractUsage` now returns `sourceQuality: 'provider-reported'` and `quotaUnits?` when present.

- [ ] **Step 1: Create partial-usage fixtures**

`packages/executors/src/fixtures/claude.partial-usage.stdout.json` (output tokens + quota present, input/cost ABSENT):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "partial",
  "usage": { "output_tokens": 42, "quota_units": 2 }
}
```

`packages/executors/src/fixtures/codex.partial-usage.stdout.jsonl` (input tokens only):

```
{"type":"turn.completed","usage":{"input_tokens":15}}
```

`packages/executors/src/fixtures/agy.partial-usage.stdout.json` (cost only):

```json
{ "type": "result", "usage": { "total_cost_usd": 0.01 } }
```

`packages/executors/src/fixtures/claude.rate-limited.stdout.json` (rate-limit signal):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "ok",
  "usage": { "input_tokens": 1 },
  "rate_limit": { "limit": 100, "remaining": 0, "reset_at": "2026-07-18T13:00:00.000Z" }
}
```

- [ ] **Step 2: Write failing tests — partial usage stays unknown + sourceQuality**

Add to `packages/executors/src/json-output.test.ts`:

```typescript
import { extractRateLimit } from './json-output.js';

describe('extractUsage partial (issue #62)', () => {
  it('claude: keeps missing signals undefined and tags provider-reported', () => {
    const usage = extractUsage('claude', fixture('claude.partial-usage.stdout.json'));
    expect(usage).toEqual({
      outputTokens: 42,
      quotaUnits: 2,
      sourceQuality: 'provider-reported',
    });
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.estimatedCostUsd).toBeUndefined();
  });

  it('codex: input tokens only', () => {
    expect(extractUsage('codex', fixture('codex.partial-usage.stdout.jsonl'))).toEqual({
      inputTokens: 15,
      sourceQuality: 'provider-reported',
    });
  });

  it('agy: cost only', () => {
    expect(extractUsage('agy', fixture('agy.partial-usage.stdout.json'))).toEqual({
      estimatedCostUsd: 0.01,
      sourceQuality: 'provider-reported',
    });
  });

  it('returns undefined (not zeros) when no usage present', () => {
    expect(extractUsage('claude', 'no json here')).toBeUndefined();
  });
});

describe('extractRateLimit (issue #62)', () => {
  it('parses limit/remaining/reset from a provider result', () => {
    expect(extractRateLimit('claude', fixture('claude.rate-limited.stdout.json'))).toEqual({
      limit: 100,
      remaining: 0,
      resetAt: '2026-07-18T13:00:00.000Z',
    });
  });

  it('returns undefined when no rate-limit signal exists', () => {
    expect(extractRateLimit('codex', fixture('codex.partial-usage.stdout.jsonl'))).toBeUndefined();
  });
});
```

Also update the EXISTING `extractUsage` fixture expectations in this file: every `.toEqual({...})` for a real provider fixture now includes `sourceQuality: 'provider-reported'`. (Find them near the existing `describe('extractUsage')` block and add the field to each expected object.)

- [ ] **Step 3: Run tests — expect FAIL**

Run: `npx vitest run packages/executors/src/json-output.test.ts`
Expected: FAIL (`extractRateLimit` not exported; `sourceQuality` missing).

- [ ] **Step 4: Implement — `extractUsage` sourceQuality + quotaUnits in `json-output.ts`**

In `interface UsageAccumulator` and the `output` object in `extractUsage`, add `quotaUnits?: number`. In `collectUsage`, after the `cost` block, add quota parsing:

```typescript
const quota = numberFrom(record, ['quota_units', 'quotaUnits', 'quota', 'message_units']);
if (quota !== undefined) accumulator.quotaUnits = maxDefined(accumulator.quotaUnits, quota);
```

In `extractUsage`, after building `output`, before the return, tag provenance:

```typescript
if (accumulator.quotaUnits !== undefined) output.quotaUnits = accumulator.quotaUnits;
if (Object.keys(output).length === 0) return undefined;
return { ...output, sourceQuality: 'provider-reported' };
```

Update the `extractUsage` return type annotation and the `output` local type to include `quotaUnits?: number` and `sourceQuality?: 'provider-reported'`.

Add `extractRateLimit`:

```typescript
export function extractRateLimit(
  provider: Provider,
  raw: string,
): { limit?: number; remaining?: number; resetAt?: string } | undefined {
  for (const document of providerDocuments(raw)) {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) continue;
    const record = document as Record<string, unknown>;
    const rl = record.rate_limit ?? record.rateLimit;
    if (rl === null || typeof rl !== 'object' || Array.isArray(rl)) continue;
    const rlRecord = rl as Record<string, unknown>;
    const limit = numberFrom(rlRecord, ['limit', 'max']);
    const remaining = numberFrom(rlRecord, ['remaining', 'left']);
    const resetAt = stringFrom(rlRecord, ['reset_at', 'resetAt', 'reset']);
    if (limit === undefined && remaining === undefined && resetAt === undefined) continue;
    return {
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
      ...(resetAt !== undefined ? { resetAt } : {}),
    };
  }
  return undefined;
}
```

- [ ] **Step 5: Run tests — expect PASS**

Run: `npx vitest run packages/executors/src/json-output.test.ts`
Expected: PASS.

- [ ] **Step 6: Write failing test — base-cli surfaces cached rate limit via health()**

Add to `packages/executors/src/base-cli-executor.test.ts` a test that runs an execution whose stdout carries a rate-limit signal, then asserts a subsequent `health()` reports `rateLimit`. Follow the file's existing harness for constructing a `BaseCliExecutor` with a scripted command. Minimal shape:

```typescript
it('surfaces the last observed rate limit in health()', async () => {
  const executor = makeExecutorEmitting(fixture('claude.rate-limited.stdout.json')); // existing test helper pattern
  await executor.execute(sampleRequest());
  const health = await executor.health();
  expect(health.rateLimit).toEqual({
    limit: 100,
    remaining: 0,
    resetAt: '2026-07-18T13:00:00.000Z',
  });
});
```

If the existing test file has no reusable helper to script stdout, assert at the unit boundary instead: expose the caching by having `health()` merge `this.lastRateLimit`, and unit-test the merge by setting the field via a subclass in the test. Keep it to one assertion that fails before the implementation.

- [ ] **Step 7: Run test — expect FAIL**

Run: `npx vitest run packages/executors/src/base-cli-executor.test.ts -t "rate limit"`
Expected: FAIL.

- [ ] **Step 8: Implement — cache + surface rate limit in `base-cli-executor.ts`**

Add a private field and populate it after `extractUsage` in the run path:

```typescript
  private lastRateLimit: ProviderRateLimit | undefined;
```

After `const usage = extractUsage(this.provider, stdout);`:

```typescript
const rateLimit = extractRateLimit(this.provider, stdout);
if (rateLimit) this.lastRateLimit = rateLimit;
```

In `health()`, spread the cached value into the returned object (both success and non-available branches where sensible):

```typescript
        ...(this.lastRateLimit ? { rateLimit: this.lastRateLimit } : {}),
```

Add imports: `extractRateLimit` from `./json-output.js`, and `type ProviderRateLimit` from `@agent-foundry/contracts`.

- [ ] **Step 9: Run tests — expect PASS**

Run: `npx vitest run packages/executors/src/base-cli-executor.test.ts packages/executors/src/json-output.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add packages/executors
git commit -m "feat(executors): tag usage source quality, parse quota + rate limit (#62)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Persistence aggregation — unknown ≠ zero (parallel after Task 1)

**Files:**

- Modify: `packages/persistence/src/metrics-repository.ts` (`record`)
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts` (map `cachedInputTokens`, `quotaUnits` into `record`)
- Test: `packages/persistence/src/metrics-repository.test.ts`

**Interfaces:**

- Consumes: `ModelMetric` known-count fields + `record` input (`cachedInputTokens?`, `quotaUnits?`) from Task 1.
- Produces: aggregated `ModelMetric` where a total only grows on a defined sample and the matching `*KnownCount` increments.

- [ ] **Step 1: Write failing test — unknown sample does not inflate totals or counts**

Add to `packages/persistence/src/metrics-repository.test.ts`:

```typescript
it('does not invent zero: unknown tokens leave totals and counts untouched', async () => {
  const repo = new FileMetricsRepository(await mkdtempDir()); // use the file's existing temp-dir helper
  await repo.record({
    modelId: 'm',
    taskKind: 'implementation',
    role: 'developer',
    success: true,
    durationMs: 10,
    inputTokens: 100, // no output/cost/quota
  });
  await repo.record({
    modelId: 'm',
    taskKind: 'implementation',
    role: 'developer',
    success: true,
    durationMs: 10, // nothing known
  });
  const metric = await repo.get('m', 'implementation', 'developer');
  expect(metric?.totalInputTokens).toBe(100);
  expect(metric?.inputTokensKnownCount).toBe(1); // only the first sample knew input
  expect(metric?.outputTokensKnownCount).toBeUndefined(); // never known → undefined, not 0
  expect(metric?.totalOutputTokens).toBe(0); // sum of zero known samples
});

it('sums quota units and counts known quota samples', async () => {
  const repo = new FileMetricsRepository(await mkdtempDir());
  await repo.record({
    modelId: 'q',
    taskKind: 'implementation',
    role: 'developer',
    success: true,
    durationMs: 5,
    quotaUnits: 3,
  });
  const metric = await repo.get('q', 'implementation', 'developer');
  expect(metric?.quotaUnitsTotal).toBe(3);
  expect(metric?.quotaUnitsKnownCount).toBe(1);
});
```

(If the test file lacks a temp-dir helper, use `mkdtemp(join(tmpdir(), 'metrics-'))` from `node:fs/promises` + `node:os`.)

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run packages/persistence/src/metrics-repository.test.ts -t "invent zero"`
Expected: FAIL (`inputTokensKnownCount` undefined; `quotaUnitsTotal` undefined).

- [ ] **Step 3: Implement — accumulate defined-only + counts in `record`**

Add a helper near the top of the class module:

```typescript
function bumpKnown(existing: number | undefined, value: number | undefined): number | undefined {
  return value === undefined ? existing : (existing ?? 0) + 1;
}
```

In `record`'s `update` callback, replace the three token/cost lines and add quota + counts:

```typescript
        totalInputTokens: (existing?.totalInputTokens ?? 0) + (input.inputTokens ?? 0),
        totalOutputTokens: (existing?.totalOutputTokens ?? 0) + (input.outputTokens ?? 0),
        totalEstimatedCostUsd:
          (existing?.totalEstimatedCostUsd ?? 0) + (input.estimatedCostUsd ?? 0),
        ...(bumpKnown(existing?.inputTokensKnownCount, input.inputTokens) !== undefined
          ? { inputTokensKnownCount: bumpKnown(existing?.inputTokensKnownCount, input.inputTokens) }
          : {}),
        ...(bumpKnown(existing?.outputTokensKnownCount, input.outputTokens) !== undefined
          ? { outputTokensKnownCount: bumpKnown(existing?.outputTokensKnownCount, input.outputTokens) }
          : {}),
        ...(bumpKnown(existing?.cachedInputTokensKnownCount, input.cachedInputTokens) !== undefined
          ? { cachedInputTokensKnownCount: bumpKnown(existing?.cachedInputTokensKnownCount, input.cachedInputTokens) }
          : {}),
        ...(bumpKnown(existing?.costKnownCount, input.estimatedCostUsd) !== undefined
          ? { costKnownCount: bumpKnown(existing?.costKnownCount, input.estimatedCostUsd) }
          : {}),
        ...(input.quotaUnits !== undefined || existing?.quotaUnitsTotal !== undefined
          ? { quotaUnitsTotal: (existing?.quotaUnitsTotal ?? 0) + (input.quotaUnits ?? 0) }
          : {}),
        ...(bumpKnown(existing?.quotaUnitsKnownCount, input.quotaUnits) !== undefined
          ? { quotaUnitsKnownCount: bumpKnown(existing?.quotaUnitsKnownCount, input.quotaUnits) }
          : {}),
```

Also carry the counts through the `recordQuality` update (which rebuilds the metric): add `...(existing?.inputTokensKnownCount !== undefined ? { inputTokensKnownCount: existing.inputTokensKnownCount } : {})` for each new field, or spread `existing` known fields. Simplest: after building the base object in `recordQuality`, spread the six preserved fields from `existing`.

> Note (totals kept simple): `totalInputTokens`/`totalOutputTokens`/`totalEstimatedCostUsd` still add `?? 0` for the sum, which is arithmetically correct (adding a zero for an unknown sample does not change the sum). The honesty guarantee comes from the `*KnownCount`: a total of `0` with count `undefined` means "never observed", not "observed zero". `ponytail: known-counts are the unknown/zero discriminator; no per-field nullable totals.`

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run packages/persistence/src/metrics-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Map cached + quota into `record` at the orchestrator call site**

In `packages/orchestrator/src/workflow-orchestrator.ts`, in the `this.metrics.record({...})` call (currently maps input/output/cost), add:

```typescript
      ...(result.usage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: result.usage.cachedInputTokens }
        : {}),
      ...(result.usage?.quotaUnits !== undefined ? { quotaUnits: result.usage.quotaUnits } : {}),
```

- [ ] **Step 6: Run orchestrator tests + typecheck**

Run: `npx vitest run packages/orchestrator packages/persistence && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/persistence packages/orchestrator
git commit -m "feat(persistence): aggregate usage without inventing zero; track quota (#62)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Router budget + rate-limit exclusion (parallel after Task 1)

**Files:**

- Modify: `packages/model-router/src/score-router.ts` (`route`, new rejection reasons)
- Test: `packages/model-router/src/score-router.test.ts`

**Interfaces:**

- Consumes: `RouteConstraints`, `ExecutorHealth` (with `rateLimit`) from Task 1.
- Produces: `route(profile, explicit?, constraints?)` that pushes `rate-limited …` / `over-budget …` into `RouteDecision.rejected[]` and never selects an excluded model.

- [ ] **Step 1: Write failing test — rate-limited provider excluded, budget enforced**

Add to `packages/model-router/src/score-router.test.ts` (reuse the file's catalog/`InMemoryMetrics` helpers):

```typescript
it('excludes a model whose provider is rate-limited until a future reset', async () => {
  const router = new ScoreBasedModelRouter(twoProviderCatalog(), new InMemoryMetrics());
  const health = new Map([
    [
      'claude',
      {
        provider: 'claude',
        available: true,
        message: 'ok',
        rateLimit: { remaining: 0, resetAt: '2999-01-01T00:00:00.000Z' },
      },
    ],
  ]);
  const decision = await router.route(implementationProfile(), undefined, {
    providerHealth: health,
  });
  expect(decision.selected.model.provider).not.toBe('claude');
  expect(decision.rejected.some((r) => r.reason.startsWith('rate-limited'))).toBe(true);
});

it('rejects a metered model that exceeds the cost budget', async () => {
  const router = new ScoreBasedModelRouter(twoProviderCatalog(), new InMemoryMetrics());
  const decision = await router.route(implementationProfile(), undefined, {
    budget: { maxCostUsd: 0 },
  });
  // every metered model estimates > $0 → rejected; a subscription/no-pricing model may remain
  expect(decision.rejected.some((r) => r.reason.startsWith('over-budget'))).toBe(true);
});

it('ignores absent constraints (unchanged behavior)', async () => {
  const router = new ScoreBasedModelRouter(twoProviderCatalog(), new InMemoryMetrics());
  const a = await router.route(implementationProfile());
  const b = await router.route(implementationProfile(), undefined, {});
  expect(b.selected.model.id).toBe(a.selected.model.id);
});
```

(Add `twoProviderCatalog()` / `implementationProfile()` helpers if the file lacks them, mirroring existing test fixtures — at least one metered model with `pricing`, one `subscription` model.)

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run packages/model-router/src/score-router.test.ts -t "rate-limited|budget|absent constraints"`
Expected: FAIL (third arg ignored; `rate-limited`/`over-budget` reasons absent).

- [ ] **Step 3: Implement — apply constraints in `score-router.ts`**

Import `RouteConstraints` from `@agent-foundry/domain`. Change the signature and thread it into the reject loop:

```typescript
  async route(
    profile: TaskProfile,
    explicit?: ExplicitModelRoute,
    constraints?: RouteConstraints,
  ): Promise<RouteDecision> {
```

In the `for (const model of this.models)` loop, after the existing `this.rejectReason` check, add a constraint check that can also reject:

```typescript
const constraintRejection = this.constraintRejection(model, profile, metric, constraints);
```

But `metric` is fetched after `rejectReason`. Restructure: fetch `metric` first (it is needed for cost estimate), then check both reject reasons. Minimal change — move the `const metric = await this.metrics.get(...)` above the rejection checks, then:

```typescript
const rejection =
  this.rejectReason(model, profile) ??
  this.constraintRejection(model, profile, metric, constraints);
if (rejection) {
  rejected.push({ modelId: model.id, reason: rejection });
  continue;
}
ranked.push({ model, score: this.score(model, profile, metric) });
```

Add the method (uses the same `estimateCostUsd` helper already in the file):

```typescript
  private constraintRejection(
    model: ModelDefinition,
    profile: TaskProfile,
    metric: ModelMetric | null,
    constraints?: RouteConstraints,
  ): string | null {
    if (!constraints) return null;
    const health = constraints.providerHealth?.get(model.provider);
    const rl = health?.rateLimit;
    if (rl && rl.remaining === 0 && rl.resetAt && new Date(rl.resetAt).getTime() > Date.now()) {
      return `rate-limited until ${rl.resetAt}`;
    }
    const budget = constraints.budget;
    if (budget) {
      if (budget.maxCostUsd !== undefined && model.billingMode === 'metered') {
        const estimate = estimateCostUsd(model, profile, metric);
        if (estimate !== null && estimate > budget.maxCostUsd) {
          return `over-budget: est $${estimate.toFixed(4)} > $${budget.maxCostUsd}`;
        }
      }
      if (budget.maxQuotaUnits !== undefined && budget.maxQuotaUnits <= 0 &&
          model.billingMode === 'subscription') {
        return 'over-budget: no quota units remaining';
      }
    }
    return null;
  }
```

Import `ModelDefinition`, `ModelMetric` are already imported. Add `RouteConstraints` to the `@agent-foundry/domain` import.

> `ponytail: subscription budget is a coarse gate (maxQuotaUnits<=0 blocks all subscription use) because there is no per-model pre-run quota estimate; upgrade to a per-model quota estimator when catalog carries quota costs.`

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run packages/model-router/src/score-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/model-router
git commit -m "feat(model-router): budget + rate-limit aware routing (#62)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: UI — observed vs estimated (parallel after Task 1)

**Files:**

- Create: `apps/web/app/project/[id]/format-usage.ts` (pure formatter)
- Test: `apps/web/app/project/[id]/format-usage.test.ts`
- Modify: `apps/web/app/project/[id]/page.tsx` (render observed usage on each attempt row)

**Interfaces:**

- Consumes: `ExecutionUsage`/`UsageReport` from Task 1 (via `@agent-foundry/contracts`).
- Produces: `formatObservedUsage(usage?): string` → human string with `desconhecido` for absent fields.

- [ ] **Step 1: Write failing test — formatter renders unknown, never zero**

`apps/web/app/project/[id]/format-usage.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { formatObservedUsage } from './format-usage.js';

describe('formatObservedUsage', () => {
  it('shows observed fields and source quality', () => {
    expect(
      formatObservedUsage({ inputTokens: 10, outputTokens: 5, sourceQuality: 'provider-reported' }),
    ).toBe('in 10 · out 5 · fonte provider-reported');
  });

  it('renders desconhecido for absent usage', () => {
    expect(formatObservedUsage(undefined)).toBe('observado: desconhecido');
  });

  it('never prints zero for a missing field', () => {
    const text = formatObservedUsage({ inputTokens: 7 });
    expect(text).not.toContain('out 0');
    expect(text).toContain('in 7');
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npx vitest run apps/web/app/project/[id]/format-usage.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement — `format-usage.ts`**

```typescript
import type { ExecutionUsage } from '@agent-foundry/contracts';

export function formatObservedUsage(usage: ExecutionUsage | undefined): string {
  if (!usage) return 'observado: desconhecido';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`);
  if (usage.cachedInputTokens !== undefined) parts.push(`cache ${usage.cachedInputTokens}`);
  if (usage.quotaUnits !== undefined) parts.push(`quota ${usage.quotaUnits}`);
  if (usage.estimatedCostUsd !== undefined) parts.push(`$${usage.estimatedCostUsd}`);
  if (usage.sourceQuality !== undefined) parts.push(`fonte ${usage.sourceQuality}`);
  return parts.length ? parts.join(' · ') : 'observado: desconhecido';
}
```

- [ ] **Step 4: Run test — expect PASS**

Run: `npx vitest run apps/web/app/project/[id]/format-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Render observed usage on the attempt row in `page.tsx`**

Import at top: `import { formatObservedUsage } from './format-usage.js';`

In the attempt `.map((attempt) => {...})` block (the `<div key={attempt.id}>` row), after the failed-error `<small>`, add:

```tsx
<small style={{ display: 'block', opacity: 0.75 }}>{formatObservedUsage(attempt.usage)}</small>
```

This puts observed usage next to the existing estimated cost (`custo estimado` in the route-decision card), satisfying "estimado versus observado".

- [ ] **Step 6: Typecheck + web lint**

Run: `npm run typecheck && npx eslint apps/web/app/project/[id]/format-usage.ts apps/web/app/project/[id]/page.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web
git commit -m "feat(web): show observed usage vs estimated on run attempts (#62)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final integration (after Tasks 1–5)

- [ ] **Step 1: Full CI gate**

Run: `npm run check`
Expected: PASS (format, lint, architecture, roadmap, typecheck, test, build).

- [ ] **Step 2: e2e**

Run the repo's e2e command (see `package.json` / `docs/VALIDATION.md`). Expected: PASS.

- [ ] **Step 3: Update evidence in the design/DoD**

Attach test output + a note that each acceptance criterion maps to a task (see Self-Review below).

---

## Self-Review (spec coverage)

| Issue acceptance criterion                                          | Task                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| UsageReport: in/out/cache tokens, cost, quota units, source quality | Task 1 (schema) + Task 2 (populate)                                         |
| Missing data unknown, never zero                                    | Task 1 (optional fields) + Task 2 (undefined not 0) + Task 3 (known-counts) |
| Rate limit + reset in ProviderHealth                                | Task 1 (`ExecutorHealth.rateLimit`) + Task 2 (parse/surface)                |
| Router applies budget by available unit                             | Task 1 (`RouteConstraints`) + Task 4 (enforce)                              |
| UI estimated vs observed                                            | Task 5                                                                      |
| Partial-usage fixtures for Codex/Claude/AGY                         | Task 2                                                                      |
| Evidence, security, migration, rollback                             | Design doc + Final integration                                              |

**Placeholder scan:** none — every code step shows real code.
**Type consistency:** `formatObservedUsage`, `extractRateLimit`, `RouteConstraints`, `bumpKnown`, `ProviderRateLimit`, `UsageReport` used identically across the tasks that reference them.
