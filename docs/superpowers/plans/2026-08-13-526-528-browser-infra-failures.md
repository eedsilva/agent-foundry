# Plan — #526 + #528: browser-infrastructure failures

Branch `fix/526-528-browser-infra`, base `d0ef9ab` (`origin/main`).

Two issues, one code path. #526 is the instance, #528 is the class. They both
edit `packages/executors/src/browser-verifier.ts` and
`packages/contracts/src/preview.ts`, so they cannot be worked in parallel
without conflicting — one branch, one PR.

## Context: the root cause, already reproduced

`PlaywrightBrowserVerifier` installs `context.route('**/*')`. Inside it:

```ts
try {
  const response = await route.fetch({ maxRedirects: 0, timeout: 0 });
  ...
  await route.fulfill({ response });
} catch {
  await route.abort('blockedbyclient').catch(() => undefined);
}
```

That bare `catch` swallows every transport failure — connection refused, DNS,
socket reset — and rewrites it as `net::ERR_BLOCKED_BY_CLIENT`, the same error
code the *deliberate* policy block uses two branches above. The cause is never
recorded anywhere.

Reproduced directly against Playwright (closed port, same route handler shape):

```
goto threw:  page.goto: net::ERR_BLOCKED_BY_CLIENT at http://127.0.0.1:59999/preview/abc/
route.fetch error: route.fetch: connect ECONNREFUSED 127.0.0.1:59999
requestfailed observations: [ 'net::ERR_BLOCKED_BY_CLIENT http://127.0.0.1:59999/preview/abc/' ]
```

This matches `docs/evidence/harness-alignment/ui-quality-judge-real-run-509/browser-verification-report-rev5.json`
exactly: a `request-failed` observation reading
`net::ERR_BLOCKED_BY_CLIENT: http://127.0.0.1:4000/preview/<id>/`, **no**
`policy-block` observation (so `permitted()` returned true), and a
`chrome-error://chromewebdata/` screenshot.

Why nothing was listening on `127.0.0.1:4000`: the preview URL is built from
`previewBaseUrl: http://${apiHost}:${apiPort}/preview`
(`packages/composition/src/runtime.ts:338`) and is served by the API's preview
proxy (`apps/api/src/preview-proxy.ts`). `scripts/tracer.ts` builds the runtime
and drives the worker in-process — it never starts an HTTP server. So in the
#509 run the preview session was `running` and its URL was well-formed, but no
process was serving that origin.

Confirm this second half by reproduction before writing it down as fact
(Task 3); Tasks 1-2 stand on the first half, which is already proven.

## Global Constraints

- **Diagnose, don't work around.** #526 asks for a stated root cause. The fix is
  that a transport failure is reported as a transport failure.
- **`blockedbyclient` means policy.** After this branch, that error code is
  emitted only by the two deliberate `permitted()` blocks. Everything else
  aborts with `'failed'`.
- **Never widen the origin policy.** `permitted()`, `allowedOrigins`,
  `allowLocalRedirects` and `isSafeBrowserPath` keep their exact current
  semantics. Nothing here makes the verifier reach anything it could not
  reach before.
- **Redaction holds.** Every new message that can contain a URL goes through
  `sanitizeUrl(..., token)` / `redact(..., token)`, like every existing
  observation. A preview token must never reach an artifact, an event, or a log.
- **No real API spend.** Every test in this branch runs against a local HTTP
  server or a closed port. No CLI executor, no model call. (#527 is the ticket
  that spends real money; it is not in this branch.)
- **Additive contract changes only.** `BrowserVerificationReportSchema` is
  `.strict()` and already persisted in evidence files; new fields are optional
  so existing artifacts still parse.
- **Vitest fast/slow partition.** Any new test file must be added to exactly one
  of the two lists in `package.json` (`npx vitest list --filesOnly` to verify).
  Playwright-driven files belong in the slow bucket.
- **Per-task check.** Every task ends with `npx tsc -b` over the packages it
  touched plus the test files it added or changed. Vitest alone does not catch
  `exactOptionalPropertyTypes` violations.

---

## Task 1 — A transport failure is recorded as one, not as a policy block

**Issue:** #526 (root cause + regression test), #528 (classification, producer side).

**Files:** `packages/contracts/src/preview.ts`,
`packages/executors/src/browser-verifier.ts`, plus their tests.

**Behaviour to build.**

1. `BrowserObservationSchema.kind` gains `'preview-unreachable'`.
2. The route handler's `catch` binds the error. It records an observation
   carrying the real cause — `kind: 'preview-unreachable'` when the failing
   request is on the preview origin (`prefixUrl.origin`), otherwise the existing
   `'request-failed'` — with the underlying message, sanitized. It then aborts
   with `'failed'`, never `'blockedbyclient'`.
3. `BrowserVerificationReportSchema` gains an optional
   `infrastructureFailure: z.string().min(1)`. The verifier sets it when at
   least one `preview-unreachable` observation was recorded, to a message that
   names the preview origin and the underlying cause. `approved` stays `false`
   in that case (it already would be).

**TDD.** Red first, and watch it fail:

- An integration test that drives the real `PlaywrightBrowserVerifier` at a
  **closed loopback port** (bind a `node:http` server to port 0, read the port,
  close it — that guarantees a free port with nothing on it). Assert the report
  carries `infrastructureFailure`, a `preview-unreachable` observation whose
  message contains the underlying connect error, and **no** observation whose
  message contains `ERR_BLOCKED_BY_CLIENT`. On `main` this fails: today the only
  observation is `request-failed: net::ERR_BLOCKED_BY_CLIENT`.
- A second test in the same file that serves a real page from a `node:http`
  server on the preview prefix and asserts the report has **no**
  `infrastructureFailure` and its screenshot is of the served page — #526's
  "captures a screenshot of the rendered app" acceptance criterion, met
  deterministically and for free.
- A test that a request the policy genuinely blocks still produces
  `policy-block` and still aborts `blockedbyclient` (guard against Constraint 3
  regressing).

**Out of scope:** retrying, waiting for the preview to come up, health-checking
the preview before the run. Task 1 reports what happened; it does not change
what is attempted.

---

## Task 2 — An unreachable preview fails the run instead of entering repair

**Issue:** #528 (consumer side).

**Files:** `packages/orchestrator/src/task-graph-runner.ts` and its tests.

**Behaviour to build.**

In `runBrowserAssertion`'s repair loop (`task-graph-runner.ts`, the
`for (let round = 1; ; round += 1)` block), after the report is parsed and
before the `quality.repair_requested` emit: if
`parsed.data.infrastructureFailure` is set, do not emit a repair request and do
not run the repair step. Instead emit an operator-visible failure event naming
the infrastructure problem, and throw an `ExecutionError` whose message states
that browser verification never reached the app and quotes the diagnosis.

`ExecutionError`, not `QualityGateError`: a quality gate says the app failed a
check. This says the harness could not run the check.

**TDD.** Two directions, both required by #528's acceptance criteria:

- A report carrying `infrastructureFailure` → the run fails with the
  infrastructure diagnosis, the repair step is never executed (assert on the
  step-execution spy), and the emitted event carries the diagnosis.
- A report with `approved: false` and no `infrastructureFailure` → the repair
  loop still runs exactly as it does today. Add this direction as an assertion
  even if an existing test already covers the happy repair path; #528 names it
  explicitly.

**Out of scope:** the `full-suite-verification` gate, the UI-quality judge's
blocking threshold, and `validation-evidence.ts`. This task changes one branch
in one loop.

---

## Task 3 — The tracer's preview is reachable, or the run says why not

**Issue:** #526 (the specific instance), and its evidence acceptance criterion.

**Files:** `packages/composition/src/tracer.ts` (and/or `scripts/tracer.ts`),
its tests, and
`docs/evidence/harness-alignment/ui-quality-judge-real-run-509/README.md`.

**First: reproduce and confirm.** Run the tracer in **mock** executor mode
against the `toy` scenario with `--approve-gates` and confirm the browser step
fails the same way (with Task 1 landed, it now fails with a *legible*
`preview-unreachable` diagnosis naming `127.0.0.1:4000`). Mock mode costs
nothing. If the reproduction shows a different cause than "nothing is listening
on the API port", stop and report it — the plan's diagnosis is a hypothesis for
this half, and the reproduction is what settles it.

**Then fix it — laziest thing that holds.** In order of preference:

1. A preflight in the tracer driver: before the run starts, probe the
   configured preview base origin; if nothing answers, fail immediately with a
   message telling the operator to start the API server, naming the origin and
   port. Cheap, honest, no layering violation.
2. Only if (1) proves insufficient: have the tracer serve the preview proxy
   itself. Weigh this against `packages/composition` taking a dependency on
   `apps/api`; do not do it without saying why (1) does not hold.

A tracer that runs for 46 minutes and produces blank screenshots is the defect.
A tracer that refuses to start in ten seconds with "nothing is serving
http://127.0.0.1:4000" is the fix.

**Evidence.** Update the #509 README so its near-zero judge scores are not read
later as a judge defect: state the root cause, link this branch, and say plainly
that the scores measured a Chrome error page. Do not rewrite its history or its
cost table — append a resolution note.

**Out of scope:** re-running the real-mode tracer. That is #527, gated on this
branch merging.

---

## Not in this branch

- **#527** (real-mode judge score against an app that actually rendered) needs a
  real ~1h paid run and is blocked on #526. Separate ticket, separate PR.
- Preview session readiness/health-check semantics beyond the tracer preflight.
- The UI-quality judge's rubric, threshold, or blocking-gate behaviour.
