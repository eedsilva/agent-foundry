# Issue #292 — Idle generated-project environments are never stopped

## Context

`SupabaseGeneratedProjectRuntime` implements `stop()` and `cleanup()`, but nothing in the
control plane ever calls either. `ProjectService` only calls `initialize()`. `apps/api/src/index.ts`
wires a preview reaper, an artifact reaper and blob GC — there is no environment reaper.

Consequence: every real-mode project pins a ~10-container Supabase stack for the lifetime of the
host. Repeated project creation exhausts Docker memory and the address pool, and the *next*
project's `supabase start` fails nondeterministically (see #295/#296).

Fix: an interval sweep in `apps/api` that stops environments that are idle. `cleanup()` is
destructive and gated on `DestructiveEnvironmentConfirmation` — reclamation routes through
`stop()` only (containers down, volumes intact). Restarting is `start()`, which already exists.

## Design

An environment is **idle** when all three hold:

1. its persisted `health.state` is not already `'stopped'`;
2. the project has **no** active preview session (`previewSessions.listActive()`);
3. the project has **no** non-terminal workflow run (`runs.list(projectId)`; terminal =
   `completed | failed | cancelled | rejected`);
4. its `updatedAt` is older than `ENVIRONMENT_IDLE_MS` (grace period after the last lifecycle op).

Guards 2 and 3 exist because stopping a stack under a live preview or a running build would break
the generated app's database mid-flight. The preview reaper already retires idle preview sessions,
so the two sweeps layer: previews go first, then the environment behind them.

`inspect()` cannot be used for enumeration — it shells out to `supabase status` per project and
rewrites `updatedAt`, which would destroy the idleness signal. The sweep needs a metadata-only read.

## Global Constraints

- **Node/TypeScript, ESM.** Relative imports inside a package carry the `.js` extension.
- `exactOptionalPropertyTypes` is on: build optional properties with spread
  (`...(x !== undefined ? { x } : {})`), never `x: undefined`.
- **Never** call `cleanup()`, `reset()`, `supabase stop --no-backup`, or delete a workdir from the
  sweep. `stop()` only.
- New tests land in existing vitest globs — `packages/platform/src/*.test.ts` (fast bucket),
  `apps/api/src/*.test.ts` and `packages/composition/src/*.test.ts` (slow bucket). Do **not** edit
  the fast/slow lists in `package.json`.
- Every task that touches `.ts` must run `npx tsc -b` (per-package or root) as well as vitest.
- Follow the existing reaper shape: `startIntervalSweep` from `apps/api/src/interval-sweep.ts`,
  mirroring `preview-reaper.ts` / `artifact-reaper.ts`.
- Secrets discipline: never log stdout/stderr from Supabase, DB URLs, JWTs, or ports. The sweep may
  log `projectId` and a count only.

## Task 1 — `listEnvironments()` on the runtime port

**Files:** `packages/domain/src/ports.ts`, `packages/platform/src/supabase-runtime.ts`,
`packages/platform/src/supabase-runtime.test.ts`.

Add to `interface GeneratedProjectRuntime` (`packages/domain/src/ports.ts`, near `inspect`):

```ts
  /**
   * Every project environment that has persisted metadata on disk, read from
   * metadata only — it never shells out to the container runtime and never
   * bumps `updatedAt`, so callers can use `updatedAt` as an idleness signal.
   * Unreadable or schema-invalid metadata is skipped, not thrown.
   */
  listEnvironments(): Promise<AppEnvironment[]>;
```

Implement on `SupabaseGeneratedProjectRuntime`. Environment metadata lives at
`<dataDir>/projects/<projectId>/environment/environment.json` (see the existing `environmentDir`
and `metadataPath` helpers). The implementation reads the directory entries of
`<dataDir>/projects`, and for each reuses the existing private `#read(projectId)` path so the
returned records get the same `projectResources` normalization every other read gets.

Requirements:

- A missing `<dataDir>/projects` directory returns `[]` — it must not throw.
- A project directory with no `environment/environment.json` is skipped.
- A project directory whose `environment.json` is corrupt (invalid JSON or fails
  `AppEnvironmentSchema`) is skipped, not thrown — one bad file must not disable the sweep.
- A directory entry whose name is not a valid path segment is skipped (`parsePathSegment` throws;
  do not let it escape).
- Only directories are considered.

**Tests (TDD, write first):** in `packages/platform/src/supabase-runtime.test.ts`, following the
file's existing fixture style — returns `[]` with no data dir; returns the environments of two
initialized projects; skips a project dir with no environment metadata; skips a corrupt
`environment.json` while still returning the good sibling; does not run any supabase command
(assert the stub command recorded no invocation).

**Also update:** the fake/stub `GeneratedProjectRuntime` implementations that must satisfy the full
interface. Grep for `implements GeneratedProjectRuntime` and for object literals typed as
`GeneratedProjectRuntime` (e.g. `packages/orchestrator/src/testing/harness.ts`) and add the method.
Call sites that use `Pick<GeneratedProjectRuntime, ...>` need no change.

**Verify:** `npx vitest run packages/platform/src/supabase-runtime.test.ts` and `npx tsc -b`.

## Task 2 — Config keys

**Files:** `packages/composition/src/config.ts`, `packages/composition/src/config.test.ts`,
`.env.example`.

Add to the zod env schema, beside `ARTIFACT_REAP_INTERVAL_MS`:

```ts
    ENVIRONMENT_REAP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    ENVIRONMENT_IDLE_MS: z.coerce.number().int().positive().default(1_800_000),
```

Surface them on `RuntimeConfig` as `environmentReapIntervalMs` and `environmentIdleMs`, mapped in
`loadRuntimeConfig` exactly like the artifact keys (plain assignment, not conditional spread —
they always have a default).

`.env.example`: add both beside `SUPABASE_PROVISIONING_TIMEOUT_MS`, with a one-line comment saying
idle stacks are stopped (containers down, volumes intact) and restart on next use.

**Tests (TDD, write first):** in `packages/composition/src/config.test.ts`, following the file's
existing style — defaults are `60_000` / `1_800_000`; explicit env values are honoured; a
non-positive value is rejected.

**Verify:** `npx vitest run packages/composition/src/config.test.ts` and `npx tsc -b`.

## Task 3 — The environment reaper and its wiring

**Files:** `apps/api/src/environment-reaper.ts` (new),
`apps/api/src/environment-reaper.test.ts` (new), `apps/api/src/index.ts`.

New module, mirroring `preview-reaper.ts`:

```ts
export interface EnvironmentReaperDeps {
  environments: Pick<GeneratedProjectRuntime, 'listEnvironments' | 'stop'>;
  previewSessions: Pick<PreviewSessionRepository, 'listActive'>;
  runs: Pick<WorkflowRunRepository, 'list'>;
}

/** Stops every idle environment. Returns how many were stopped. */
export async function sweepIdleEnvironments(
  deps: EnvironmentReaperDeps,
  idleMs: number,
  now: Date,
): Promise<number>;

export function startEnvironmentReaper(
  deps: EnvironmentReaperDeps,
  intervalMs: number,
  idleMs: number,
  logger: EnvironmentReaperLogger,
  app: FastifyInstance,
): IntervalSweepSchedule;
```

`sweepIdleEnvironments` behaviour:

- Call `listEnvironments()` once and `previewSessions.listActive()` once per sweep (not per
  environment); build the set of project IDs with an active preview from that one call.
- For each environment, skip when `health.state === 'stopped'`, when the project has an active
  preview session, when `runs.list(projectId)` contains a run whose status is not one of
  `completed | failed | cancelled | rejected`, or when
  `now.getTime() - Date.parse(environment.updatedAt) < idleMs`.
- Otherwise `await deps.environments.stop(projectId)`, count it, and `logger.info` one line with
  the `projectId` (no ports, no URLs).
- A `stop()` that rejects for one project is logged via `logger.error` and must not abort the
  sweep — the remaining environments are still evaluated. The sweep resolves with the count of
  environments actually stopped.
- Stop sequentially, not with `Promise.all` — `supabase stop` is heavy and concurrent Docker
  teardown is what the issue is trying to avoid.

`startEnvironmentReaper` wraps `sweepIdleEnvironments` in `startIntervalSweep` with the failure
message `'Environment reaper sweep failed'`.

Wire in `apps/api/src/index.ts` beside the other reapers, **only when
`runtime.generatedProjectRuntime` is defined** (it is undefined outside real mode):

```ts
if (runtime.generatedProjectRuntime) {
  startEnvironmentReaper(
    {
      environments: runtime.generatedProjectRuntime,
      previewSessions: runtime.previewSessions,
      runs: runtime.runs,
    },
    runtime.config.environmentReapIntervalMs,
    runtime.config.environmentIdleMs,
    app.log,
    app,
  );
}
```

**Tests (TDD, write first):** `apps/api/src/environment-reaper.test.ts`, with hand-written stub
deps (no Docker, no Supabase) — an idle environment is stopped; an environment younger than
`idleMs` is not; an already-`stopped` environment is not; an environment whose project has an
active preview session is not; an environment whose project has a `running` (non-terminal) run is
not, while one whose only run is `completed` is; a failing `stop()` is logged and the sweep still
stops the other environments and returns the surviving count; `listActive()` is called once per
sweep regardless of environment count.

**Verify:** `npx vitest run apps/api/src/environment-reaper.test.ts` and `npx tsc -b`.

## Task 4 — Operator documentation

**Files:** `docs/OPERATIONS.md`.

In the generated-project runtime section (around the `SUPABASE_PROVISIONING_TIMEOUT_MS` paragraph
and the `DATA_DIR/projects/<projectId>/environment/` paragraph), add a short subsection, in
Portuguese to match the surrounding document, covering: the idle sweep exists and runs every
`ENVIRONMENT_REAP_INTERVAL_MS`; what counts as idle (the four conditions above); that it calls
`stop()` and never `cleanup()`/`reset()`, so volumes and data survive and the next lifecycle
operation restarts the stack; and how to disable it in practice (set `ENVIRONMENT_IDLE_MS` very
high).

Use exact `old_string`/`new_string` anchors — do not restructure the surrounding document.

**Verify:** `npm run format:check` (or `npx prettier --check docs/OPERATIONS.md`).

## Out of scope (state in the PR)

- **No API route** for manual stop/cleanup. The leak the issue reports is the absence of any
  automatic path; a manual endpoint is a separate feature, and `cleanup()` needs its destructive
  confirmation contract designed on top of an HTTP surface.
- **No docker-label orphan sweep** for stacks whose workdir no longer exists (the
  `docker ps --filter label=com.docker.compose.project=...` case in the issue's first comment).
  With the sweep in place, workdirs stop being abandoned in the healthy path; reclaiming
  pre-existing orphans is a one-off operator action, not control-plane code.
