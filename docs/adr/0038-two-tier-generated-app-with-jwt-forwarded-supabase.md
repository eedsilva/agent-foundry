# ADR 0038: Generated applications are two-tier (Next.js + Fastify) and reach Supabase with the caller's JWT

- Status: Accepted
- Date: 2026-07-25
- Owners: Core, Integrations
- Supersedes: ADR 0007's generated-application stack clause only; ADR 0007's local-Supabase-per-project decision remains in force
- Amended by: ADR 0040 — sign-in/sign-up run as web-tier server actions, so the browser no longer calls Supabase Auth directly and no `browserAllowedOrigins` entry is needed

## Context

ADR 0007 fixed the generated stack as "Next.js, TypeScript, Tailwind CSS and shadcn/ui applications" — one tier, one
deployable. Two things have since made that clause the wrong description of what should be generated.

**Turn zero is not a running application.** The scaffold is `harness/scaffolds/nextjs`: nine source files, no
`package.json`, no lockfile, no tsconfig. Nothing can install it, so nothing can boot it — the observed run in #313
failed its preview with `No supported lockfile or packageManager field found` and no deterministic check or browser
assertion could ever have run against it. Fixing that means committing a real, installable, CI-verified workspace, which
forces the tiering question to be answered once, in the scaffold, rather than re-derived per project.

**The incumbents are full-stack by default and the stack is not negotiable.** Replit: "Full-stack by default: Every web
app includes a frontend and backend. Agent sets up API routes, a database, and server-side logic as your app needs
them." v0 defaults to Next.js and states the trade-off outright — "While v0 can use other frameworks, Next.js provides
the most reliable results." Lovable offers no framework picker at all. All of them are runnable at turn zero.
(`docs/evidence/ai-app-builder-loop-architecture.md` §2.)

The second force is authorization. Generated request handlers are model-written, one task at a time, by a loop whose
gates are a compiler and a test suite. The highest-severity bug class such a loop can emit is a missing tenant check.
Whether that bug surfaces as an empty page or as another tenant's rows is decided entirely by *which credential the
Supabase client is constructed with* — and that is an architectural choice, not something a reviewer can be relied on to
catch per handler.

Decisions this ADR must not disturb: ADR 0008 (one isolated Compose project per app, Caddy for TLS), ADR 0030 (an
isolated runtime initialized per project), and ADR 0034 (three platform-managed keys —
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — written into the per-project
`.env` and resolved only into the dev-server subprocess).

## Decision

**Shape.** A generated project is a single pnpm workspace with two application tiers: `apps/web` (Next.js, TypeScript,
Tailwind CSS, shadcn/ui — ADR 0007's UI stack carries over unchanged) and `apps/api` (Fastify, TypeScript). One
lockfile at the workspace root. Local Supabase stays one isolated stack per project (ADR 0007).

**Traffic.** The browser makes data calls only to `apps/api`. `apps/web` renders and calls the API tier; it does not
construct a database client, in a server component, a route handler, or a server action. Business logic has one home.

Authentication is the one exception, and it is inherited rather than decided here: the browser obtains its session
directly from Supabase Auth using the anon key, which is what `apps/web` already does via `@supabase/ssr` on ADR 0034's
`NEXT_PUBLIC_*` keys. This ADR only fixes what happens next — every subsequent data call carries that session's access
token to `apps/api`.

**Authorization.** Each `apps/api` request constructs its own Supabase client from the anon key plus the caller's access
token, taken from the request's `Authorization` header. Postgres therefore evaluates row-level security as that user for
every statement the handler issues. The client is per-request; it is never a module-level singleton, because a shared
client would carry one caller's token into another caller's request.

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely — it is a `postgres`-level credential, and no policy applies to it. It
is reserved for the paths that have no caller identity to forward: admin operations, scheduled jobs, and inbound
webhooks. No handler that serves a browser request uses it. Nothing enforces that mechanically — one Fastify process can
read its own environment from anywhere — so this is a scope rule that review and the checks below have to hold up, not a
guarantee the runtime makes.

The property this buys, stated plainly: **a forgotten authorization check in generated code returns an empty result set,
not another tenant's rows.**

**Verification.** Every generated project ships a cross-tenant denial assertion: sign in as user A, drive the UI to a
view of user B's data, assert B's row is not visible. It is expressed in ADR 0020's declarative vocabulary — `goto` /
`click` / `fill` with a `hidden`/`containsText` assertion — deliberately at the UI level rather than as a raw HTTP
status check, because ADR 0020 has no status-code assertion and treats any response at or above 400 as an observation
that makes the report unapproved. That constraint fits the decision above rather than fighting it: under JWT forwarding
the denial *is* an empty result rendered as an empty view, not a 403. The API tier's origin has to be listed in
`ProjectPolicy.browserAllowedOrigins` for the verifier to permit it (ADR 0020); adding it is part of the scaffold work,
not a further decision.

**Deployment.** ADR 0008 is unchanged. `apps/api` is a second container inside the same isolated Compose project,
behind the same Caddy instance; TLS, DNS, backup and rollback semantics are exactly as ADR 0008 specifies.

## Alternatives considered

**Next.js only — ADR 0007's position.** Genuinely simpler: one deployable, one dev server, one Dockerfile, one port for
the preview probe to find, no cross-tier type sharing, and it is what v0 does with its most-reliable-results stack.
Rejected for three reasons. The operator works in Fastify, and a generator that emits a stack its owner does not
maintain produces code nobody wants to read. More structurally: with route handlers, server actions, and server
components all able to reach the database, "where does data access live" has three valid answers, and a per-task
generator will pick different ones on different tasks; a separate tier makes the boundary structural instead of a
convention the model must remember across fourteen independent implement calls. Finally, the authorization decision
above only bounds anything if there is exactly one kind of place a Supabase client is ever constructed — the tier split
is what makes that statement checkable. Accepted cost: two services to boot, a second port to probe, and shared types
across a workspace boundary.

**Service-role key in the gateway.** One admin Supabase client in `apps/api`, authorization enforced by handwritten
checks in each handler. Fewer moving parts: no token plumbing, no per-request client construction, no RLS policy to
author per table, and measurably faster queries since no policy is evaluated. Rejected because the two failure modes are
not comparable. Under service-role, RLS is off, so a handler that omits `where tenant_id = …` returns every tenant's
rows with HTTP 200 — and nothing in this system distinguishes that response from a correct one: `tsc` passes, the test
suite passes, the preview boots, and a browser assertion that checks "the list renders rows" passes too. Under JWT
forwarding the same omission returns an empty set, which is visibly wrong and fails the acceptance check the task
already declared. Given that the handlers are model-written, the number of forgotten checks across a run is not going to
be zero; the decision is about what happens when one occurs. The database is the last enforcement point that still holds
when the application code is wrong, so it is the one layer that must not be the one switched off.

**Browser talks to Supabase directly with the anon key.** What the current scaffold does. RLS still evaluates, and there
is no API tier to run at all — the fewest containers of any option. Rejected because business logic then lives in the
browser, where it is neither trusted nor server-side testable, and because every server-side concern that arrives later
— webhooks, cron, third-party API keys, rate limiting, anything needing a secret — requires the tier to be introduced
anyway, at which point it is introduced mid-project instead of in the scaffold.

**Let the plan choose the stack per project.** Rejected: a bootable turn zero requires a committed workspace that is
already installed, already lockfile-frozen, and already asserted by CI. A stack chosen at plan time can be none of
those, and the evidence is that stack freedom costs quality even for products with far more generation volume to tune
against.

**Edit ADR 0007 in place.** Rejected per `docs/adr/README.md`: accepted ADRs are superseded, not rewritten. ADR 0007's
text stands; only a pointer is added.

## Consequences

ADR 0007 no longer describes the shape of a generated application, but its local-Supabase-per-project decision — and
everything built on it (ADR 0030 isolated runtime, ADR 0031 forward-only migrations, ADR 0032 secure storage, ADR 0033
app secret capabilities, ADR 0034 credential bridge) — is untouched and remains in force. Its email/password-only auth
scope also stands.

ADR 0034's three platform-managed `.env` keys keep their meaning, with tier-specific readers: `apps/api` reads
`SUPABASE_SERVICE_ROLE_KEY`, `apps/web` must not, and both read the `NEXT_PUBLIC_*` pair. A service-role misuse can
therefore only be written into one tier, and within it only into the admin, cron, and webhook files — a set small enough
to read.

Every table needs an RLS policy from the baseline migration onward. A table with RLS enabled and no policy denies
everything, which is fail-closed and visible — the direction this ADR is deliberately biased toward.

Each project now runs two containers plus Supabase locally and on the VPS, raising resource use and requiring the
preview health check to probe both services rather than one. Per-request Supabase client construction is a real
per-request cost, accepted because it is the mechanism the authorization property rests on.

Projects generated under the single-tier scaffold are not migrated; #313 places that explicitly out of scope.

## Validation and rollback

The scaffold-boot CI job (#313) copies the scaffold into a clean directory, installs with a frozen lockfile, starts
everything, and asserts that both tiers and Supabase respond — without that check the workspace decays back to a
fragment silently, which is exactly how the current scaffold reached nine orphaned files. The cross-tenant denial
browser assertion proves the authorization decision end to end in every generated project, not in a unit test of the
client factory.

Rollback is by superseding this ADR, and applies to newly generated projects only: a project already generated as two
tiers is not automatically collapsible back into one. Reverting the authorization half specifically would mean
re-granting service-role to request handlers, which should not be done without replacing the guarantee it removes.
