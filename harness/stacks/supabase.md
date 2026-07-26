# Stack: Supabase backend conventions

Applies whenever the golden stack's backend is the project's isolated local Supabase Docker stack (ADR 0007). Every generated project uses exactly one Supabase instance; never point a generated app at Supabase Cloud or another project's stack.

## Migrations

- Forward-only. Never edit an applied migration; add a new one.
- One file per change under `supabase/migrations/<timestamp>_<name>.sql`, timestamp `YYYYMMDDHHMMSS`.
- Postgres DDL is transactional by default; only wrap a migration in explicit `begin;`/`commit;` when the statement set specifically requires it.
- Never generate a `down` migration. Rollback is a new forward migration that reverses the change.
- `supabase start` applies every migration and then `supabase/seed.sql`; `pnpm db:reset` replays both from scratch.
- After any schema change, regenerate the committed types with `pnpm db:types` (`supabase gen types typescript --local` into `apps/api/src/database.types.ts`). CI fails when they drift.

## Row Level Security

- Enable RLS on every table holding user data: `alter table <table> enable row level security;` in the same migration that creates the table.
- Default-deny: no table is queryable until a policy exists. Write explicit `select`/`insert`/`update`/`delete` policies scoped to `auth.uid()`.
- Name policies `<table>_<operation>_<scope>` (e.g. `tasks_select_owner`) so intent is legible in `supabase db diff`.
- Never grant `anon` write access to a user-data table.
- `supabase/migrations/20260726000000_rls_baseline.sql` applies this pattern (table, owner column, RLS, four owner policies) to the scaffold's `items` table — copy it into a new migration for each table you add.
- Index the owner column every policy filters on, as the baseline does.

## Auth

Every app ships with Supabase auth wired end to end: sign-in flow, protected routes, and session handling.

- Email/password only. No OAuth, magic links, or SMTP; password reset is an administrator operation (per ADR 0007 / `docs/PRODUCT_CONTRACT.md`).
- Use `@supabase/ssr` for session handling: a browser client (`createBrowserClient`) for client components and a server client (`createServerClient`) that reads/writes cookies for server components, route handlers, and middleware.
- Protect routes in `middleware.ts` by refreshing the session and redirecting unauthenticated requests away from authenticated segments; never gate authorization in client components alone.
- Store the signed-in user's id as the row owner column (`user_id uuid references auth.users(id) default auth.uid()`) so RLS policies can reference it directly.

## Storage

- Create a bucket per logical asset type, not one shared bucket.
- Default every bucket to private; add a storage policy mirroring the table-level RLS pattern (`bucket_id = '<name>' and owner = auth.uid()`).
- Never mark a bucket public unless the PRD explicitly calls for public asset delivery.

## Environment and secrets

- Local Supabase URL and keys live in `.env`, git-ignored, written by `pnpm db:start` or by the platform's credential bridge (ADR 0034); ship `.env.example` with variable names only, never values.
- `.env` also carries `SUPABASE_PROJECT_ID` and the project's `SUPABASE_*_PORT` block, allocated on first start so two projects can run at once. Never hard-code 54321.
- Every variable a tier reads is checked at that tier's boot (`apps/api/src/env.ts`), so a missing value fails on start, naming itself, rather than surfacing later inside a client call.
- The service-role key never leaves server-only code paths (route handlers, server actions); it must not be imported into any file reachable from a client bundle.
- Reference `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the browser client; the service-role key uses a non-`NEXT_PUBLIC_` name.
