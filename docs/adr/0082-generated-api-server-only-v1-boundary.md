# ADR 0082: Generated API stays server-only in v1

- Status: Accepted
- Date: 2026-08-27
- Owners: Core, Integrations
- Tracked by issue #615
- Builds on: ADR 0038 and ADR 0041

## Context

The generated web tier is the only caller of `apps/api`. It calls the API
server-side and forwards the authenticated user's bearer token; the browser
does not call the API origin. This topology means CORS and cookie-auth
middleware would protect no current traffic, an IP-keyed rate limiter would
turn loopback traffic into one shared bucket, and CSRF protection would have no
cookie credential to defend.

The API boundary is still a public contract of generated projects. A future
model must not silently turn it into a browser- or ingress-facing surface by
adding CORS, cookie authentication, or an unmeasured limiter.

## Decision

For v1, generated `apps/api` remains server-only and loopback-reached through
the web tier:

- authentication uses the forwarded `Authorization: Bearer` token;
- the API emits no CORS policy and does not use cookie authentication;
- no CORS, CSRF, or rate-limit middleware is added to this boundary;
- the boundary checker fails closed on CORS references, cookie-auth references,
  and API logging until a redacted structured logger is part of the scaffold.

Cursor pagination remains bounded and rejects malformed or non-canonical
timestamps with HTTP 400 before reaching the data query.

Any browser caller or public ingress for the generated API is a topology
change. It requires a new issue and a superseding ADR that measures the
allowed origins, credential transport, CSRF boundary, and identity-based rate
limit before enabling those controls.

## Alternatives considered

**Add CORS, CSRF, and an IP-keyed limiter now.** Rejected: there is no current
browser-origin traffic, loopback collapses all callers into one IP bucket, and
cookie-based CSRF is not the credential model.

**Allow the API to become public without a new decision.** Rejected: it would
silently invalidate the server-only authentication and threat-model boundary.

**Rewrite ADR 0038 or ADR 0041.** Rejected: accepted decisions are preserved;
this ADR records the v1 boundary and its explicit re-opening trigger.

## Consequences

Generated v1 projects do not support direct browser-to-API calls, cookie
authentication, or rate limiting at this boundary. This keeps the current
server-only topology honest and makes accidental expansion fail during the
scaffold build. There is no data migration: the decision applies to newly
generated projects and the existing bearer-token contract remains intact.

The trade-off is that a future public API must first add a measured security
design rather than enabling middleware opportunistically.

## Validation and rollback

The scaffold boundary tests pin CORS header and Hono middleware references,
cookie-auth references, and logging calls whose receiver or argument names
could otherwise evade a name-based canary. The generated API contract pins
invalid cursors, including an impossible calendar date, and verifies that no
data query is made for them. The scaffold build runs the same checker.

Rollback is a code revert for the scaffold and checker; no persisted data or
migration is involved. If the API needs a browser caller or public ingress,
do not disable these guards: supersede this ADR with the measured replacement
boundary first.
