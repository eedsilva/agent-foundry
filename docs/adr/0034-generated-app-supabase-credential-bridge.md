# ADR 0034: Supabase connection credentials bridged into the per-project `.env`

- Status: Accepted
- Date: 2026-07-23
- Owners: Platform

## Context

Issue #71 requires every generated project to ship working email/password auth against its own
isolated local Supabase stack. The auth UI already existed (`harness/scaffolds/nextjs`, from #256/#266):
`app/sign-up/page.tsx`, `app/sign-in/page.tsx`, and `middleware.ts` all call `@supabase/ssr`, reading
`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` from `process.env`. Nothing populated
those variables. `SupabaseGeneratedProjectRuntime#initialize` (`packages/platform/src/supabase-runtime.ts`,
ADR 0030) parses `supabase status --output json` but `publicStatus()` deliberately keeps only
credential-free endpoint fields (`API_URL`, `GRAPHQL_URL`, `STUDIO_URL`, `INBUCKET_URL`) for the persisted
`AppEnvironment` record — `ANON_KEY` and `SERVICE_ROLE_KEY` were parsed and then discarded, by design,
since `AppEnvironment` is read by inspect/health endpoints that must never leak a secret. Without a
credential path of its own, the scaffold's Supabase clients construct with `undefined` values and fail
closed.

ADR 0033 (#74) built exactly the delivery mechanism this needs — a per-project `.env` at
`<DATA_DIR>/projects/<projectId>/.env`, read by `FileSecretStore` and resolved into the generated app's
dev-server subprocess by `NodePreviewRunner.attemptSpawn`, the only call site that ever sees a secret
value — but scoped it to an **operator-created** file: "`SecretStore`/`FileSecretStore` are read-only
against an operator-created file; nothing is written or migrated by this change." That file has no
automated writer today.

## Decision

`SupabaseGeneratedProjectRuntime#initialize` becomes a second, automated writer of that same `.env` file,
for exactly three platform-managed keys: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and
`SUPABASE_SERVICE_ROLE_KEY`. `credentialsFromStatus` (`packages/platform/src/supabase-secrets.ts`) parses
the same `supabase status --output json` stdout `publicStatus()` already receives, but independently —
`publicStatus()`'s credential-free contract for `AppEnvironment` is untouched; the two parses read the
same stdout for two different destinations with two different trust levels. `upsertEnvVars` merges these
three keys into the file's existing text, preserving every other line untouched — a line-based
KEY=value rewrite, not a full `dotenv` round-trip, because the only thing this ever needs to preserve is
"everything that isn't one of these specific keys," which a full parser would not do any more precisely.
`#writeAppSecrets` (`packages/platform/src/supabase-runtime.ts`) does the actual read-merge-atomic-write
against `<DATA_DIR>/projects/<projectId>/.env` — a sibling of, not inside, the git-tracked `workspace/`
directory, matching `WorkspaceManager.projectRoot`.

No new call site or trust boundary is introduced: `NodePreviewRunner.attemptSpawn` already resolves this
file into the dev-server subprocess env for any operator-set secret (ADR 0033); this ADR only adds a
second writer to the file that mechanism already reads. The credentials still never reach `AppEnvironment`,
an event, a log, or an artifact — `#writeAppSecrets` writes directly to the `.env` file and returns
nothing.

A related, smaller decision in the same change: `configureGeneratedAuth`
(`packages/platform/src/supabase-auth.ts`) patches the generated `config.toml`'s `[auth.email]` section to
`enable_confirmations = false`, chained into the same `configureProject` write as
`configureGeneratedStorage` (ADR 0032). Local stacks have no SMTP (`harness/stacks/supabase.md`: "no
external services"), so a confirmation-gated signup would leave every generated account permanently
unconfirmable; disabling confirmation makes signup return an active session immediately, matching the
scaffold's sign-up flow.

## Alternatives considered

- **Add credential fields to `AppEnvironment`**: rejected. `CredentialFreeEndpointSchema` is a deliberate
  boundary from #69/#70 — `AppEnvironment` is read by `inspect`/`health` and persisted to
  `environment.json`; carrying a secret through it would need every future reader of that type to
  re-justify not leaking it, instead of the credential simply never being on that type at all.
- **Inject credentials directly at `NodePreviewRunner`'s spawn call, bypassing the `.env` file**: rejected.
  `NodePreviewRunner` is backend-agnostic by design (ADR 0033) — it resolves whatever `SecretStore` gives
  it, with no knowledge of Supabase specifically. Special-casing Supabase there would couple a generic
  preview mechanism to one specific generated-project backend, duplicating the exact file-based
  injection surface #74 already built.
- **Let the coding agent read `supabase status` and write its own `.env`**: rejected for the same reason
  ADR 0033 rejected letting the agent read `.env` at all — the agent's CLI subprocess must not gain
  filesystem access to the project's secrets file, regardless of which process would have produced it.

## Consequences

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are now
platform-reserved key names in a project's `.env`: `initialize()` overwrites them on every fresh
provision, so an operator should not repurpose those three names for an unrelated secret. Every other key
in the file is left untouched. The service-role key sits in the same file and trust boundary as any other
operator secret and is resolved only into the dev-server subprocess, under the same
`pickSafeEnvironment()` + `extendEnv: false` enforcement ADR 0033 already established — this change adds a
writer, not a new reader or a new subprocess boundary.

Disabling email confirmation means the generated app's local Supabase project has no working
confirmation flow at all; this is a Personal-v1, no-SMTP-only decision (`harness/stacks/supabase.md`) and
would need to be revisited before any generated app could ever target hosted Supabase.

## Validation and rollback

`packages/platform/src/supabase-secrets.test.ts` covers `credentialsFromStatus` (valid/invalid/missing
fields) and `upsertEnvVars` (append, overwrite-in-place, preserve-unrelated-keys, quoting) in isolation.
`packages/platform/src/supabase-auth.test.ts` covers `configureGeneratedAuth`'s three config.toml shapes.
`packages/platform/src/supabase-runtime.test.ts` adds integration cases: `initialize()` writes the three
keys while preserving an existing operator secret, never leaks them into `AppEnvironment` or
`environment.json`, and correctly no-ops when `supabase status` doesn't return them. Real-stack proof
against a live local Supabase project is `packages/platform/src/supabase-auth.e2e.test.ts` (env-gated,
`auth-e2e` CI job) and the local-only Playwright spec `apps/api/e2e/generated-app-auth.spec.ts`, which
boots the actual scaffold files under a real Next.js dev server and drives signup/login/logout through a
real browser.

Rollback: revert the `credentialsFromStatus`/`#writeAppSecrets` call in `initialize()` and the
`configureGeneratedAuth` call in `configureProject`. The `.env` file itself is not migrated or versioned,
so there is no data to unwind — a reverted deploy simply stops writing those three keys on the next
`initialize()`, and the scaffold's Supabase clients fail closed exactly as they did before this change.
