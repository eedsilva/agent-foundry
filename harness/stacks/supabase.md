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
- Use `@supabase/ssr` for session handling in `apps/web`: one cookie-backed server client (`createServerClient`, see `apps/web/lib/supabase/server.ts`) used by server components, server actions, and middleware. Sign-in and sign-up are server actions (`apps/web/app/actions.ts`), so the browser only ever talks to the web tier.
- Protect routes in `middleware.ts` by refreshing the session and redirecting unauthenticated requests away from authenticated segments; never gate authorization in client components alone.
- Store the signed-in user's id as the row owner column (`user_id uuid references auth.users(id) default auth.uid()`) so RLS policies can reference it directly.

## The authenticated request path (ADR 0038)

- `apps/web` forwards the session's access token to `apps/api`; it never queries the database itself (`apps/web/app/page.tsx` is the pattern).
- Every `apps/api` data route lives inside the authenticated scope in `apps/api/src/server.ts`: a hook rejects missing or invalid tokens with 401, then hands the handler a per-request client from `createRequestClient` (`apps/api/src/supabase.ts`) — the anon key plus the caller's token, so RLS evaluates as that user. Add new data routes inside that scope; never construct a module-level Supabase client.
- The service-role key bypasses RLS entirely. It is allowed only under `apps/api/src/admin/`, `apps/api/src/jobs/`, and `apps/api/src/webhooks/` — the paths with no caller identity to forward. `scripts/check-service-role.mjs` runs at the front of `pnpm build` and fails it when `SUPABASE_SERVICE_ROLE_KEY` is referenced anywhere else in `apps/`.
- A forgotten authorization check therefore returns an empty result, not another tenant's rows. `browser-tests/cross-tenant-denial.json` (ADR 0020 vocabulary) asserts exactly that through the UI, and `pnpm smoke` asserts it over HTTP: 401 without a token, and a signed-in caller sees only their own rows.

## Storage

- Create a bucket per logical asset type, not one shared bucket.
- Default every bucket to private; add a storage policy mirroring the table-level RLS pattern (`bucket_id = '<name>' and owner = auth.uid()`).
- Never mark a bucket public unless the PRD explicitly calls for public asset delivery.

## Environment and secrets

- Local Supabase URL and keys live in `.env`, git-ignored, written by `pnpm db:start` or by the platform's credential bridge (ADR 0034); ship `.env.example` with variable names only, never values.
- `.env` also carries `SUPABASE_PROJECT_ID` and the project's `SUPABASE_*_PORT` block, allocated on first start so two projects can run at once. Never hard-code 54321.
- Every variable a tier reads is checked at that tier's boot (`apps/api/src/env.ts`), so a missing value fails on start, naming itself, rather than surfacing later inside a client call.
- The service-role key never leaves `apps/api/src/{admin,jobs,webhooks}/` (see "The authenticated request path" above); it must not be read anywhere in `apps/web` or on the API tier's request path, and the build check enforces that.
- Reference `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` for anon-key clients; the service-role key uses a non-`NEXT_PUBLIC_` name.
