# ADR 0009: Version provider canary reports and fail closed on model ambiguity

- Status: Accepted
- Date: 2026-07-13
- Owners: Core and Integrations

## Context

Codex, Claude, and AGY expose different CLI envelopes for artifacts, usage, errors, and model metadata. A requested alias is not proof of the model a provider executed, and provider output can repeat or conflict across JSONL documents. Canary evidence also crosses a security boundary: raw stdout, stderr, authentication payloads, identities, credentials, and machine-specific paths must not enter a committed baseline.

The provider canary runner and provider-aware doctor need one public contract that preserves compatibility while making incomplete or ambiguous evidence observable.

## Decision

Publish a strict, schema-version-1 provider canary report contract from `@agent-foundry/contracts`. The report contains normalized provider probes, canary runs, aliases, limitations, usage, verification results, and sanitized errors. Real-provider records exclude the mock provider, and undeclared diagnostic fields are rejected.

`model` retains its existing meaning: the model or alias selected in the execution request. Optional `executedModel` records only model metadata reported by a recognized provider envelope or event. It is never inferred from `model`, and artifact payload fields are not metadata sources.

Claude stream output's `system/init.model` is the provider's explicit primary session model. The parser aggregates every init event and requires one value. For older single-result output without init metadata, Claude `modelUsage` keys remain the fallback evidence and multiple concrete identifiers produce an unknown `executedModel`; auxiliary usage never overrides an explicit primary init event. Conflicting init models, configured-session models, backend-override labels, or other explicit identifiers produce an unknown `executedModel`. Canary freezing must fail closed when the executed model is unknown.

Codex canary executions enable the CLI's configured-session debug event because Codex 0.144.2 omits the model from standard JSON events. AGY canary executions use its provider log event that propagates the selected model override to the backend. Codex final-response files and AGY metadata are written to runner-owned temporary directories outside the agent-writable repository, read with the executor output bound, and deleted recursively in `finally` on success, failure, or timeout. Neither raw provider source is returned in the report or frozen.

Executed-model extraction is provider- and source-specific: Codex trusts only the configured-session debug stderr, Claude trusts recognized stream-JSON events, and AGY trusts only its bounded per-run metadata log. Artifact content is never treated as model evidence. AGY 1.1.2 does not expose `agy auth status`, so doctor uses the non-generative `agy models` command as its authenticated probe. The probe accepts both the legacy `Model Name (alias)` rows and the current bare-slug-per-line output, while still rejecting malformed lists and explicit unauthenticated responses.

Versioned reports persist only normalized fields and sanitized error summaries. Usage is accepted only from provider-specific terminal envelopes, never recursively from artifact data. Raw provider stdout/stderr, authentication responses, user identities, secrets, stack traces, and machine-specific temporary paths are outside the report contract. If later canary execution retains raw failure diagnostics, they must remain in ignored local storage and must not be frozen or committed.

Campaign preflight canary results carry the same sanitized error classification across the runner boundary. Schema-version-1 `SanitizedError.code` remains a non-empty free-form string for compatibility; the preflight boundary accepts it as `errorCode` only when it matches that report's stricter field schema, otherwise it records `CANARY_FAILED` or `UNKNOWN_EXECUTED_MODEL`. Artifact and verification failures carry their bounded classification and failed check names. Thrown execution errors remain generic because they can contain arbitrary stderr, secrets, or host paths.

## Alternatives considered

Using the requested model as the executed model was rejected because aliases and provider routing can resolve differently at runtime. Choosing the first model found was rejected because JSONL and usage records can disagree, turning ambiguous evidence into a false positive. Recursively scanning every output object was rejected because valid agent artifacts may contain domain fields named `model` or `modelUsage`. Persisting raw provider output was rejected because it can contain credentials, identities, prompts, and host paths.

## Consequences

Canary reports are portable, reviewable, and safe to validate as public evidence. Existing execution results remain compatible because `executedModel` is optional and `model` semantics do not change. Consumers must handle an absent executed model and cannot assume the requested alias ran unchanged. Strict contracts and ambiguity checks may reject new provider output shapes until adapter fixtures and parsing rules are deliberately updated.

Any future contract change that is not backward compatible requires a new report schema version and an explicit migration or dual-read period.

## Validation and rollback

Scrubbed Codex, Claude, and AGY fixtures cover artifacts, usage, executed models, malformed/failed output, ambiguity, artifact-payload isolation, and both legacy and current AGY model-list formats. Contract tests reject mock-provider canaries and raw diagnostic fields while retaining schema-version-1 free-form error codes. Preflight tests prove unsafe codes fall back without aborting report publication, while provider tests prove thrown errors and temporary workspace paths do not enter the report. Opt-in real canaries validate installed CLI shapes before a baseline is frozen.

If a provider changes its envelope, disable that provider or leave `executedModel` unknown while fixtures and recognized metadata locations are updated. If AGY changes its model-list format again, keep the doctor probe fail-closed until a fixture-backed format is deliberately added. Roll back report publication by stopping the freeze path; do not weaken ambiguity handling or substitute the selected model for missing execution evidence.
