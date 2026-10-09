# Cloudflare stack for generated apps (research, 2026-10-08)

Question: what should Agent Foundry's generated apps (today Next.js + Supabase) use if they move entirely onto Cloudflare, so that agents can develop and test locally and then deploy?

Sources are primary (Cloudflare docs and changelog, OpenNext, vinext, Hono, Better Auth, Drizzle) unless marked **[unverified]**. Every source was fetched on 2026-10-08.

## 0. Context that changes the picture (Sept 2026)

- **There is a new `cf` CLI, in beta (2026-09-28).** It covers the public Cloudflare API with more than 2,900 commands, most of which print JSON. It handles `cf dev`, `cf build` and `cf deploy`, uses a typed `cloudflare.config.ts`, and provides `cf migrate` to convert a Wrangler config. The changelog warns: "Commands, configuration, and Build Output can change before the stable release." <https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta/>
- **Wrangler is on a sunset path, but it is still the stable tool.** It gets maintenance for 18 months after the `cf` beta ends <https://blog.cloudflare.com/cloudflare-cf-cli-launch/>. `cf` "does not yet cover every Wrangler task". The gaps include tail, Durable Object migrations, Workflows and Containers <https://developers.cloudflare.com/cf/wrangler/>.
- **Miniflare v5 (2026-09-08)** replaced the per-resource persistence options with one shared persistence root, and moved the local `/cdn-cgi` routes to `/cdn-cgi/local` <https://developers.cloudflare.com/changelog/post/2026-09-08-miniflare-v5/>.
- **The Worker size cap is now 64 MiB uncompressed on both Free and Paid (2026-09-04).** The old 3 MiB / 10 MiB compressed limits are gone <https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/>. The OpenNext docs still quote 3/10 MiB and are stale on this point <https://opennext.js.org/cloudflare>.
- **Testing package rename.** Cloudflare now documents `@cloudflare/vitest-plugin`, which needs Vitest 4.1 or later. `@cloudflare/vitest-pool-workers` gets a migration guide <https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/>.

## 1. Pages vs Workers

The Pages docs carry a banner: "Are you sure you want to use Pages? ... Start new projects with Workers." <https://developers.cloudflare.com/pages/>

Workers with static assets also has features that Pages lacks:
- the Vite plugin
- gradual deployments
- cron
- queue consumers
- Workers Logs and source maps
- simpler Durable Objects

Workers still lags Pages in three places: custom branch aliases ("coming soon"), configurability of branch deploys, and custom domains outside a Cloudflare zone <https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/>.

**Verdict:** use Workers with static assets. Do not use Pages.

## 2. Framework options

| | (a) Next.js + OpenNext | (b) Next.js + vinext | (c) Vite + React (+ RR framework) + Hono |
|---|---|---|---|
| Cloudflare's stance | Alternative "for existing OpenNext apps that cannot yet migrate" | **Default** way to run Next.js on Workers. Labeled "vinext is in beta" | First-class. The Vite plugin officially supports React Router (v8) and TanStack Start |
| Sources | <https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/> | same page; <https://github.com/cloudflare/vinext> | <https://developers.cloudflare.com/workers/vite-plugin/>, <https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/> |
| Maturity | Supports Next 16 plus the latest minors of 14 and 15. Supports App and Pages Router, SSR/SSG/ISR, PPR, `'use cache'` and middleware. Not supported: Node Middleware (added in Next 15.2). <https://opennext.js.org/cloudflare> | README: "not yet a drop-in replacement"; use in production "with caution". Cache Components/PPR are incomplete. Image and font optimization happen mostly at runtime. `sharp`/`satori` can fail in dev. <https://github.com/cloudflare/vinext> | Plain Vite with the Workers runtime. No reimplementation layer. |
| Build | `next build`, then the OpenNext transform, then Wrangler. Two toolchains. | `vite build` (Vite 8). Deploy with `npx @vinext/cloudflare deploy` | `vite build`, then `wrangler deploy`, or `cf build`/`cf deploy` |
| Local dev | `next dev` with `initOpenNextCloudflareForDev()` for bindings, so it does **not** run in workerd. `opennextjs-cloudflare preview` gives a real workerd run. <https://opennext.js.org/cloudflare/get-started> | `vite dev` with HMR, bindings through `cloudflare:workers` | `vite dev` runs the Worker inside workerd, so dev matches production <https://developers.cloudflare.com/workers/vite-plugin/> |
| Size limit | 64 MiB uncompressed (see §0) | same | same, and the bundles are much smaller |
| Fit for AI agents | Good, because models know Next.js well. Risk: dev and production run on different runtimes, so a bug can show up only after preview or deploy. | Medium. Models write Next.js idioms, but the long tail of compatibility gaps produces failures that are hard to diagnose. | **Best for predictability.** The surface is small, Hono routes are explicit, and dev equals production. Models need light guidance on Hono and the D1 APIs. |

Notes on option (c):
- **SPA + Hono.** Set `assets.not_found_handling: "single-page-application"` and `run_worker_first: ["/api/*"]` <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/>. Hono binding types come from `wrangler types` and are used as `Hono<{ Bindings }>` <https://hono.dev/docs/getting-started/cloudflare-workers>.
- **React Router framework mode.** Bindings are available in loaders and actions as `context.cloudflare.env`. SPA mode and prerendering are **not** supported with the Cloudflare Vite plugin. The docs say to use React Router as a library on the React template instead. Cloudflare now documents **React Router v8**, not v7 <https://developers.cloudflare.com/workers/framework-guides/web-apps/react-router/>.

## 3. Data

**D1** (SQLite) <https://developers.cloudflare.com/d1/platform/limits/>

| Limit | Free | Paid |
|---|---|---|
| Databases per account | 10 | 50,000 |
| Max database size | 500 MB | 10 GB |
| Storage per account | 5 GB | 1 TB |
| Queries per Worker invocation | 50 | 1,000 |

On both plans: 100 bound parameters per query, a 2 MB row size limit, 100 KB per SQL statement, 30 seconds per query, and 100 columns per table.

Free-plan usage is capped at 5M rows read and 100k rows written per day. Once a cap is hit, the API returns errors until 00:00 UTC. Paid includes 25B reads, 50M writes and 5 GB of storage <https://developers.cloudflare.com/d1/platform/pricing/>.

- **Transactions.** D1 runs in auto-commit mode. `batch()` is atomic: it is a SQL transaction and rolls back the whole sequence on error. There are no interactive transactions. Read replicas require the Sessions API <https://developers.cloudflare.com/d1/worker-api/d1-database/>.
- **Migrations.** Use `wrangler d1 migrations create/list/apply`, which records applied files in a `d1_migrations` table. For Drizzle's folder layout, set `migrations_pattern = "migrations/*/migration.sql"`. Generate files with `drizzle-kit generate`, not `create`. Use `PRAGMA defer_foreign_keys = true` when a change would otherwise trip foreign-key constraints <https://developers.cloudflare.com/d1/reference/migrations/>.
- **Drizzle.** Use `drizzle(env.DB)` from `drizzle-orm/d1`. The docs install `drizzle-orm@rc` <https://orm.drizzle.team/docs/connect-cloudflare-d1>.

**R2**
- **Local.** R2 is simulated locally by default. Setting `remote: true` on the binding hits the real bucket instead <https://developers.cloudflare.com/r2/api/workers/workers-api-usage/>.
- **Free tier.** 10 GB-month of storage, 1M Class A and 10M Class B operations per month, and free egress <https://developers.cloudflare.com/r2/pricing/>.
- **Presigned URLs.** These are S3 SigV4 URLs that need an R2 access key and secret; the binding alone is not enough. They support GET, HEAD, PUT and DELETE, but not POST forms. Maximum expiry is 7 days. They work **only on the S3 API domain**, not on custom domains <https://developers.cloudflare.com/r2/api/s3/presigned-urls/>.
- **Simpler for generated apps.** Proxy uploads and downloads through the Worker with the binding, and do the auth check in the Worker. That avoids handing out S3 keys. Local presigned-URL emulation is **[unverified]**.

**KV and Durable Objects** are not needed for a CRUD v1. Only reach for them for realtime or coordination. Note that a Worker that implements a Durable Object gets no version/preview URLs (see §6).

## 4. Auth and authorization

- **Better Auth ≥ 1.5 supports D1 natively** with `database: env.DB`, which is auto-detected. "D1 does not support interactive transactions — Better Auth uses D1's `batch()` API for atomicity instead." <https://better-auth.com/blog/1-5>
- **Better Auth needs AsyncLocalStorage.** Enable it with `nodejs_compat`, or `nodejs_als` alone <https://www.better-auth.com/docs/installation>.
- **Drizzle adapter.** Use `drizzleAdapter(db, { provider: "sqlite" })` and generate the schema with `npx auth@latest generate` <https://www.better-auth.com/docs/adapters/drizzle>.
- **Migrations gotcha.** The D1 binding exists only inside a request, so the CLI can't reach it. The workaround is to generate the SQL with the CLI or Drizzle and apply it with `wrangler d1 migrations`. This comes from community discussion and is **[unverified-official]**: <https://github.com/better-auth/better-auth/discussions/7487>.
- **In-code migrations.** `getMigrations` can run migrations in code, but only with the built-in Kysely adapter (search summary of <https://better-auth.com/docs/concepts/database>, **[not fetched directly]**).
- **Cloudflare Access** is meant for "internal tools and applications". It is a workforce SSO layer, not end-user auth for a generated app <https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-public-app/>. It is still useful to put in front of **preview URLs** (see §6).
- **Replacing RLS.** D1 has no row-level security, so authorization moves into application code. The convention is:
  1. Every query goes through a data-access module that takes `userId` from the Better Auth session and adds a `WHERE owner_id = ?` clause.
  2. Never take the owner from the request body.
  3. Optionally use one D1 database per tenant, since a Paid account allows 50k databases.

  This is a design inference, not a Cloudflare doc. Agent Foundry should enforce it with a golden test (user B cannot read user A's rows) instead of relying on prompting.

## 5. Local dev and parallel projects on one Mac

- **Bindings are local by default.** AI is the exception and is always remote. `remote: true` opts a single binding in to real data, and `--local` disables all remote bindings <https://developers.cloudflare.com/workers/local-development/>.
- **Vite plugin state** persists to `.wrangler/state` by default (configurable with `persistState`). `remoteBindings` defaults to **true**, and the inspector listens on 9229 <https://developers.cloudflare.com/workers/vite-plugin/reference/api/>. Agent Foundry should pin `remoteBindings: false` so an agent can never touch production data.
- **`wrangler dev` flags.** `--port`, `--inspector-port`, `--persist-to`, `--ip` (default `localhost`) and `--local`. The docs use `localhost:8787` <https://developers.cloudflare.com/workers/wrangler/commands/workers/>.
- **Running projects in parallel** is feasible because each workspace has its own `.wrangler/state` and the runner can assign `--port` and `--inspector-port` per project. One caveat: the default inspector port, 9229, will collide across projects, so the runner must assign it **[inference; whether ports auto-fall-back is unverified]**. This removes the per-project Supabase Docker stack completely, which also removes the Docker address-pool exhaustion problem.
- **`wrangler dev` auto-creates resources locally.** Bindings without IDs are created locally and start empty. Seed them with `--local` commands <https://developers.cloudflare.com/changelog/2025-10-24-automatic-resource-provisioning/>.
- **Tests.** `@cloudflare/vitest-plugin` uses `cloudflareTest()` and `configPath` pointing at the Wrangler config. Tests run in workerd through Miniflare, with isolated storage per test file <https://developers.cloudflare.com/workers/testing/vitest-integration/>. The helper for applying D1 migrations in tests (`applyD1Migrations`) is **[unverified]** in the current docs. Playwright against `vite dev` covers golden flows.

## 6. Deploy automation

- **Auto-provisioning.** Since wrangler 4.45, `wrangler deploy` creates the KV, R2 and D1 resources that are declared without IDs, names them with the Worker as a prefix, and writes the IDs back to the config <https://developers.cloudflare.com/changelog/2025-10-24-automatic-resource-provisioning/>.
- **API.** `POST /accounts/{id}/d1/database` needs `D1 Write` <https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/>.
- **Token permissions.** Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit and Account Settings Read. The docs don't confirm that this is the minimal set <https://developers.cloudflare.com/fundamentals/api/reference/permissions/>.
- **Preview ("Version") URLs.** `wrangler versions upload --preview-alias <name>` produces `<alias>-<worker>.<subdomain>.workers.dev`. They have these limits:
  - `workers.dev` only
  - public unless protected by Access
  - not generated for Workers that use Durable Objects
  - the last 1,000 aliases are kept
  <https://developers.cloudflare.com/workers/configuration/previews/>
- **Rollback.** `wrangler rollback` works across the last 100 versions. It does **not** revert bindings or data, so a D1 schema migration cannot be rolled back <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/>. Gradual deployments use `versions upload`, then `versions deploy` with percentages, with optional version affinity <https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/>.
- **Free tier.** 100k requests per day, 10 ms CPU per request, 128 MB memory, 50 subrequests, and 20k static files of 25 MiB each <https://developers.cloudflare.com/workers/platform/limits/>. The 10 ms CPU limit is the real risk for SSR and for password hashing in auth **[the hashing cost on the Free plan is unverified; test it]**.

## 7. Recommendation

**Golden stack:** Vite + React SPA (React Router in library mode) + a Hono API on one Worker with static assets, D1 through Drizzle, Better Auth with email and password, and R2 through the binding. Develop with `@cloudflare/vite-plugin` (`vite dev` in workerd, `remoteBindings: false`), test with `@cloudflare/vitest-plugin` and Playwright, deploy with `wrangler deploy` (auto-provisioning), and use preview aliases for the publish step.

Rationale:
1. Dev runs on the same runtime as production, so failures appear in the local loop. This matches the project goal that v1 is the local loop only.
2. A small, explicit surface with no reimplementation layer, which makes agent output more reliable.
3. Wrangler is the stable choice today; `cf` can come later through `cf migrate`.
4. No Docker, and per-project state is just a folder.

Risks:
- No RLS. Authorization depends on a code convention plus a test.
- The 10 ms CPU limit on the Free plan.
- Batch-only transactions in D1.
- Wrangler-to-`cf` churn within about 18 months.
- React Router v8 is new.
- Better Auth's native D1 support is recent (1.5).

**Runner-up:** Next.js on **vinext**. It is Cloudflare's default for Next.js and keeps the current Next.js templates and model familiarity. Choose it only if Next.js/RSC parity matters more than predictability. It is beta, and Cache Components/PPR and image optimization have gaps. OpenNext comes third: it is more mature, but `next dev` does not run in workerd, which splits dev and production.

## Open questions

1. Does Agent Foundry need SSR or SEO for generated apps? If yes, use React Router framework mode (losing SPA mode) or vinext instead of a pure SPA.
2. Should apps start on `cf` (`cloudflare.config.ts`) now that it is in beta, or on Wrangler with a later `cf migrate`?
3. Which Cloudflare account model: one account owned by the user per app, or Workers for Platforms dispatch namespaces for "publish"?
4. Does Better Auth's password hashing fit within 10 ms of CPU on the Free plan? Measure it.
5. Is the `applyD1Migrations` test helper still part of `@cloudflare/vitest-plugin`? Confirm before writing golden tests.
6. Do Vite and Wrangler fall back automatically when two concurrent projects collide on dev or inspector ports, or must the runner assign them?
7. If the generated app needs direct browser uploads to R2, how do presigned URLs work locally?
