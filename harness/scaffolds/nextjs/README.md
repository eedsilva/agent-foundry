# Generated app

A pnpm workspace with two tiers and its own local Supabase stack:

- `apps/web` — Next.js. Renders, signs users in, and calls the API tier. It never queries the database.
- `apps/api` — Hono. The only tier that talks to Supabase, with the caller's access token, so row level security still applies. `server.ts` runs it through the Node adapter; `worker.ts` is the Cloudflare Worker entry point.
- `supabase/` — this project's own stack: `config.toml`, forward-only `migrations/`, and `seed.sql`.

## Running it

```sh
pnpm install
pnpm db:start   # starts Supabase, applies migrations and seed, writes .env
pnpm dev        # web on :3000, api on :3001 through the Node adapter
pnpm worker:dev # the same API through Wrangler's local Worker runtime
pnpm smoke      # asserts the database and both tiers answer
pnpm db:stop    # stops the stack; data survives
```

`pnpm db:start` copies `.env.example` to `.env` on first run and fills in the Supabase URL and keys. It also assigns this project its own Compose project name and host port block, so several generated projects can run at once.

`pnpm dev` runs `scripts/dev.mjs`, which loads that root `.env` into the process before starting both tiers. `next dev` alone would never see it — it runs with `apps/web` as its working directory, and `@next/env` only reads `.env*` from there.

`pnpm worker:dev` loads the same `.env` through Wrangler. `pnpm worker:deploy` passes the two public Supabase bindings with `--var` and stops before upload if either is missing; export production values first when deploying outside the local stack.

Requires Docker and the [Supabase CLI](https://supabase.com/docs/guides/cli).

## Database

Migrations are forward-only: never edit an applied file, add a new one under `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. Enable row level security in the same migration that creates a table, and write policies scoped to `auth.uid()` — `20260726000000_rls_baseline.sql` is the pattern to copy.

After changing the schema, regenerate the TypeScript types and commit them:

```sh
pnpm db:types   # writes apps/api/src/database.types.ts
```

`pnpm db:reset` drops the database and replays every migration and the seed.

## The authenticated request path

Sign-in and sign-up are server actions in `apps/web/app/actions.ts`; the session lives in cookies and the browser never talks to Supabase or the API tier directly. Pages forward the session's access token to `apps/api`, whose authenticated scope (`apps/api/src/server.ts`) rejects requests without a valid token and builds a per-request Supabase client from the anon key plus that token (`apps/api/src/supabase.ts`) — so row level security evaluates as the caller, and a forgotten authorization check returns an empty result instead of another account's rows (ADR 0038).

The service-role key bypasses RLS and is never available to the generated runtime. `pnpm build` fails if `SUPABASE_SERVICE_ROLE_KEY` is referenced anywhere under `apps/` (`scripts/check-service-role.mjs`). Local database scripts outside `apps/` may use it for setup and smoke checks.

`browser-tests/cross-tenant-denial.json` is the declarative browser assertion (ADR 0020) that proves the boundary and persistence end to end: sign in as `owner@example.com`, see that account's two items, create `Browser-created item` through the web tier, and assert the other account's row never renders. `pnpm smoke` proves the same boundary over HTTP.

Seeded accounts, both with the password `password123`:

| Email               | Items                   |
| ------------------- | ----------------------- |
| `owner@example.com` | First item, Second item |
| `other@example.com` | Another account's item  |
