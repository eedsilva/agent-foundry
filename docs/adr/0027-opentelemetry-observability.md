# ADR 0027: OpenTelemetry traces, metrics, and correlated logs

- Status: Accepted
- Date: 2026-07-21
- Owners: Orchestrator and API

## Context

Issue #58 asks for end-to-end correlated observability: one trace connecting HTTP request → queue
job → run → step → attempt → CLI execution → preview; metrics for latency, success, retries, queue
wait, token usage, and sandbox/preview utilization; structured logs carrying correlation IDs;
PII/secret filtering before export; and sampling that never silently drops an error or a slow run.
Before this work, the only observability surfaces were local: `events.jsonl`, `DATA_DIR/runs/`,
`run-*` artifacts, and `metrics/models.json` for routing — none of them connect a request to the
async work it eventually causes across the job queue, and none export anywhere.

Two existing constraints shaped the design. First, `scripts/check-architecture.mjs` enforces strict
package boundaries (`domain` depends only on `contracts`; `orchestrator`/`executors` depend on
`domain`; only `apps/*` may depend on `composition`), so wherever the SDK lives, every package that
creates spans cannot also carry SDK weight. Second, this is a self-hosted, single-operator project
(see `agent-foundry-project-goal`): there is no bundled collector, no managed backend, and the
answer has to work with "endpoint unset" as the common case, not the exception.

## Decision

**API-only instrumentation, composition-only SDK.** `packages/domain/src/tracing.ts` wraps
`@opentelemetry/api` in a `withSpan(name, attributes, fn)` helper plus
`serializeTraceContext`/`withExtractedContext`/`currentTraceIds`. Every call site —
`packages/orchestrator`, `packages/executors`, `apps/api` — depends only on `@opentelemetry/api`
and this helper, never on an SDK package. `@opentelemetry/api`'s own default implementation is a
no-op tracer/meter, so every `withSpan` call and every `telemetry-metrics.ts` helper
(`recordRunDuration`, `recordStepRetry`, `recordQueueWait`, `recordTokenUsage`,
`recordPreviewSessions`) does nothing — no throw, no allocation beyond the call itself — until
something registers a real provider. That registration happens in exactly one place:
`packages/composition/src/telemetry.ts`'s `startTelemetry`, called from `apps/api/src/index.ts` and
`apps/worker/src/index.ts` at boot. `OTEL_EXPORTER_OTLP_ENDPOINT` unset is the switch: `startTelemetry`
returns an inert handle and registers nothing. This keeps every instrumented package's dependency
footprint identical whether or not telemetry is ever turned on, and it means the inert path doesn't
need special-casing at call sites — it's the same code path as the instrumented one, just backed by
the API's own no-ops.

**Span taxonomy** (exact attribute names are the contract other code and dashboards key off):
`foundry.request` (API `onRequest`/`onResponse` hooks, app-level — covers every route except
SSE `/stream` routes, which `reply.hijack()` and would leak a span that never sees `onResponse`),
`foundry.job` (worker, per dequeued job), `foundry.run` (per workflow run), `foundry.step` (per
workflow node), `foundry.attempt` (per step attempt, carries model/provider), `foundry.cli`
(command name only, around the CLI child process — no args, no prompt text), `foundry.operation`
(chat/build operations), `foundry.preview` (preview session start). `foundry.job`, `foundry.run`,
`foundry.step`, and `foundry.attempt` nest under one trace; `foundry.operation` and `foundry.preview`
are separate roots for their own flows.

**Queue trace propagation via a schema carrier field, not a side channel.** `QueueJob` gained an
optional `traceContext: z.record(z.string(), z.string())` field. `project-service.ts` and
`operation-service.ts` call `serializeTraceContext()` (W3C `traceparent` via
`propagation.inject`) when enqueueing and attach it only if non-empty (respects
`exactOptionalPropertyTypes`); `worker-loop.ts` calls `withExtractedContext(job.traceContext, …)`
before opening `foundry.job`, so the job's span is a child of whatever span was active at enqueue
time and the two processes share one `traceId`. No new transport, no message broker feature — the
carrier rides in the same job record that already crosses the process boundary.

**Export-side redaction is the only filter point.** `RedactingSpanExporter` wraps whatever OTLP
exporter is configured and runs every string attribute, the status message, and every span event's
name/attributes (including `exception.message`/`exception.stacktrace` from `span.recordException`)
through `redactString` — the same filter `events.jsonl` and artifacts already use — before handing
spans to the delegate exporter. No other exporter or processor is registered, so there is exactly
one place a string can leave the process on a span. Call sites are not trusted to redact
individually; `foundry.cli`'s "command name only, never args" rule is defense in depth, not the
primary control.

**Sampling keeps errors and slow runs through two layers, not one.** `OTEL_TRACES_SAMPLER_RATIO`
feeds a `TraceIdRatioBased` root sampler wrapped by `KeepErrorsSampler`. A span whose _initial_
attributes carry `foundry.force_sample: true` (retry attempts beyond the first, known at span
creation) is always `RECORD_AND_SAMPLED`. Every other span the ratio sampler would have dropped is
downgraded only to `RECORD` — never `NOT_RECORD` — so `setStatus`/`setAttribute` on it during
execution are not silent no-ops. This matters because most of what needs keeping (an operation or
run that _becomes_ an error, or turns out to run past `OTEL_SLOW_RUN_THRESHOLD_MS`) is only known
reactively, in a catch block or at span end, after the head-sampling decision already happened.
`TailSpanProcessor` is where that reactive knowledge gets used: at `onEnd`, if the span wasn't
already head-sampled, it checks `status.code === ERROR`, `foundry.force_sample === true`, or
`foundry.run.duration_ms > slowRunThresholdMs`, and if any hold, exports that one span directly
through the same (redacting) exporter. The result: nothing that matters is dropped by a ratio <1,
and nothing bypasses redaction to do it.

**No auto-instrumentation.** Only the hand-placed spans above exist; no `NodeSDK`, no
`@opentelemetry/auto-instrumentations-node`, no monkey-patched `http`/`fs`/etc. Every span in
export is one this codebase explicitly created with a known name and attribute set.

## Alternatives considered

**A `RedactingSpanProcessor` instead of a `RedactingSpanExporter`.** Processors see spans at
`onEnd`, before batching; wrapping the exporter instead means redaction happens once, immediately
before the bytes leave the process, with no intermediate stage (batching, retry) that could
re-introduce or duplicate unredacted data. It also composes trivially with `TailSpanProcessor`,
which needs to export a single span directly through the _same_ redaction path as the batched ones
— a processor-based design would need to either duplicate redaction logic or thread the processor
through as an object the tail path also calls, more moving parts for no benefit.

**Collector-side tail sampling from day one**, where the SDK exports every span unconditionally and
a downstream Collector decides retention. Rejected for now because there is no bundled or assumed
collector in this self-hosted project — an operator who wants full-fidelity export already can
(`OTEL_TRACES_SAMPLER_RATIO=1`), and `KeepErrorsSampler`/`TailSpanProcessor` give the "always keep
errors and slow runs" guarantee without requiring one. `ponytail:` `TailSpanProcessor` holds every
`RECORD`-decision span in memory until it ends, which is fine at this project's scale (a handful of
concurrent runs) but would not scale to high request volume — the noted upgrade path is exactly the
rejected alternative: export unconditionally and move the tail decision to a Collector, once an
operator actually runs one.

**Auto-instrumentation packages** (`@opentelemetry/auto-instrumentations-node`) were rejected: they
monkey-patch `http`, `fs`, and other core modules, which is both a bigger dependency footprint than
this project wants in `apps/*` and a worse fit for redaction — auto-instrumented spans capture
whatever the patched library happens to expose (headers, URLs, sometimes bodies), which would need
its own audit against the "no PII/secrets exported" requirement instead of inheriting it for free
from `RedactingSpanExporter` covering only spans this codebase explicitly created.

## Consequences

Positive: the inert path (endpoint unset) has zero new runtime behavior — same no-op tracer/meter
`@opentelemetry/api` already provides — so existing deployments are unaffected until an operator
opts in. Every exported string is redacted by construction, not by discipline at dozens of call
sites. A single `traceId` connects a browser action through the queue to CLI execution, which is
the issue's core ask.

Negative: hand-instrumentation means new code paths need their own `withSpan` call to appear in
traces — there is no automatic coverage the way auto-instrumentation would provide for a new HTTP
call or new queue consumer. `TailSpanProcessor`'s in-memory hold of every recorded span until `onEnd`
is a real (if currently acceptable) memory cost that scales with concurrent run count; see the
`ponytail:` note above for the upgrade trigger.

Operational: nothing to run — no bundled collector, no new persisted state, no migration. An
operator turns this on by pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at any OTLP/HTTP-compatible target
(Collector, Jaeger, Tempo, ...) and gets traces at `<endpoint>/v1/traces`, metrics at
`<endpoint>/v1/metrics` every 15s.

Security: `RedactingSpanExporter` is the single choke point for everything this ADR's "Decision"
section describes; `foundry.cli` spans never carry process args (which can contain prompt text).

## Validation and rollback

```bash
npx vitest run packages/domain/src/tracing.test.ts packages/domain/src/telemetry-metrics.test.ts \
  packages/composition/src/telemetry.test.ts packages/orchestrator/src/tracing-integration.test.ts \
  apps/api/src/tracing.test.ts
```

`tracing.test.ts` covers the helper contract in isolation (span attrs/status, exception path,
context round-trip, and the no-provider-registered inert path). `telemetry.test.ts` covers
`RedactingSpanExporter` (secret-shaped attribute rewritten, `exception.*` event fields covered),
`KeepErrorsSampler` (force-sample at ratio 0, plain span downgraded to `RECORD` not dropped), and
`TailSpanProcessor` (error/force-sample/slow spans exported once, already-sampled spans left to the
delegate). `tracing-integration.test.ts` drives a full run through the orchestrator testing harness
with an `InMemorySpanExporter` and asserts the exported span tree — one `foundry.run` root with
`foundry.step`/`foundry.attempt` descendants sharing a `traceId` on the golden path, and an ERROR
status plus `foundry.force_sample` on a forced failure. `apps/api/src/tracing.test.ts` covers the
request-span hook, including that SSE routes are skipped and non-SSE routes (including blob routes)
are covered.

Rollback is unsetting `OTEL_EXPORTER_OTLP_ENDPOINT`: `startTelemetry` returns to the inert path
immediately, no data migration, no state to clean up — the local `events.jsonl`/`DATA_DIR/runs/`
observability trails this ADR builds on top of are untouched either way.
