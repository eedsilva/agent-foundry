# ADR 0040: Scaffold auth flows through web-tier server actions, so the browser only talks to the web origin

- Status: Accepted
- Date: 2026-07-27
- Owners: Core, Integrations
- Amends: ADR 0038's description of how the browser reaches Supabase Auth; everything else in ADR 0038 stands

## Context

ADR 0038 inherited the scaffold's then-current sign-in flow: "the browser obtains its session directly from Supabase
Auth using the anon key, which is what `apps/web` already does via `@supabase/ssr`", and consequently noted that the
API tier's origin "has to be listed in `ProjectPolicy.browserAllowedOrigins` for the verifier to permit it".

Implementing the authenticated request path (#317) surfaced what that inheritance costs. ADR 0020's browser verifier
permits only the preview origin plus exact origins in `browserAllowedOrigins`, and treats any request to another origin
as an observation that makes the report unapproved. A browser that calls Supabase Auth directly talks to the local
stack's origin — whose port is allocated per project at `pnpm db:start`, so it cannot be a static policy entry. Every
generated project would need per-project policy writes before its own cross-tenant denial assertion could pass.

## Decision

Sign-in and sign-up are server actions in `apps/web` (`app/actions.ts`), using the same `@supabase/ssr` cookie-backed
server client the rest of the tier already uses. The session still comes from Supabase Auth with the anon key; only the
hop moves server-side. Pages call the API tier server-side, forwarding the session's access token.

The browser therefore only ever talks to the web origin. The shipped cross-tenant denial plan
(`browser-tests/cross-tenant-denial.json`) runs under ADR 0020's allowlist with **no** `browserAllowedOrigins` entries,
and ADR 0038's note about listing the API origin is moot rather than pending.

ADR 0038's authorization decision is untouched: the API tier builds a per-request Supabase client from the anon key
plus the caller's token, the service-role key stays confined to admin/cron/webhook paths, and a forgotten check returns
an empty result.

## Alternatives considered

**Keep browser-side sign-in and allowlist the Supabase origin per project.** Rejected: the origin is dynamic per
project, `browserAllowedOrigins` is exact-origin static policy (ADR 0020), and wiring per-project policy writes into
provisioning is real machinery purchased only to preserve an incidental traffic shape.

**Keep browser-side sign-in and exempt auth requests from the verifier's origin policy.** Rejected: the exact-origin
allowlist is ADR 0020's smallest auditable boundary; carving auth-shaped holes in it weakens the guarantee for every
plan, not just this one.

## Consequences

`apps/web/lib/supabase/client.ts` (the `createBrowserClient` wrapper) is deleted; the web tier has one Supabase client
construction site, server-side. Generated code that later needs browser-side Supabase calls must reintroduce it —
and with it, the origin-policy problem this ADR avoids.

Browser test plans for generated apps can assume the web origin is the only origin they touch.

## Validation and rollback

The shipped cross-tenant denial plan passing under a zero-entry origin allowlist is the validation; the scaffold-boot
smoke test covers the same path over HTTP. Rollback is superseding this ADR and restoring a browser client, which
requires solving the per-project origin allowlist it exists to avoid.
