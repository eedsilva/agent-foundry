# ADR 0017: Preview network proxy with host validation and per-session tokens

- Status: Accepted
- Date: 2026-07-16
- Owners: API and Orchestrator

## Context

Issue #30 implements live preview of workspace changes: when a developer previews a project, the orchestrator spawns a dev server subprocess on the local machine, and the client should see that dev server's output without exposing the internal port or allowing arbitrary network access.

Earlier work (#28, #29) established the `PreviewService` contract and the `NodePreviewRunner` mechanism for managing the dev server subprocess. This ADR covers the network surface: how clients reach the previewed dev server, how we prevent DNS-rebinding attacks, and how we ensure internal details (the actual port number, the host) never leak to the previewed application or to the network.

The constraint from ADR-0005 (loopback-only, trusted operator only) applies here: preview is a development feature, not a production proxy. All connection must originate from the same machine (localhost), and no secret/credential from the untrusted dev server process should reach the client.

## Decision

The API adds a hand-rolled reverse proxy for the `/preview/:sessionId/*` route, implemented as an HTTP+WebSocket handler in `apps/api/src/preview-proxy.ts`.

**Port reservation and detection** (`packages/executors/src/preview-port.ts`, `NodePreviewRunner`):
- The executor reserves a port via the standard loopback port allocator before spawning the dev server.
- The dev server receives `PORT` and `HOST=127.0.0.1` as environment variables, so it knows where to listen.
- If the port is in use (unlikely, but possible under concurrent preview pressure), the executor detects a bind error from the dev server's output and retries once with a fresh port reservation.
- The executor does a single TCP-connect health probe to confirm the dev server is reachable; no HTTP-level probe or configurable health window yet.

**Session tokens and lifecycle** (`packages/orchestrator/src/preview-service.ts`, `PreviewService`):
- The service stores sessions in memory (indexed by session ID) alongside an opaque, cryptographically random 32-byte token per session (base64url-encoded).
- When `POST /projects/:projectId/preview` starts a preview, it runs the prepare/start/health-poll orchestration and mints a new token, returning the session and a full proxy URL (`/preview/:sessionId/?token=<token>`).
- When `POST /projects/:projectId/preview/:sessionId/stop` stops a preview, the service marks the session terminal; the token is kept for audit but no longer allows access.
- Sessions expire automatically after `PREVIEW_TTL_SECONDS` (default 1800, configurable).

**Proxy routes and host validation** (`apps/api/src/preview-proxy.ts`, `registerPreviewProxy`):
- Three routes exist: `POST /projects/:projectId/preview` (start), `POST /projects/:projectId/preview/:sessionId/stop` (stop), and the proxy sink `GET/POST/etc. /preview/:sessionId/*` (plus raw WebSocket upgrade on the same prefix).
- Before any upstream connection or token check, the proxy validates that the `Host` header matches the API's own loopback host:port (via `isAllowedHost`). This prevents DNS-rebinding attacks: an attacker cannot trick the proxy into forwarding a request to a different hostname or port.
- If the Host header is invalid, the proxy responds `400` immediately and closes the connection.

**Token authentication** (query-or-cookie):
- The client presents the token as a URL query parameter on first request (`/preview/:sessionId/?token=<token>`), or as a cookie in subsequent requests.
- On the first request (token in query), the proxy verifies the token against the stored session, issues a `Set-Cookie` response with the same token (name `pv_<sessionId>`, path-scoped to `/preview/:sessionId/`, HttpOnly, SameSite=Lax), and forwards the request upstream.
- On subsequent requests (token in cookie), the proxy reads the cookie and verifies it without issuing a new cookie.
- If the token is missing or mismatched, the proxy responds `403`.

**Header sanitization**:
- The proxy strips the auth token from the upstream query string (via `strippedSearch`), so the dev server never sees it.
- The proxy drops hop-by-hop headers (Connection, Transfer-Encoding, etc.) and the client's Host header, then injects `Host: 127.0.0.1` before sending to the upstream, so the dev server sees loopback instead of the client's original Host.
- Before sending the upstream response back to the client, the proxy sanitizes four URL-bearing response headers (Location, Content-Location, Refresh, Link) via `rewriteLocation`:
  - Relative locations (`/foo/bar`) are rebased under the proxy prefix (`/preview/:sessionId/foo/bar`).
  - Absolute locations pointing to this session's own upstream (`http://127.0.0.1:<upstreamPort>/...`) are converted to proxy paths.
  - Any other absolute URL is replaced with `/preview/:sessionId/` to prevent an untrusted dev server from redirecting through the trusted proxy origin to an external URL.
- Critically, the proxy auth token is also stripped from the Cookie header before reaching the upstream (via `stripPreviewCookie`), so the dev server cannot exfiltrate the token it receives and use it to make unauthenticated requests via the proxy later.

## Alternatives considered

**@fastify/http-proxy** was rejected: it does not support per-session dynamic upstreams (the proxy rules are configured at startup), and its header handling for sensitive-labeled operations like this is less auditable — we need transparent, narrow, line-by-line control over what leaves the proxy.

**Persisting sessions to disk now** was rejected: ADR-0005 and the v05-preview-lifecycle roadmap item already own the job of durable session storage, reaping, crash recovery, and log persistence. Doing that work here duplicates responsibility and ties this ADR to persistence concerns it should not carry. In-memory-only sessions are sufficient for dev-time preview and will be subsumed by the durable backend later.

## Consequences

**Health monitoring** is today a single TCP-connect probe with a fixed ~10-second startup window and 200ms poll interval. It is mechanism-only: it cannot distinguish between "port is open but app isn't ready" and "app is ready." Configurable HTTP probes, custom response body checks, and per-session health windows are deferred to v05-preview-lifecycle.

**Process lifecycle** has no built-in crash/restart policy or orphan reaper. If the dev server crashes, the session remains in `running` state until TTL expiry or explicit stop. Automatic restart, exponential backoff, and detecting orphaned processes are deferred to v05-preview-lifecycle.

**Token leakage from the preview process itself** is out of scope: the proxy auth token is cryptographically random and changes per session, but if the dev server exfiltrates the Referer header or any other leaked header to an external service, it can include the URL with the token. That is a concern for the dev server sandboxing (ADR-0005, executor sandboxing), not the proxy. The proxy only guarantees the dev server does not receive the token in its own request.

**No TLS termination**: preview is loopback-only per ADR-0005, so TLS is unnecessary. In a future hardening (if preview moves to development servers on a private network), TLS termination can be added at the edge without touching the proxy logic.

## Validation and rollback

- `packages/executors/src/preview-port.test.ts` covers port reservation and conflict detection.
- `packages/executors/src/node-preview-runner.test.ts` covers dev server spawn, health probes, and logs.
- `packages/orchestrator/src/preview-service.test.ts` covers session lifecycle, token minting and validation, and TTL expiry.
- `apps/api/src/preview.test.ts` covers the start and stop routes.
- `apps/api/src/preview-proxy.test.ts` covers Host validation, token auth (query and cookie), header sanitization, Location rewriting, and WebSocket upgrade.

Rollback: remove the three new routes (`POST /projects/:projectId/preview`, `POST /projects/:projectId/preview/:sessionId/stop`, `GET/* /preview/:sessionId/*`) and the `upgrade` handler, then remove `Runtime.previewService` and `Runtime.previewRunner` wiring from the composition. No other code depends on these exports yet.
