# Plan: deterministic local Supabase bootstrap in the generated app (#560)

Spec: GitHub issue #560 (`eedsilva/agent-foundry`), child of #98.

## Spec, restated

A generated app on a clean macOS machine must bring up its own Supabase stack,
apply schema, seed, hand the preview the right public URL and key, and let the
browser sign in as the seeded user and persist a row. The real QA run failed
repeatedly at `db:start`, reset, type generation, seed and environment
variables, and surfaced as `Invalid login credentials` in the browser because
the database/seed never became available.

Acceptance criteria (verbatim intent):

1. A clean macOS environment starts local Supabase with no manual port fiddling.
2. Schema, types and seed complete and produce documented test credentials.
3. The preview receives the correct public URL and key from the local stack.
4. The browser authenticates as the seeded user and completes one persisted operation.
5. Logs record port allocation, health, seed and failures, actionably.

## What is already true (do not rebuild)

- `harness/scaffolds/nextjs/scripts/db.mjs` allocates a per-workspace Compose
  project id and a four-port block, starts the stack, and writes
  `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY` into the workspace `.env` from
  `supabase status --output json`.
- `harness/scaffolds/nextjs/supabase/seed.sql` seeds `owner@example.com` and
  `other@example.com` (password `password123`) plus their `auth.identities`
  rows and `public.items` rows.
- `harness/scaffolds/nextjs/scripts/smoke.mjs` already signs in as the seeded
  user over HTTP and asserts RLS cross-tenant denial, and
  `browser-tests/cross-tenant-denial.json` does the same through the UI. Both
  prove **sign-in and read**; neither writes a row. AC 4's persisted-operation
  half is proved by `scripts/database-row-match.mjs`, which the validation
  campaign drives with `AGENT_FOUNDRY_VALIDATION_ROW_TITLE_SHA256` and
  `AGENT_FOUNDRY_VALIDATION_RUN_STARTED_AT` to confirm a row the browser created
  really landed in Postgres. This plan re-proves none of the three: the reported
  failure was upstream of all of them.
- The platform path (`packages/platform/src/supabase-runtime.ts`) has its own
  allocator and writes the same three credentials to
  `dataDir/projects/<id>/.env`, which `NodePreviewRunner` spreads into the dev
  server's environment.

## Root causes this plan fixes

- **R1 — a claimed port block is never re-allocated.** `db.mjs` allocates only
  when `SUPABASE_PROJECT_ID` is absent from `.env`. Once a block is recorded,
  every later `db:start` reuses it; if a sibling project took one of those
  ports while this stack was stopped, `supabase start` fails on a bound port
  and keeps failing forever with no path out but hand-editing `.env`. This is
  the `ponytail:` limitation already noted at `db.mjs:56-60`, and it is AC 1.
- **R2 — a stack that came up without its seed reports success.** `db:start`
  ends at "credentials written to .env" whether or not `supabase/seed.sql`
  applied. A stack with no seeded user is indistinguishable from a good one
  until the browser answers `Invalid login credentials` — the exact reported
  symptom. AC 2 and AC 5.
- **R3 — the web tier never reads the workspace `.env`.** `pnpm db:start` writes
  `.env` at the generated app's root; `pnpm dev` runs `next dev` with cwd
  `apps/web`, and `@next/env`'s `loadEnvConfig(dir)` reads `.env*` only from
  `join(dir, …)` — the Next project directory, which the scaffold ships without
  a `.env`. `apps/api/src/env.ts` loads the root file explicitly for its own
  tier; nothing does so for the web tier. `pnpm smoke` masks this because it
  loads the root `.env` into its own process before spawning `pnpm dev`. AC 3.
- **R4 — the platform's credential write is skipped in silence.**
  `credentialsFromStatus` (`packages/platform/src/supabase-secrets.ts`) returns
  `undefined` for any partial `supabase status` payload, and
  `SupabaseGeneratedProjectRuntime` then skips `#writeAppSecrets` with no error
  and no log, leaving the preview to boot against a `.env` with missing or
  stale Supabase credentials. AC 3 and AC 5.
- **R5 — the scaffold's `config.toml` leaves email confirmation to the CLI
  default.** `configureGeneratedAuth` forces `enable_confirmations = false` on
  the platform path because the scaffold disables inbucket and has no SMTP; the
  shipped `config.toml` states no `[auth.email]` section at all, so the
  scaffold's own `db:start` depends on a CLI default it does not pin. AC 2.

## Global constraints

- `harness/scaffolds/nextjs/scripts/*.mjs` stays **dependency-free** and must run
  before `pnpm install` has worked, from a directory copied out of the repo.
  Node built-ins only.
- Scaffold files must pass `git diff --check` — no trailing blank line, no
  trailing whitespace.
- Scaffold script tests follow the established pattern in
  `packages/harness/src/scaffold-db-script.test.ts`: copy the real files into a
  `mkdtemp` workspace, put a stub `supabase` shell script on `PATH`, drive the
  real script with `spawnSync`, and assert on exit status, stderr and the
  on-disk `.env`. No mocking of internals.
- Every behaviour change lands test-first (red, then green).
- New tests that bind ports, spawn processes or use containers belong to the
  slow bucket; `packages/harness/src/scaffold-db-script.test.ts` is already in
  the slow bucket, so extending it needs no `package.json` change. Adding a
  **new** test file requires updating both the fast `--exclude` globs and the
  slow positional list in the root `package.json` so they stay an exact
  partition (`npx vitest list --filesOnly` to verify).
- Comments explain *why*, tied to the failure or the ADR, matching the
  surrounding prose style. Deliberate ceilings get a `ponytail:` comment.
- Every task that touches `.ts` runs `npx tsc -b` in addition to its tests.
- Do not change `packages/platform/src/supabase-runtime.ts`'s allocator or
  merge it with the scaffold's — they solve different problems and the plan
  keeps them apart.

## Task 1 — re-allocate a port block that is no longer usable (R1, AC 1, AC 5)

`harness/scaffolds/nextjs/scripts/db.mjs`.

On `start`, a recorded block must be verified before it is reused:

- If `.env` already carries `SUPABASE_PROJECT_ID` and the port block, probe the
  block. If every port is free, keep it (nothing changes today's behaviour).
- If some port is bound, the block is either **this** project's stack already
  running — in which case reusing it is correct and required — or a sibling's.
  Distinguish them by asking the CLI: `supabase status --output json` in this
  workspace succeeds when this project's own stack is up. If it succeeds, keep
  the block. If it fails, the block belongs to someone else: allocate a fresh
  one and rewrite `.env`.
- `allocate()` must skip a block whose ports are bound, exactly as it does now.
- Log the outcome on one line in the existing `db: …` prose style: the project
  id and the four ports when a block is allocated or re-allocated, so AC 5's
  "port allocation" is in the log.

Tests (extend `packages/harness/src/scaffold-db-script.test.ts`):

- A workspace whose recorded block is bound by another listener, and whose
  `supabase status` fails, gets a different block on the next `start`, and the
  new block's ports are free.
- A workspace whose recorded block is bound but whose `supabase status`
  succeeds keeps its block (this is the running-stack case; today's
  "keeps the block it already allocated" test must still pass).
- `start` logs the allocated project id and ports.

The stub CLI in that file needs a way to make `status` fail; extend it in the
same shape it already has (an environment variable the test sets), do not
introduce a second stub.

## Task 2 — refuse to report success for an unseeded stack (R2, AC 2, AC 5)

`harness/scaffolds/nextjs/scripts/db.mjs`.

After `start` writes the credentials, and after `db reset`, verify the seed
actually landed before the script exits 0:

- Ask GoTrue for a password grant as the documented seed user
  (`owner@example.com` / `password123`) at
  `<API_URL>/auth/v1/token?grant_type=password` with the anon key. A 200 proves
  the migration, the seed, and auth are all live — it is the same request
  `smoke.mjs` makes, and the same one the browser makes.
- Poll with a short bounded deadline (a few tens of seconds, one attempt per
  second) so a stack whose GoTrue is still warming up is not reported as
  unseeded. State the bound in a comment.
- On success, log one line naming the verified seed user.
- On failure, exit non-zero with a message that names `supabase/seed.sql`,
  quotes the HTTP status and body, and says to run `pnpm db:reset`. This is the
  line that must appear instead of the browser's `Invalid login credentials`.
- The probe must not fire for an app that legitimately rewrote its seed. Run it
  only when `supabase/seed.sql` still declares the documented user — a
  `readFileSync` plus a substring test on the email is enough. When it does not,
  log one line saying the seed check was skipped because `seed.sql` no longer
  declares that user, and exit 0. Without this guard the check turns every
  app that customises its seed into a permanently failing `db:start`, which is
  worse than the bug being fixed.
- Add a `ponytail:` comment recording the ceiling: proving the seed applied is
  reduced to "the documented seed user can sign in", because a workspace has no
  dependency-free way to query `auth.users` directly.
- `db reset` runs the same verification. Nothing else about `db reset` changes;
  in particular it does **not** regenerate types — `pnpm db:types` stays the
  explicit step the stack conventions already mandate.

Tests (extend the same file, using the stub CLI):

- `start` against a stub whose stack answers the password grant with 200 exits 0
  and logs the verified user.
- `start` against a stub whose stack answers 400 exits non-zero, and stderr
  names `seed.sql` and `pnpm db:reset`.
- `db reset` runs the same verification.
- A workspace whose `seed.sql` no longer declares the documented user skips the
  probe and exits 0, logging why.

The probe talks HTTP, so the test needs a real listener rather than a stub
binary: start a `node:http` server in the test, and have the stub `supabase
status` report its address as `API_URL`. Keep the deadline short enough under
test (an environment variable read by the script, defaulted to the real bound)
that the failure case does not stall the suite.

## Task 3 — the web tier reads the workspace `.env`, and auth is pinned (R3, R5, AC 2, AC 3)

Two independent scaffold files, one task.

`harness/scaffolds/nextjs/scripts/dev.mjs` (new) and the root `package.json`'s
`dev` script:

- `pnpm dev` currently runs `pnpm --recursive --parallel dev`, which starts
  `next dev` with cwd `apps/web`. `@next/env`'s `loadEnvConfig(dir)` reads
  `.env*` from `join(dir, …)` where `dir` is the Next project directory, so the
  workspace-root `.env` that `pnpm db:start` writes is never read by the web
  tier. Verified against the installed `@next/env`.
- Fix it in the process that spawns both tiers, not inside Next: a new
  dependency-free `scripts/dev.mjs` that loads the workspace-root `.env` and
  then spawns `pnpm --recursive --parallel dev` with stdio inherited. This is
  the same sequence `scripts/smoke.mjs` already uses (load the root `.env`, then
  spawn `pnpm dev`), which is exactly why smoke passes today while a bare
  `pnpm dev` does not. Root `package.json` becomes `"dev": "node scripts/dev.mjs"`.
- Do **not** put this in `apps/web/next.config.ts`. `@next/env` snapshots
  `process.env` on its first call and calls `replaceProcessEnv(snapshot)` on
  every reload; values injected from `next.config.ts` are outside that snapshot
  and would be dropped on the first env reload.
- **Values already present in the environment must win.** The platform's
  credential bridge (ADR 0034) injects the real credentials into the preview's
  dev-server environment, and a stale root `.env` must never overwrite them.
  `process.loadEnvFile` overwrites unconditionally, so snapshot `process.env`
  before the call and re-apply the snapshot after it — Node built-ins only, no
  dotenv parser.
- Forward the child's exit code, so a failing dev server still fails `pnpm dev`.
- Log one line naming the file it loaded, or that there was none (AC 5).
- Comment why, naming the cwd mismatch and the injected-wins rule.

`harness/scaffolds/nextjs/supabase/config.toml`:

- State `[auth.email] enable_confirmations = false` explicitly, with a comment
  that the scaffold disables inbucket and ships no SMTP, so a confirmation
  email could never be delivered — matching what `configureGeneratedAuth`
  forces on the platform path rather than depending on a CLI default.

Tests: a new file `packages/harness/src/scaffold-env.test.ts`, following the
`mkdtemp` + stub-binary-on-`PATH` + `spawnSync` pattern of
`packages/harness/src/scaffold-db-script.test.ts`. It lands in the fast bucket
by default (it matches no `--exclude` glob), so `package.json` needs no change —
confirm that with `npx vitest list --filesOnly` before committing, and if it
does need a change, update the fast `--exclude` globs and the slow positional
list together so they stay an exact partition.

Cover:

- The shipped `supabase/config.toml` disables email confirmation.
- `scripts/dev.mjs` run in a temp workspace with a root `.env` spawns the child
  with that file's values in its environment. Use a stub `pnpm` on `PATH` that
  prints the variables it received.
- A value already set in the environment survives: the stub reports the
  injected value, not the one in the `.env` file. This is the case that
  protects the platform's credential bridge, so it is not optional.
- The child's non-zero exit code is forwarded.

Also update `harness/scaffolds/nextjs/README.md` where it describes `pnpm dev`
and `.env`, and `harness/stacks/supabase.md`'s "Environment and secrets"
section, so the documented contract matches.

## Task 4 — the platform's credential write fails loudly (R4, AC 3, AC 5)

`packages/platform/src/supabase-secrets.ts` and its caller in
`packages/platform/src/supabase-runtime.ts`.

Read both first, and read the existing tests
(`packages/platform/src/*supabase-secrets*`, `*supabase-runtime*`) before
changing anything — some tests may deliberately drive the partial-status path.

- A `supabase status` payload missing any of `API_URL`, `ANON_KEY` or
  `SERVICE_ROLE_KEY` must stop being a silent `undefined` that skips
  `#writeAppSecrets`. It must surface as an actionable failure naming exactly
  which fields were absent, on the same `EnvironmentOperationError` /
  diagnostic path the runtime already uses for CLI failures — do not invent a
  new error type or a new logger.
- Redaction rules already applied to diagnostics must still hold: name the
  missing *field names*, never a value.
- If an existing test asserts the silent-skip behaviour, that test encodes the
  bug; update it and say so in the commit message.

Tests: extend the existing platform suites. Cover a payload missing one field,
a payload missing all three, and the healthy payload (unchanged).

## Verification

- Per task: the task's own test files via `npx vitest run <paths>`, plus
  `npx tsc -b --pretty false` for any task touching `.ts`.
- End of branch: `npm run check`, logged to a file with the exit code echoed —
  never piped into `tail`, which reports `tail`'s status.
- Manual, once, on this machine (Docker and the Supabase CLI are installed): in
  a throwaway copy of `harness/scaffolds/nextjs`, run `pnpm install`,
  `pnpm db:start`, and `pnpm smoke`, and capture the output as evidence that
  the bootstrap is deterministic end to end. If the run cannot complete (Docker
  address-pool exhaustion, CLI version drift), say so explicitly rather than
  claiming the criteria are met.
