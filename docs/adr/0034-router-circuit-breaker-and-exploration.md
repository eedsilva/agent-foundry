# ADR 0034: Derived circuit breaker and opt-in epsilon-greedy exploration in the model router

- Status: Accepted
- Date: 2026-07-23
- Owners: model-router

## Context

`ScoreBasedModelRouter` always selected the top-scoring candidate (greedy argmax
over `RouteScoreBreakdown.total`). The only signal against a degraded provider was
a soft penalty inside scoring — `recentFailurePenalty = Math.min(0.3,
metric.consecutiveFailures * 0.075)`, subtracted from `reliability` — which shapes
ranking but can never exclude a model outright. A provider reported unavailable by
its executor's health probe, rate-limited, or run past the failure penalty's -0.3
cap could still be selected. Separately, always picking the top score means the
router never gathers fresh `ModelMetric` samples on close alternatives, so ranking
can only ever reinforce the current incumbent.

Issue #66 asked for a hard gate against degraded providers and an opt-in mechanism
to occasionally sample a non-top candidate, without ever doing so on
sensitive (high-risk or workspace-mutating) tasks.

## Decision

Add two new pure-function modules to `packages/model-router/src/` and wire both
into `ScoreBasedModelRouter.route()` (`score-router.ts`) as an optional 4th
constructor argument `{ breaker?, exploration?, random? }`.

**Circuit breaker** (`circuit-breaker.ts`): `evaluateBreaker(metric, health,
config, now)` is computed fresh on every `route()` call from the same
`ModelMetric` (via `MetricsRepository.get()`) and `ExecutorHealth` (via
`RouteConstraints.providerHealth`) the router already reads — no new persisted
state. It returns `closed | open | half-open`, checking in priority order:
unavailable health → rate-limited → consecutive failures at or above
`failureThreshold` → average latency exceeding `latencyCeilingMs` (with a
`latencyMinAttempts` floor so one slow cold start can't trip it) → closed. A
failure- or latency-based trip moves from `open` to `half-open` once
`cooldownMs` has elapsed since `metric.lastFailureAt`, allowing exactly one probe
attempt through scoring. `DEFAULT_BREAKER_CONFIG = { failureThreshold: 5,
cooldownMs: 60_000, latencyCeilingMs: 15 * 60_000, latencyMinAttempts: 3 }`.
In `route()`, `open` is a hard gate evaluated per candidate before scoring: the
model is pushed to `rejected[]` with reason `circuit-open: <reason>` and excluded
from both `selected` and `fallbacks`. `half-open` is not a gate — the candidate is
scored and ranked normally, so recovery is probed through the router's normal
selection path.

**Exploration** (`exploration.ts`): `effectiveEpsilon(policy, profile)` returns
`0` whenever `profile.risk >= 4 || profile.mutatesWorkspace === true ||
profile.toolPolicy === 'workspace-write'` — this sensitivity rule is
unconditional and not policy-configurable. Otherwise it returns
`policy.perTaskKind?.[profile.taskKind] ?? policy.baseRate`, clamped to `[0, 1]`.
`chooseExploration(ranked, epsilon, random)` is epsilon-greedy over the
already score-sorted candidates: with probability `1 - epsilon` (or whenever
`epsilon <= 0` or fewer than 2 candidates exist) it keeps index `0`; otherwise it
draws again to pick uniformly among indices `1..length-1`, never re-picking index
`0`. `random` is injected (default `Math.random`) so tests are deterministic.
`route()` only takes this branch when there is no explicit pin and an
`explorationPolicy` was configured; otherwise selection stays byte-identical to
pre-#66 behavior including the absence of the `exploration` key on the result.

`RouteDecisionSchema` (`packages/contracts/src/model.ts`) gains an optional
`.strict()` `exploration: { explored: boolean, rate: number (0-1), reason: string
}` field, set only on the policy-configured, non-pin branch.

Production wiring (`packages/composition/src/runtime.ts`) constructs
`ScoreBasedModelRouter` with no 4th argument at all: the breaker is on
unconditionally because the constructor's own `DEFAULT_BREAKER_CONFIG` merge
applies whenever `options.breaker` is omitted, and `exploration` stays opt-in
and off by default because nothing configures it.

## Alternatives considered

- **Persisted breaker state machine** — a table tracking `state` and transition
  timestamps per model, written on every execution outcome. Rejected: more
  moving parts (schema, write path, reconciliation risk if a write is missed) for
  no benefit over derived state at this project's scale (single operator, no
  cross-process breaker coordination need). Derived state also gets half-open
  recovery for free: the next attempt against a half-open provider updates
  `consecutiveFailures`/`lastFailureAt` through the metrics-write path that
  already exists for every attempt.
- **UCB / Thompson sampling instead of epsilon-greedy** — adapts exploration rate
  to confidence automatically, at the cost of extra per-model state (visit
  counts or posterior parameters) and subtler tuning. Rejected for now:
  epsilon-greedy is simpler to reason about and audit, and sufficient for this
  tool's routing volume; revisit if routing data volume grows enough that a fixed
  rate becomes visibly wasteful.

## Consequences

**Positive:** a genuinely unavailable, rate-limited, failure-prone, or
slow provider can no longer be selected or offered as a fallback, closing a real
gap the soft penalty left open. Exploration, when an operator opts in, lets the
router gather fresh signal on close alternatives instead of only ever reinforcing
the incumbent, while sensitive tasks are structurally excluded from ever being
routed to a non-top pick.

**Negative:** a provider that is merely `half-open` still competes normally in
scoring — there is no dedicated single-probe-then-decide state machine, so a
flaky half-open provider could in principle be picked repeatedly if it keeps
scoring above threshold while still occasionally failing. This is accepted as
consistent with "derived, no new state": a repeated half-open failure keeps
`consecutiveFailures` rising and eventually reopens the breaker via the
existing metrics path.

**Migration:** none. `exploration` is optional and `.strict()`-additive on
`RouteDecisionSchema`; existing persisted `RouteDecision` records without the
field parse unchanged. `ScoreBasedModelRouter`'s new constructor argument is
optional; existing 3-arg construction sites (including production's) remain
source-compatible and now have the circuit breaker active by default (via the
constructor's internal `DEFAULT_BREAKER_CONFIG` merge) — this is the intended
always-on protective behavior, not a regression. No exploration policy means
no exploration branch is ever taken.

**Operational:** no new persisted state, no new background job, no new
configuration surface beyond the two optional constructor fields. `rejected[]`
reasons (`circuit-open: <reason>`) and `exploration.reason` are both
human-readable strings, sufficient to diagnose a routing decision without
reproducing it.

**Security:** no new external input. `evaluateBreaker` and `chooseExploration`
consume only already-trusted internal `ModelMetric`/`ExecutorHealth`/`TaskProfile`
data; neither logs nor persists anything itself.

## Validation and rollback

Validated by `circuit-breaker.test.ts` (trip conditions, priority ordering,
half-open cooldown transitions), `exploration.test.ts` (sensitivity rule,
per-task-kind override, clamping, deterministic-random branch selection), and
five integration tests in `score-router.test.ts` covering the wired-together
behavior end to end (circuit-open exclusion, low-risk explore, high-risk stays
greedy, no policy means no `exploration` field, explicit pin never explores).

Rollback is a straight code revert of this branch's commits — both new modules
are additive and optional at every call site, so no data migration is needed
either direction. To disable the breaker in production without a full revert,
pass an unreachable config explicitly (e.g. `{ breaker: { failureThreshold:
Infinity, ... } }`) to the `ScoreBasedModelRouter` construction in
`packages/composition/src/runtime.ts` — omitting the option, the current
state, does not disable it, since the constructor's own
`DEFAULT_BREAKER_CONFIG` merge applies whenever `options.breaker` is absent.
