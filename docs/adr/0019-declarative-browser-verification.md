# ADR 0019: Declarative browser verification behind the domain port

- Status: Accepted
- Date: 2026-07-17
- Owners: Contracts, Executors, Orchestrator, and Composition

## Context

Workspace scripts do not prove a critical browser journey works. Issue #32 adds that signal without giving workflow YAML arbitrary JavaScript execution or coupling orchestration to Playwright. The existing preview proxy is trusted, loopback-only operator infrastructure (ADR 0017); its access token must not become durable verification evidence.

## Decision

Browser tests are version-1 declarative `AgentArtifact` values. Their `data` contains a viewport and up to 100 ordered steps using only relative `goto` paths, semantic locators, `goto`/`click`/`fill`, and `visible`/`hidden`/`containsText`/`url` assertions. A `verify` workflow step selects browser mode with `browserTestPlanArtifact`; it must disable workspace scripts and `git diff --check`.

`BrowserVerifier` is the domain port. Composition supplies its headless Chromium implementation and the coordinator owns preview start, verification, and unconditional stop. A browser quality loop creates `browser-test.plan`, writes the versioned `browser-verification.report`, and on failure gives repair the report and the original plan reference before rerunning that same pinned plan.

The verifier permits only the exact `/preview/<sessionId>/` prefix on the preview origin (and its matching WebSocket origin) plus exact HTTP(S) origins in `ProjectPolicy.browserAllowedOrigins`. Policy entries are normalized by `URL` and must equal their origin: no path, query, fragment, wildcard, or non-HTTP(S) scheme. The preview proxy remains loopback-only under ADR 0017.

Each action/assertion and pending-request wait has a 10-second limit; the browser run has a 60-second ceiling. Service workers are blocked. Console errors, uncaught exceptions, failed requests, HTTP responses at or above 400, and policy blocks are observations and make the report unapproved. Observations are capped at 100. URLs and messages redact the preview token before the JSON report is persisted; the report retains only a sanitized session URL and versioned artifact references. It does not capture binary evidence. Screenshots/traces are deferred to issue #33; stronger process and network isolation is deferred to issue #120.

## Alternatives considered

- Imperative JavaScript in plans was rejected: it would turn an artifact into arbitrary browser-side execution and make review/replay less auditable.
- Calling Playwright from the orchestrator was rejected: the domain port keeps orchestration independent of the Chromium implementation.
- Allowing arbitrary origins or prefix-like policy entries was rejected: exact origin comparison is the smallest auditable boundary.
- Browser screenshots and traces were rejected for this issue: redacted structured JSON is sufficient for the initial repair loop; binary retention belongs to issue #33.

## Consequences

The workflow now has a real Chromium gate after workspace verification. A browser plan/report pair is revision-linked through `ArtifactReference` (`name`, `revision`, `sha256`), and the `StepAttempt` records the plan input and preview session. A pass checkpoint is recorded like other verification passes. A failed report can drive repair, but a browser report alone does not isolate untrusted generated code: it remains trusted-loopback operator tooling.

Chromium must be available locally and in CI. Local development installs it with `npx playwright install chromium`; CI installs its dependencies and Chromium with `npx playwright install --with-deps chromium` before `npm test`.

## Migration, rollback, and validation

`browserAllowedOrigins` and `browserTestPlanArtifact` are optional. Existing policies retain no extra origins, existing verify steps remain workspace verification, and there is no backfill. To roll back, remove the browser quality-loop node and composition/runtime browser-verifier wiring; the existing workspace verifier and its quality loop continue to operate. Preserve versioned run and artifact data for investigation rather than rewriting it.

The issue #32 focused command and full branch gates are recorded in `docs/VALIDATION.md`.
