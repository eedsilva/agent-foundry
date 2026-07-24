# Exploration, circuit breakers, and provider health in the model router

Issue: [#66](https://github.com/eedsilva/agent-foundry/issues/66) — adaptive routing:
exploration + circuit breakers + provider health.

## Problem

`ScoreBasedModelRouter` picked the top-scoring model on every call (greedy argmax
over `RouteScoreBreakdown.total`). Two gaps followed from that:

- **No learning pressure.** A model that scored slightly below the leader could
  never accumulate fresh `ModelMetric` samples, even if its true performance was
  close or better — the router only ever exercised the incumbent.
- **No hard gate for degraded providers.** The only signal against a struggling
  model was a soft `recentFailurePenalty` inside `score()`
  (`Math.min(0.3, metric.consecutiveFailures * 0.075)`, capped at -0.3 to the
  `reliability` term). A provider that was rate-limited, reported unavailable by
  its executor's health probe, or had degraded past the failure penalty's cap
  could still be selected — the penalty shapes ranking, it never excludes.

Issue #66 asked for two independent, additive capabilities: (1) a circuit breaker
that excludes a degraded provider outright, derived from data the router already
reads (`ModelMetric`, `ExecutorHealth`) with no new persistence; and (2) an opt-in
epsilon-greedy exploration policy that occasionally samples a non-top candidate,
with a hard-coded rule that sensitive tasks never explore.

## Design

### Circuit breaker — derived, not persisted

`packages/model-router/src/circuit-breaker.ts` exports a pure function:

```ts
evaluateBreaker(metric: ModelMetric | null, health: ExecutorHealth | undefined,
  config: CircuitBreakerConfig, now: Date): BreakerResult
```

`BreakerResult` is `{ state: 'closed' | 'open' | 'half-open', reason?: string }`.
The function checks four conditions in a fixed priority order and returns on the
first match:

1. **Unavailable health** — `health.available === false` → `open`.
2. **Rate-limited** — `health.rateLimit.resetAt` in the future and
   `remaining` is `0` or `undefined` → `open`.
3. **Consecutive failures** — `metric.consecutiveFailures >= failureThreshold`
   → `open`, unless `metric.lastFailureAt` is more than `cooldownMs` in the past,
   in which case → `half-open` (one probe attempt is allowed through).
4. **Latency ceiling** — `metric.attempts >= latencyMinAttempts` and average
   duration (`totalDurationMs / attempts`) exceeds `latencyCeilingMs` → `open`,
   with the same cooldown-based `half-open` relaxation as (3).

Anything else → `closed`. `DEFAULT_BREAKER_CONFIG` is `{ failureThreshold: 5,
cooldownMs: 60_000, latencyCeilingMs: 15 * 60_000, latencyMinAttempts: 3 }`.

`ScoreBasedModelRouter.route()` (`score-router.ts`) calls `evaluateBreaker` for
every candidate right after fetching its metric, before scoring:

```ts
const breaker = evaluateBreaker(metric, health, this.breakerConfig, new Date());
if (breaker.state === 'open') {
  rejected.push({ modelId: model.id, reason: `circuit-open: ${breaker.reason}` });
  continue;
}
```

An `open` breaker removes the model from consideration entirely — it cannot land
in `selected` or `fallbacks`, only in `rejected[]` with a `circuit-open: <reason>`
message. A `half-open` breaker does **not** reject: the candidate is scored and
ranked normally, so a probe attempt happens through the router's normal selection
path rather than a dedicated retry mechanism.

**Why derived state, not a persisted breaker store.** A stateful breaker (its own
table tracking open/half-open/closed transitions and timestamps) would need a new
write path fired from wherever executions report outcomes, plus migration and
reconciliation if that path is ever missed. The derived approach reads only
`ModelMetric` (already written by `MetricsRepository.record()` on every attempt)
and `ExecutorHealth` (already polled for existing rate-limit/budget checks). Half-open
recovery falls out "for free": the next real attempt against a half-open provider
updates `consecutiveFailures` and `lastFailureAt` through the existing metrics-write
path exactly like any other attempt — there is no separate breaker-state write, and
so no way for breaker state to drift from what actually happened.

### Exploration — opt-in epsilon-greedy

`packages/model-router/src/exploration.ts` exports:

```ts
effectiveEpsilon(policy: ExplorationPolicy, profile: TaskProfile): number
chooseExploration(ranked: RankedModel[], epsilon: number, random: () => number): ExplorationChoice
```

`effectiveEpsilon` applies the sensitivity rule first, unconditionally:

```ts
function isSensitive(profile: TaskProfile): boolean {
  return (
    profile.risk >= 4 ||
    profile.mutatesWorkspace === true ||
    profile.toolPolicy === 'workspace-write'
  );
}
```

If any of the three is true, `effectiveEpsilon` returns `0` regardless of the
configured `ExplorationPolicy` — this is a locked product decision, not something
a policy can override. Otherwise it returns
`policy.perTaskKind?.[profile.taskKind] ?? policy.baseRate`, clamped to `[0, 1]`.

`chooseExploration` is a standard epsilon-greedy pick over the already
score-sorted `ranked` array: with probability `1 - epsilon` it returns index `0`
(the incumbent); otherwise it draws a second random number to pick uniformly among
indices `1..ranked.length-1` — it never re-picks index `0` when exploring. `random`
is injected (`() => number`) so tests are deterministic; `Math.random` is the
default in production. Edge cases return index `0` without calling `random` at
all: a single-candidate or empty `ranked` array, or `epsilon <= 0`.

`ScoreBasedModelRouter.route()` only takes this path when both conditions hold —
no explicit pin, and an `explorationPolicy` was passed to the constructor:

```ts
if (explicit || !this.explorationPolicy) {
  selected = ranked[0];
} else {
  const epsilon = effectiveEpsilon(this.explorationPolicy, profile);
  const { index, reason } = chooseExploration(ranked, epsilon, this.random);
  selected = ranked[index];
  explorationResult = { explored: index > 0, rate: epsilon, reason };
}
```

The `exploration` field on `RouteDecision` (`explored`, `rate`, `reason`) is only
ever attached when this branch runs — an explicit pin or an unconfigured policy
produces a `RouteDecision` with no `exploration` key at all, byte-identical to
pre-#66 behavior, not `exploration: undefined`-shaped-but-present.

**Why opt-in, off by default in production.** This is a single-operator tool —
there is no fleet of users to average surprise-worse-model picks against, and a
silent regression from an exploratory pick has no A/B safety net. Production
wiring (`packages/composition/src/runtime.ts`) passes `{ breaker:
DEFAULT_BREAKER_CONFIG }` and deliberately omits `exploration`, so exploration is
inert until someone opts in explicitly. The breaker has no equivalent opt-out: it
is purely protective (it can only remove already-degraded candidates, never
degrade the outcome versus greedy selection when nothing is broken), so it is
unconditionally wired on.

### Sequencing inside `route()`

Breaker evaluation happens per-candidate during the ranking loop (a hard gate,
before a model is scored and pushed onto `ranked`). Exploration happens once,
after `ranked` is fully built and sorted. This means exploration can only ever
choose among candidates the breaker has already let through — an open-breaker
model is never explorable.

## Alternatives considered

- **Persisted breaker state machine.** A table storing `state` +
  `sinceAt`/`nextProbeAt` per model, transitioned by dedicated writes on success/
  failure. Rejected: more moving parts (new schema, new write path, reconciliation
  on missed writes) for no clear benefit over derived state at this project's
  scale — a single operator, no need for cross-process breaker-state
  coordination.
- **UCB / Thompson sampling instead of epsilon-greedy.** Both give principled
  exploration that adapts its rate to confidence, at the cost of extra state
  (visit counts or posterior parameters per arm) and more subtle tuning.
  Rejected for now: epsilon-greedy is simpler to reason about and audit (a fixed,
  configurable rate with a hard sensitivity override) and sufficient for a
  personal tool's routing volume. Revisit if routing data volume grows enough
  that a fixed epsilon becomes visibly wasteful.

## Testing

- `packages/model-router/src/circuit-breaker.test.ts` — pure-function unit tests
  for `evaluateBreaker`: absent metric/health, each of the four trip conditions
  individually, the half-open cooldown transition for both consecutive-failures
  and latency, and three "priority ordering" tests asserting unavailable-health
  beats rate-limit beats consecutive-failures beats latency when more than one
  condition is true simultaneously.
- `packages/model-router/src/exploration.test.ts` — unit tests for
  `effectiveEpsilon` (all three sensitivity triggers individually, per-task-kind
  override, fallback to `baseRate`, clamping both directions) and
  `chooseExploration` (single/empty candidate list, `epsilon === 0` never calling
  `random`, greedy vs. explore branch selection, and two exact-index assertions
  with a deterministic `random` stub).
- `packages/model-router/src/score-router.test.ts` — five integration tests added
  under "Task 4: circuit breaker + exploration wiring (issue #66)":
  excludes a degraded (unavailable) provider from both `selected` and
  `fallbacks` with a `circuit-open:` rejection reason; explores a non-top
  candidate on a low-risk profile when a policy is configured; stays greedy on a
  high-risk (sensitive) profile even with the same policy configured; never
  attaches an `exploration` field when no policy is configured; never explores an
  explicit-pin route even with a policy configured.

See the ADR ([0034](../../adr/0034-router-circuit-breaker-and-exploration.md)) for
the accepted-decision record and rollback path.
