# Generated app

A pnpm workspace with two tiers and its own local Supabase stack:

- `apps/web` — Next.js. Renders, signs users in, and calls the API tier. It never queries the database.
- `apps/api` — Fastify. The only tier that talks to Supabase, with the caller's access token, so row level security still applies.
- `supabase/` — this project's own stack: `config.toml`, forward-only `migrations/`, and `seed.sql`.

## Running it

```sh
pnpm install
pnpm db:start   # starts Supabase, applies migrations and seed, writes .env
pnpm dev        # web on :3000, api on :3001
pnpm smoke      # asserts the database and both tiers answer
pnpm db:stop    # stops the stack; data survives
```

`pnpm db:start` copies `.env.example` to `.env` on first run and fills in the Supabase URL and keys. It also assigns this project its own Compose project name and host port block, so several generated projects can run at once.

Requires Docker and the [Supabase CLI](https://supabase.com/docs/guides/cli).

## Database

Migrations are forward-only: never edit an applied file, add a new one under `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`. Enable row level security in the same migration that creates a table, and write policies scoped to `auth.uid()` — `20260726000000_rls_baseline.sql` is the pattern to copy.

After changing the schema, regenerate the TypeScript types and commit them:

```sh
pnpm db:types   # writes apps/api/src/database.types.ts
```

`pnpm db:reset` drops the database and replays every migration and the seed.

Seeded accounts, both with the password `password123`:

| Email               | Items                   |
| ------------------- | ----------------------- |
| `owner@example.com` | First item, Second item |
| `other@example.com` | Another account's item  |
