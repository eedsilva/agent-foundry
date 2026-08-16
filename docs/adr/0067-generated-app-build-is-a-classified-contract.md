# ADR 0067: A generated app's build is a classified contract, not an exit code

- Status: Accepted
- Date: 2026-08-16
- Owners: Core
- Tracked by issue #561
- Builds on ADR 0045 (per-task deterministic verification)

## Context

QA on the v1.0 golden journey produced two results the loop could not tell
apart from success, and one it could not tell apart from a code defect.

**The recursive build disagreed with the individual one.** `apps/web` built on
its own; `pnpm --recursive build` over the same tree was blocked by process and
Turbopack limits. `pnpm -r` runs workspace packages concurrently by default, so
a Turbopack `next build` and a `tsc` build competed for worker processes and
memory. Same source, two answers — nothing downstream could trust either.

**A build that produced nothing exited 0.** `pnpm -r <script>` silently skips a
workspace package that does not define the script. A generated app whose
`apps/web` loses its `build` script still exits 0 from the root `build`, with no
`.next` output anywhere. The verification report records a passing required
check.

**A build that never ran looked like a build that failed.** `WorkspaceVerifier.run()`
collapsed every outcome into `exitCode: result.exitCode ?? 1`. A `next build`
killed by the 600 s timeout, killed by the OOM killer, or truncated by
`maxBuffer` all arrived at the `fixer` as an anonymous red check. Worse, execa
reports a `maxBuffer` overrun as `failed: true` with **`exitCode: 0`** — so a
truncated, killed build was recorded as a **pass**. Two false greens and one
misrouted repair, all in the same eight lines.

Separately, the per-task gate checks server-action export shape
(`check-server-actions.mjs`) but nothing checks route-handler export shape, and
`build` deliberately does not gate a task (ADR 0045: a dependency-ordered graph
may leave the tree uncompilable mid-run). A route module with a `default` export
— the Pages Router habit a model brings to an App Router file — therefore
survives every task commit and surfaces once, late, at
`full-suite-verification`.

## Decision

**One build command, serialised.** The generated app's root `build` becomes
`… && pnpm --recursive --workspace-concurrency=1 build && node scripts/check-build-output.mjs`.
One package at a time is what makes the recursive build agree with building a
package alone; it is a throughput cost paid once per run, against a
reproducibility that everything downstream depends on.

**The build owes an artifact, not an exit code.** `scripts/check-build-output.mjs`
asserts that every `apps/*` package declaring a `build` script produced its
output — a non-empty `.next/BUILD_ID` for a package depending on `next`, an
non-empty `outDir` otherwise — and prints each one, so the verification log
carries evidence the build ran rather than only its status.

**Export shape is checked where it can be checked honestly.**
`scripts/check-route-handlers.mjs` reads only the files a task just wrote, so it
answers correctly on a half-built graph and joins `server-actions:check` in the
per-task `scripts` gate. It allows the seven HTTP methods, the route segment
config, `generateStaticParams` and types, and rejects `export default`,
`export *`, a route module with no HTTP method, and any other named export.
That last rule is stricter than Next 16, which structurally tolerates an excess
export; the stance matches `check-server-actions.mjs` — a value exported from a
framework-loaded module is dead code that reads as working configuration.

**A failed command names why.** `VerificationCommandResult` gains
`failureKind: 'check' | 'timeout' | 'out-of-memory' | 'signal' | 'max-output' | 'spawn'`,
set only on failure. `check` is the only value that says anything about the
code: the command ran to completion and reported a real defect — a Turbopack
compile error is a `check`, because it *is* the defect. Every other value means
the run itself failed and the tree is still unjudged. A non-`check` failure also
appends one diagnosis line to `stderr` naming the limit involved, so the
persisted log and the repair prompt both carry it, and a non-zero exit code is
forced so a `max-output` overrun can never sit on an approved report.

**A report names the tree it judged.** `VerificationReport` gains an optional
`commit`, the workspace's `git rev-parse HEAD` when the report was produced.
Until now the commit lived only on the later `task.completed` event
(ADR 0045), so reading a report meant joining through `runId` + `taskId` +
step ordering to learn what it had actually checked.

## Alternatives considered

**Raise the memory and process limits instead of serialising.** Treats the
symptom. The divergence is that two builds of one tree disagree; a bigger box
moves the threshold without removing it, and the threshold moves again with the
size of the generated app.

**Make `build` gate every task.** Rejected by ADR 0045 and still wrong: a
dependency-ordered graph legitimately leaves the workspace uncompilable while a
later task updates a caller. The two static checks are gateable precisely
because they read only what the task wrote.

**Let the type system catch route-handler exports.** Next 16's generated
`RouteHandlerConfig` validation is a structural `extends` constraint, so an
excess export satisfies it. The failures Next does report
(`Detected default export in …`, `No HTTP methods exported in …`) come from the
route module at build time — which is the late gate this ADR is routing around.

**Classify a bundler panic as its own kind.** `check` already carries a
Turbopack compile error correctly, and it is the defect the fixer should fix.
An internal bundler crash distinguishable from a compile error has not been
observed; adding a kind for it now would be a guess encoded in a contract.

## Consequences

- The generated app's build is slower by roughly the smaller package's build
  time, and reproducible. Accepted deliberately.
- A red report a `fixer` receives now distinguishes "your code is wrong" from
  "the machine gave up", so a repair attempt is no longer spent on a build that
  never completed. Attempts are bounded (`repair.maxAttempts`), so this
  previously cost a task its whole budget.
- Two previously-green outcomes now fail: a truncated command, and a build that
  skipped a package. Both were false and both are now loud.
- The per-task gate can fail a task that writes a `route.ts` before writing its
  HTTP method. That is the same shape as the existing `server-actions:check`
  and the same repair loop answers it.
- Both new schema fields are optional; every existing report and every existing
  parse site round-trips unchanged.
- The route-handler check is line-wise regex, not a parser, and the OOM check
  matches V8's prose rather than a machine-readable status. Both ceilings are
  marked in-source with their upgrade paths.

## Validation and rollback

`packages/harness/src/scaffold-route-handlers.test.ts` and
`scaffold-build-output.test.ts` spawn each check over temporary workspaces and
cover the shipped scaffold, every rejected shape, and the ignored ones.
`packages/executors/src/verifier.test.ts` drives a real timeout, a real
`maxBuffer` overrun, a simulated OOM message and a git workspace through
`WorkspaceVerifier`, asserting the kind, the diagnosis line and the commit.
`packages/harness/src/scaffold-tooling.test.ts` pins the build command itself.

Rollback is per-decision and independent: drop a check from the scaffold `build`
chain and from `verify-task.scripts`, restore `pnpm --recursive build`, or stop
setting `failureKind` — the field is optional and no consumer requires it.
