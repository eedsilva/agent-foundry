# Issue #58 — OpenTelemetry logs, metrics, traces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End-to-end correlated observability: one trace connects HTTP request → queue job → run → step → attempt → CLI execution → preview; metrics for latency/success/retries/queue-wait/token-usage/preview utilization; pino logs structured with trace/correlation IDs; redaction before export; sampling that always keeps errors and slow runs. Off by default (no exporter configured → no-op), enabled via standard `OTEL_*` envs.

**Architecture:** Instrumentation uses ONLY `@opentelemetry/api` inside `packages/{orchestrator,executors,persistence}` and `apps/{api,worker}` — the API package no-ops when no SDK is registered, so zero overhead and zero new behavior for un-configured installs. The SDK (provider, OTLP exporters, resource, sampler, redacting span processor) is initialized exclusively in `packages/composition` (`telemetry.ts`) and started from `apps/api`/`apps/worker` entrypoints. Trace context crosses the queue boundary via a new optional `traceContext` carrier field on `QueueJob` (W3C propagation, injected at enqueue, extracted at claim). A tiny `foundry-tracing` helper module in `packages/domain` wraps span creation (`withSpan`) so call sites stay one-liners and the redaction rule (attribute values pass through `redactString`) is centralized at export time, not at call sites. Sampling: `ParentBased(TraceIdRatioBased(ratio))` root sampler wrapped by a `KeepErrorsSampler` that force-records any span started with attribute `foundry.force_sample=true` (set on retry/error paths) — plus a span processor that promotes spans exceeding `OTEL_SLOW_RUN_THRESHOLD_MS` (applies to run/operation spans, which set their duration attribute at end).

**Tech Stack:** `@opentelemetry/api` (deps of domain/orchestrator/executors/persistence/api/worker — API package only); `@opentelemetry/sdk-node`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/sdk-metrics`, `@opentelemetry/resources`, `@opentelemetry/semantic-conventions` (deps of composition only); `@opentelemetry/sdk-trace-base` InMemorySpanExporter for tests.

## Global Constraints

- Work from `/Users/edsilva/Documents/ed/agent-foundry/.claude/worktrees/issue-58-observability` on branch `agent/issue-58-observability`. **First step of every task: `cd` there and verify `git rev-parse --abbrev-ref HEAD`.**
- Architecture rules: `domain` may depend on `contracts` only (internal) — `@opentelemetry/api` is external, allowed. SDK packages ONLY in `packages/composition`. Nothing new crosses internal package boundaries.
- TypeScript `strict` + `exactOptionalPropertyTypes`; ESM `.js` suffixes; match surrounding code style; no auto-instrumentation packages (hand spans only — deterministic, no monkey-patching).
- Telemetry must be a no-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset: no SDK started, `withSpan` falls through to the API's default no-op tracer. Assert this in tests (no throw, no export).
- Never export un-redacted attribute values: every string attribute passes `redactString` (from `@agent-foundry/domain`) in the export-side span processor. PII/secret filtering is centralized THERE (issue criterion), not left to call-site discipline.
- Do not modify `planning/`. Commit per task referencing #58. Full `npm run check` + `npm run e2e --workspace @agent-foundry/api` before PR.

---

### Task 1: `withSpan` helper + contracts `traceContext` + queue propagation

**Files:**

- Create: `packages/domain/src/tracing.ts`
- Modify: `packages/domain/src/index.ts` (barrel)
- Modify: `packages/domain/package.json` (+ `@opentelemetry/api`)
- Modify: `packages/contracts/src/project.ts` (`QueueJobSchema` + `traceContext: z.record(z.string(), z.string()).optional()`)
- Modify: `packages/persistence/src/job-queue.ts` — no logic change needed (schema passthrough) but add the round-trip test
- Modify: `packages/orchestrator/src/project-service.ts` + `operation-service.ts`: inject current context into every `enqueue` (`traceContext: serializeTraceContext()`)
- Modify: `packages/orchestrator/src/worker-loop.ts`: wrap job dispatch in `withJobSpan(job, …)` extracting the carrier
- Modify: `packages/orchestrator/package.json`, `packages/persistence/package.json` (+ `@opentelemetry/api`)
- Test: `packages/domain/src/tracing.test.ts`
- Test: extend `packages/orchestrator/src/worker-loop.test.ts`

**Interfaces (Produces):**

```ts
// packages/domain/src/tracing.ts
import {
  context,
  propagation,
  trace,
  SpanStatusCode,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

export const TRACER_NAME = 'agent-foundry';

export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T>;
// - starts an active span via trace.getTracer(TRACER_NAME), sets attributes,
//   on throw: span.recordException + setStatus(ERROR) + rethrow; always span.end().

export function serializeTraceContext(): Record<string, string>; // propagation.inject into {}
export function withExtractedContext<T>(
  carrier: Record<string, string> | undefined,
  fn: () => Promise<T>,
): Promise<T>; // propagation.extract + context.with
export function currentTraceIds(): { traceId?: string; spanId?: string }; // from active span, undefined when none/invalid
```

Span taxonomy + attribute names (used across Tasks 1-3; keep these exact strings, they are the contract):

- `foundry.request` (api), `foundry.job` (worker; attrs `foundry.job.id/type/attempts`, `foundry.queue.wait_ms`), `foundry.run` (attrs `foundry.project.id`, `foundry.run.id`, `foundry.workflow.id`), `foundry.step` (`foundry.step.node_id`, `foundry.step.id`, `foundry.step.type`), `foundry.attempt` (`foundry.attempt.id/sequence`, `foundry.model.id`, `foundry.provider`), `foundry.cli` (`foundry.provider`, `foundry.cli.command`), `foundry.preview` (`foundry.preview.session_id`), `foundry.operation` (`foundry.operation.id/kind`).
- Error/retry paths set `foundry.force_sample: true` when starting the span (retry attempt >1, nack path, failure finalizers).

- [ ] **Step 1: failing tests.** `tracing.test.ts`: with a real `NodeTracerProvider` + `InMemorySpanExporter` (devDep `@opentelemetry/sdk-trace-node`/`sdk-trace-base` at root) registered in the test: `withSpan` records name/attrs/status; exception path sets ERROR status and rethrows; `serializeTraceContext`→`withExtractedContext` round-trips parent/child linkage (child's traceId === parent's); with NO provider registered everything no-ops without throwing and `currentTraceIds()` returns `{}`-ish undefineds. Worker-loop test: enqueue with `traceContext` carrier from a recorded span → `runOnce` → orchestrator stub records `currentTraceIds()` inside dispatch → traceId matches the enqueuing span (proves request→job linkage). QueueJob zod round-trip with/without `traceContext`.
- [ ] **Step 2: FAIL run.**
- [ ] **Step 3: implement** (helper ~60 lines; enqueue call sites: add `...(carrier is non-empty ? { traceContext: carrier } : {})` — respect exactOptionalPropertyTypes; worker-loop: wrap the `orchestrator.runProject`/`operationRunner.run` dispatch in `withExtractedContext(job.traceContext, () => withSpan('foundry.job', {...}, …))`, computing `foundry.queue.wait_ms = now - Date.parse(job.availableAt)`).
- [ ] **Step 4: PASS run**; `npm run typecheck`.
- [ ] **Step 5: commit** — `feat(domain): tracing helper and queue trace-context propagation (#58)`.

---

### Task 2: Span coverage — API request, run/step/attempt, CLI, preview, operation

**Files:**

- Modify: `apps/api/src/app.ts`: Fastify `onRequest`/`onResponse` hooks creating `foundry.request` span (method, route, status; skip SSE routes' long-lived spans — end request span at headers-sent for hijacked SSE replies; simplest correct cut: create request spans only for non-hijacked routes, note as `ponytail:` comment), and pino log correlation (Task 3 wires the mixin; here ensure the span is active across the handler via `context.with`).
- Modify: `packages/orchestrator/src/workflow-orchestrator.ts`: `runProject` → `foundry.run` span; `executeStep`/`executeApprovalGate`/`executeQualityLoop` → `foundry.step`; attempt execution (`executeAgentStep`/`executeVerifyStep`/`executeBrowserVerifyStep`) → `foundry.attempt` (attrs incl. routed model; `foundry.force_sample` on retries/failures).
- Modify: `packages/orchestrator/src/conversation-operation-runner.ts`: `foundry.operation` span wrapping `run`.
- Modify: `packages/executors/src/base-cli-executor.ts` (+ `packages/executors/package.json` + `@opentelemetry/api`): `foundry.cli` span around process execution (command name only — never args, they can contain prompt text).
- Modify: preview session start path (find the single choke point in `packages/orchestrator`'s preview service or `packages/composition` wiring — wherever `PreviewRunner.start` is invoked) → `foundry.preview` span.
- Test: `packages/orchestrator/src/tracing-integration.test.ts`

**Interfaces:** Consumes Task 1 helper + attribute contract. Produces the issue's trace criterion.

- [ ] **Step 1: failing integration test** — use the orchestrator testing harness (`packages/orchestrator/src/testing/harness.ts`) with mock executor + InMemorySpanExporter: drive a full project run; assert the exported span tree: one `foundry.run` root (or child of test-created parent), ≥1 `foundry.step` child, ≥1 `foundry.attempt` child of step, `foundry.cli` under attempt (mock executor path — if the mock bypasses `base-cli-executor`, assert cli span via a unit test on `BaseCliExecutor` with a stubbed process instead, and say so in the report), all sharing one traceId; failure test: force a failing step (harness has failure fixtures — see cancellation/plan-build tests for how) → `foundry.attempt` span has ERROR status + `foundry.force_sample=true`.
- [ ] **Step 2: FAIL**, **Step 3: implement** (each span = one `withSpan` wrap; no logic moves), **Step 4: PASS** + `npm run typecheck`.
- [ ] **Step 5: commit** — `feat(orchestrator,executors,api): spans across request/job/run/step/attempt/cli/preview (#58)`.

---

### Task 3: Metrics + pino correlation + composition SDK (exporters, sampler, redaction)

**Files:**

- Create: `packages/composition/src/telemetry.ts` (+ deps in `packages/composition/package.json`)
- Create: `packages/domain/src/telemetry-metrics.ts` — meter helpers: `recordRunDuration(ms, {status})`, `recordStepRetry()`, `recordQueueWait(ms)`, `recordTokenUsage({inputTokens?, outputTokens?, modelId})`, `recordPreviewSessions(active)` via `metrics.getMeter(TRACER_NAME)` histograms/counters/gauge — no-op without SDK. Call sites: worker-loop (queue wait — already computed in Task 1; call helper there), workflow-orchestrator `completeRun`/failure finalizers (run duration+status), retry path (step retries), the existing `metrics.record(...)` call sites (token usage — piggyback where usage is already in hand), preview service session start/stop (gauge via observable callback reading `listActive().length`).
- Modify: `apps/api/src/app.ts` pino config + `apps/worker/src/index.ts` pino init: `mixin: () => currentTraceIds()` (adds `traceId`/`spanId` to every log line when a span is active); worker job logs become child loggers `logger.child({ jobId, runId, projectId })` in `WorkerLoop` — pass an optional `log` callback… (Worker currently has no logger injected: add optional `logger?: { child/info/error }`-shaped param to `WorkerLoop` options, typed structurally to avoid a pino dep in orchestrator; apps/worker passes pino in.)
- Modify: `apps/api/src/index.ts` + `apps/worker/src/index.ts`: `const telemetry = await startTelemetry(config); …; await telemetry.shutdown()` on close (before other shutdown steps; tolerate errors).
- Modify: `packages/composition/src/config.ts`: `OTEL_EXPORTER_OTLP_ENDPOINT?`, `OTEL_SERVICE_NAME?` (default `agent-foundry-api`/`-worker` passed by caller), `OTEL_TRACES_SAMPLER_RATIO` (default 1), `OTEL_SLOW_RUN_THRESHOLD_MS` (default 60_000).
- Modify: `.env.example`, `docker-compose.yml` (commented `OTEL_*` envs; no collector service — external endpoint is the operator's choice).
- Test: `packages/composition/src/telemetry.test.ts`

**Interfaces:**

```ts
// packages/composition/src/telemetry.ts
export interface TelemetryHandle {
  shutdown(): Promise<void>;
}
export function startTelemetry(options: {
  serviceName: string;
  endpoint?: string; // undefined => returns inert handle, registers nothing
  sampleRatio: number;
  slowRunThresholdMs: number;
}): TelemetryHandle;
```

Inside: NodeSDK (or manual `NodeTracerProvider` + `PeriodicExportingMetricReader` — whichever wires cleanly without auto-instrumentations) with:

- `RedactingSpanProcessor` wrapping `BatchSpanProcessor`: `onEnd(span)` clones/mutates string attributes through `redactString` before delegating (implement via a delegating SpanProcessor; attributes are mutable on `ReadableSpan.attributes` record — if not, wrap the exporter instead and rewrite attributes on the span data objects passed to `export()`; the exporter-wrapper approach is simpler and test-provable: implement `RedactingSpanExporter`).
- `KeepErrorsSampler`: `shouldSample` → delegate `ParentBasedSampler(TraceIdRatioBased(ratio))`; if attributes `foundry.force_sample === true` → RECORD_AND_SAMPLED regardless.
- Metrics: OTLP metric exporter, 15s interval.

Tests (full code): endpoint unset → inert (no provider registered; `withSpan` still works as no-op); `RedactingSpanExporter` rewrites a `Bearer eyJhbGciOiJIUzI1NiJ9.x.y` attribute to contain `[REDACTED]`; `KeepErrorsSampler` samples a `foundry.force_sample` span at ratio 0 and drops a plain span at ratio 0; slow-run promotion: span with `foundry.run.duration_ms` attr > threshold gets `foundry.slow=true` attribute stamped by the exporter wrapper (and document that tail retention of slow traces belongs to the collector; this attribute is the hook). Metrics helpers: with an in-memory `MeterProvider`+reader, `recordQueueWait(1200)` produces histogram point 1200.

Steps: FAIL → implement → PASS → `npm run typecheck` → commit `feat(composition,api,worker): OTel SDK wiring, metrics, log correlation, redacting exporter (#58)`.

---

### Task 4: Docs + final verification + PR

- [ ] `docs/OPERATIONS.md`: "Observabilidade" section rewrite — enable via envs, span taxonomy table, metric names (`foundry.run.duration_ms`, `foundry.step.retries`, `foundry.queue.wait_ms`, `foundry.tokens.{input,output}`, `foundry.preview.active_sessions`), correlation-ID log fields, redaction guarantee, sampling knobs (+ collector-side tail sampling recommendation for slow-trace retention).
- [ ] `docs/adr/00XX-opentelemetry-observability.md` (next free number): api-only instrumentation / composition-only SDK split, queue carrier propagation, export-side redaction as the single filter point, head-sampling + force-sample flags vs collector tail sampling.
- [ ] Full `npm run check`; `npm run e2e --workspace @agent-foundry/api` (telemetry unset ⇒ inert — e2e also proves the no-op path).
- [ ] Evidence: tracing-integration test output showing the span tree (golden path + failure), telemetry unit-test output, check tail, e2e summary.
- [ ] Push, open PR `feat: OpenTelemetry traces, metrics, and correlated logs (#58)` — acceptance-criteria map, evidence, DoD assessment (explicitly: no PII/secrets exported — redaction test cited), `Closes #58`, standard attribution.

## Self-Review Notes

- "Trace conecta HTTP request, queue job, run, step, attempt, CLI e preview" → Tasks 1-2 (carrier over queue + span taxonomy; integration test asserts single traceId).
- "Métricas incluem latency, success, retries, queue wait, token usage e sandbox utilization" → Task 3 helpers (success = status attr on run duration histogram; sandbox utilization = preview active-sessions gauge — the closest existing "sandbox" resource; noted in ADR).
- "Logs estruturados e carregam correlation IDs" → pino mixin + worker child loggers (Task 3).
- "PII e secrets filtrados antes de exportar" → RedactingSpanExporter + test (Task 3); CLI spans never carry args (Task 2).
- "Sampling preserva erros e runs lentas" → KeepErrorsSampler + slow-flag hook + tests (Task 3).
- Mandatory "Trace golden path e falha com fallback" → Task 2 integration tests (happy + failing step with ERROR status/force_sample).
- No auto-instrumentation, SDK confined to composition, off-by-default inert path proven by test and e2e.
