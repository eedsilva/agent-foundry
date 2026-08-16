# Issue #561 — Make the generated app's build deterministic

## Problem

QA on the v1.0 golden journey found two distinct build defects in generated apps:

1. A generated dashboard shipped a Next.js **route handler** (`app/**/route.ts`) with an
   export the framework does not allow. `next build` rejects it, but nothing before the
   final build gate catches it — the per-task verify gate only checks server actions
   (`scripts/check-server-actions.mjs`), so the defect survives every task commit and
   surfaces once, late, at `full-suite-verification`.
2. Building `apps/web` on its own passed while the workspace-wide `pnpm --recursive build`
   was blocked by process/Turbopack limits. `pnpm -r` runs workspace packages concurrently
   (default `workspace-concurrency`), so a Turbopack `next build` and a `tsc` build compete
   for memory and worker processes. Same source, two different answers — the build is not
   reproducible.

Alongside those, the verification report cannot tell a genuine red check from an
infrastructure failure: a timeout, an OOM kill, or a signal all land in the report as
`exitCode: 1` with no classification, so the repair agent is asked to "fix" a build that
was never actually run to completion. And `pnpm -r build` silently skips a workspace
package that has no `build` script, which exits 0 with no artifact produced — a false
green.

## Acceptance criteria → work

| AC | Work |
| --- | --- |
| Toy, auth, CRUD and dashboard build in a clean environment | Serialised recursive build + both static gates (below) |
| Route handlers compile without incompatible exports | Task 1 |
| Individual and full build share one success contract and produce a verifiable artifact | Task 2 |
| Process, memory and bundler failures are classified — no false green | Task 2 (artifact check) + Task 3 (classification) |
| Logs preserve command, duration, output and the generated app's commit | Task 3 |

## Task 1 — Route-handler export gate

Mirror the existing `scripts/check-server-actions.mjs` precedent.

What Next 16 actually rejects (verified against `next@16.2.11` in this repo):

- `next/dist/server/route-modules/app-route/module.js:176` — *"Detected default export in
  '<route>'. Export a named export for each HTTP method instead."*
- `:181` — *"No HTTP methods exported in '<route>'. Export a named export for each HTTP
  method."*
- The generated `RouteHandlerConfig` type
  (`next/dist/server/lib/router-utils/typegen.js:466`) admits only the seven HTTP methods,
  and each must be a function.

- **New** `harness/scaffolds/nextjs/scripts/check-route-handlers.mjs` — walks `apps/`,
  reads every `app/**/route.{ts,tsx,js,jsx,mjs}`, and fails on:
  - `export default` — the error Next names explicitly;
  - a route module exporting **no** HTTP method at all;
  - `export *` — opaque, and can re-export a `default`;
  - any other named export outside the allowlist: the HTTP methods
    `GET HEAD POST PUT DELETE PATCH OPTIONS`, the route segment config
    `dynamic dynamicParams revalidate fetchCache runtime preferredRegion maxDuration`,
    and `generateStaticParams`. `export type` / `export interface` are erased at compile
    time and stay allowed.

  The last rule is stricter than Next 16, which structurally tolerates an excess export.
  It is deliberate and matches the stance `check-server-actions.mjs` already takes for
  `"use server"` modules: a value exported from a framework-loaded route module is dead
  code that reads as working configuration — the exact Pages-Router habit a model brings
  to an App Router file. Error output names `file:line` and the offending identifier, and
  says where the value belongs instead.
- **Wire it in** `harness/scaffolds/nextjs/package.json`: a
  `"route-handlers:check": "node scripts/check-route-handlers.mjs"` script, and add it to
  the `build` chain next to the two existing checks.
- **Gate every task, not just the final build**: add `route-handlers:check` to the
  `verify-task` step's required `scripts` in `workflows/web-app-v1.yaml`, beside
  `server-actions:check`.
- **Tell the agent the rule**: one line in `harness/stacks/nextjs.md` naming the allowed
  route-handler exports.

Tests: `packages/harness/src/scaffold-route-handlers.test.ts`, following
`scaffold-server-actions.test.ts` exactly (spawn the script over a temp workspace).
Cases: shipped scaffold passes; `export const revalidate` passes; `export const config`
fails; `export default` fails; `export type` passes; a non-route file with the same export
passes; `node_modules`/`.next`/`dist` ignored.

## Task 2 — One build contract, one verifiable artifact

- `harness/scaffolds/nextjs/package.json` `build` becomes:

  ```
  node scripts/check-service-role.mjs && node scripts/check-server-actions.mjs
    && node scripts/check-route-handlers.mjs
    && pnpm --recursive --workspace-concurrency=1 build
    && node scripts/check-build-output.mjs
  ```

  `--workspace-concurrency=1` is what makes the recursive build agree with the individual
  one: packages build in dependency order, one at a time, so Turbopack never competes with
  another build for processes or memory.
- **New** `harness/scaffolds/nextjs/scripts/check-build-output.mjs` — for every
  `apps/*/package.json` that declares a `build` script, assert the artifact exists and
  print it:
  - a package that depends on `next` must have a non-empty `.next/BUILD_ID`;
  - otherwise its `tsconfig.json` `compilerOptions.outDir` (default `dist`) must exist and
    be non-empty.
  A package that declares `build` but produced nothing is a hard failure — that is the
  `pnpm -r` silent-skip false green.

Tests: `packages/harness/src/scaffold-build-output.test.ts` — missing `.next/BUILD_ID`
fails; empty `BUILD_ID` fails; present `BUILD_ID` passes and prints it; a non-Next package
with an empty `dist` fails; a package with no `build` script is ignored. Plus an assertion
in `scaffold-tooling.test.ts` that the `build` script contains
`--workspace-concurrency=1` and both new checks.

## Task 3 — Classify build failures and record the commit

`packages/contracts/src/project.ts`:

- `VerificationCommandResultSchema` gains
  `failureKind: z.enum(['check', 'timeout', 'out-of-memory', 'signal', 'spawn']).optional()`
  — set only when the command failed. `check` means the command ran to completion and
  reported a real defect; everything else means the result says nothing about the code.
- `VerificationReportSchema` gains `commit: z.string().optional()` — the generated app's
  `git rev-parse HEAD` at the moment the report was produced.

`packages/executors/src/verifier.ts`:

- `run()` classifies from the execa result: `timedOut` → `timeout`; stdout/stderr matching
  `JavaScript heap out of memory` / `FATAL ERROR: ... Allocation failed` / exit 137 →
  `out-of-memory`; any terminating signal → `signal`; a thrown spawn error → `spawn`;
  otherwise a non-zero exit is `check`. A non-`check` failure appends one diagnosis line to
  `stderr` naming what happened and the limit involved, so the repair agent and the logs
  both carry it.
- `verify()` reads the workspace `HEAD` once and puts it on the report.

Tests in `packages/executors/src/verifier.test.ts`: a script that exceeds `timeoutMs` is
`failureKind: 'timeout'` and not approved; a script exiting non-zero normally is `'check'`;
a report over a git workspace carries the current `HEAD` sha; a workspace without git
leaves `commit` undefined. Contract shape tests where `project.test.ts` covers the schemas.

## Sequencing

Tasks 1+2 share `harness/scaffolds/nextjs/package.json`, so one agent owns them. Task 3
touches only `packages/contracts` + `packages/executors` and runs in parallel.

## Verification

Per task: `npx vitest run <the touched test files>` **and** `npx tsc -b`.
Before the PR: `npm run check` (logged to a file, exit code echoed).

## Out of scope

Actually generating and building the four archetype apps end to end is the golden-journey
QA run, not a unit test — this change is what makes that run reproducible. No new
dependency, no new build tool, no bundler configuration change.
