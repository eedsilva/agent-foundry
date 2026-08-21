# ADR 0071: One generated stack runs locally and on Cloudflare

- Status: Accepted
- Date: 2026-08-18
- Owners: Core, Integrations
- Supersedes: ADR 0008; ADR 0038's Fastify and VPS deployment clauses
- Preserves: ADR 0038's two-tier and JWT-forwarding boundaries; ADR 0041's web-tier session boundary
- Extended by: [ADR 0072](0072-agent-foundry-provisions-and-gates-cloud-publication.md)

## Context

A Generated Application must remain a Standalone Repository with a separate Web App and Backend API, run first against local Supabase in Docker, and optionally publish the same source to Cloudflare. Maintaining Fastify locally and Hono in the cloud would duplicate generated routes and verification. Replacing Next.js with a static React SPA merely to use Pages would also break the accepted boundary that the browser talks only to the Web App; Pages Functions would recreate a server tier to restore it.

## Decision

Every newly generated repository has one version-pinned pnpm workspace: `apps/web` uses Next.js, TypeScript, Tailwind CSS and shadcn/ui; `apps/api` uses Hono; `packages/contracts` owns shared Zod request and response contracts; and `supabase/` owns migrations and local configuration. Root scripts provide the supported install, development, database, test, build, preview, and publication commands.

The Standalone Repository includes its approved `PRD.md`, lockfile, `.env.example`, and a concise README covering prerequisites, architecture, commands, verification, and both targets. Generated applications contain no fictitious sample records. Verification Data is temporary and removed after its evidence is captured; seed files contain only configuration or domain data the approved PRD requires.

Task Agents prefer platform APIs, scaffold capabilities, and already-installed packages. A new dependency is permitted only when those cannot satisfy an approved requirement and its addition is justified in the task diff. The pinned lockfile is authoritative. Source control contains `.env.example` only; local values live in ignored `.env` files and cloud values in provider secret stores. Missing required configuration fails startup with a bounded diagnostic.

Package lifecycle scripts are disabled by default. The versioned scaffold allowlists only packages it already needs; any new exception pauses for operator approval. The Supply Chain Gate blocks critical or high known vulnerabilities and prohibited or unknown licenses, while lower severities remain visible warnings.

No exception may waive a blocking Supply Chain Gate result for Local Acceptance or Cloud Publication in v1.

Each repository commits `.agent-foundry.json`, a Generation Manifest containing only version and digest identities. Generated code belongs to the operator; no `LICENSE` file is added without an explicit choice. A project's scaffold never upgrades automatically. Local ports are allocated automatically, remain stable for that project, and may change only while its environment is stopped.

The Backend API is REST JSON under `/api/v1`. Errors use the shared `{ code, message, fieldErrors?, requestId }` contract and never expose stack traces or internal details. Baseline security includes exact-origin CORS, security headers, Zod validation, CSRF protection for cookie-authorized mutations, caller-scoped Supabase access, and RLS. Authentication failures never reveal whether an email exists: unknown email, incorrect password, and unavailable account all return the same `401` error contract and localized “Credenciais inválidas” message. Cloud CORS, Supabase Site URL, and Auth redirects allow only the exact published Web Worker origin; they contain no wildcard or localhost origin. Self-service account deletion is unsupported in v1.

The same application middleware enforces rate limits in both targets without an additional dependency. Local Target uses a process-memory counter; Cloudflare Target uses the native Workers Rate Limiting binding. Login permits five attempts per 60 seconds per SHA-256 digest of the normalized email and 20 attempts per 60 seconds per source IP. Authenticated mutations share a limit of 60 requests per 60 seconds per Application Owner; v1 adds no application-specific read limit. Rate-limit keys are never logged. Both targets return `429 Too Many Requests` with `Retry-After: 60`. A limiter failure makes login and mutations fail closed with `503 Service Unavailable` and `Retry-After: 60`, while reads continue. Local counters may reset with the local API process. The cloud binding is abuse containment rather than exact accounting because its counters are permissive, eventually consistent, and local to a Cloudflare location.

Generated runtime configuration contains the Supabase URL and anon key but no service-role key. Every application request uses the caller-scoped client. V1 has no generated admin, job, webhook, or storage-processing path requiring an RLS-bypassing credential. Agent Foundry may use trusted Supabase CLI or transient verifier capabilities for provisioning, migration, backup, and cleanup, but those credentials never enter the Standalone Repository, generated runtime environment, Task Context, or application bundle.

Generated migrations explicitly grant only the table and sequence privileges required by `authenticated`; they grant no business-data privilege to `anon`. Every domain table enables RLS and has owner-scoped policies for select, insert, update, and delete. Update policies define both `USING` and `WITH CHECK`, and authorization derives from `auth.uid()`, never mutable user metadata. V1 generates no database views; simple dashboards query owner-scoped API operations.

Create operations accept an idempotency key scoped to the authenticated Application Owner and normalized route for 24 hours. Reusing it with the same request fingerprint returns the original outcome; reusing it with different content returns `409 Conflict`. Expired records are removed opportunistically, so v1 needs no cleanup job. Updates require the version observed by the caller; a stale update returns a Revision Conflict instead of overwriting newer state. Every domain entity records `created_at` and `updated_at`; `deleted_at` exists only when the approved PRD explicitly requires soft deletion. Foreign keys default to `RESTRICT`; `CASCADE` is allowed only for an exclusive child relationship declared in the approved Schema Plan. The plan also requires indexes for foreign keys, ownership predicates, approved filters and sorts, and uniqueness constraints.

Application logs contain a request ID, normalized route, response status, and duration. They exclude request and response bodies, tokens, passwords, email addresses, and business records.

Generated interfaces use one PRD-defined interface language, a light theme in the first milestone, real product copy, and subtle functional motion that honors `prefers-reduced-motion`. V1 generates no runtime language selector, translation catalog, or persisted locale preference. Dates, numbers, and times use browser `Intl` with the browser's locale and time zone. They meet WCAG 2.2 AA for contrast, keyboard use, focus, labels, errors, and semantics. A Revision Conflict preserves unsaved form content, explains that newer state exists, and offers reload or copy; it never auto-merges, retries, or overwrites. Acceptance runs Chromium at 390×844 and 1440×900, with automated axe checks plus keyboard and focus verification in both viewports; Safari and Firefox are not release targets yet. Production-mode local journeys must remain at CLS ≤ 0.1, LCP ≤ 2.5 seconds, and INP ≤ 200 milliseconds. Final screenshots cover every main screen at both viewports and are bound to the Promotion Commit. Instants persist in UTC, while civil dates remain date-only values.

The accepted Local Supabase Stack supports explicit manual backup and restore. Each backup asks for an operator-selected absolute directory, remembers the last destination, refuses a path inside the Standalone Repository, and writes a dump, checksum, and manifest without credentials. V1 creates no scheduled local backup. Restore requires a stopped application, valid checksum and compatible manifest, a preview, an explicit confirmation, and a new safety backup unless the operator supplies the existing destructive-operation waiver. It makes no model call. Before any other destructive local data operation, Agent Foundry requires a verified backup less than 24 hours old or an explicit operator waiver naming the risk.

The Local Target runs the Web App locally, the Hono Backend API through its Node adapter, and one isolated Local Supabase Stack. Local email/password signup creates an active session immediately. The Cloudflare Target publishes the Web App through OpenNext as one Worker and the Hono Backend API as a separate Worker. It provisions one Cloud Supabase Project per published Generated Application and applies the same migrations, Auth, and RLS contract used locally. The Cloudflare Target is a Private Cloud Application with exactly one persistent Application Owner: anonymous visitors cannot create accounts, and any second identity is disposable Verification Data. Its responses include `X-Robots-Tag: noindex, nofollow` plus a `robots.txt` that disallows all crawling. V1 adds no Turnstile integration.

Both targets preserve the same traffic boundary: the browser talks only to the Web App; web-tier server code owns authentication cookies and forwards the caller's JWT to the Backend API; and the API creates a caller-scoped Supabase client per request. No generated runtime path receives a service-role key.

The Web App stores the Supabase session in `HttpOnly`, `SameSite=Lax` cookies; cloud cookies are also `Secure` and have no `Domain` attribute. V1 uses Supabase's one-hour access-token lifetime and refreshes the session until logout. It adds no paid-plan session timebox, inactivity timeout, or single-session enforcement.

There is no generated local or cloud variant. Local acceptance is mandatory before an explicitly approved Cloudflare publication. Personal Builder v1 is complete when Issue Radar Lite passes both targets from a clean supported Mac. The broader four-application acceptance matrix belongs to the next milestone.

## Alternatives considered

- **React/Vite on Pages:** rejected because a static SPA would move Supabase and API traffic into the browser or require Pages Functions to restore the existing server boundary. Workers Static Assets already serves static assets and keeps the full Workers feature surface.
- **Fastify locally and Hono on Cloudflare:** rejected because two HTTP frameworks would duplicate generator instructions, adapters and acceptance tests for the same business routes.
- **D1/R2 or a tunnel to local Supabase:** rejected for the first path because D1/R2 creates a second data/auth/storage contract, while a tunnel makes production depend on the operator's machine.

## Consequences

ADR 0008 is no longer the production direction, and ADR 0038's Fastify scaffold must migrate to Hono. The existing scaffold already uses pnpm and the intended workspace boundary, so Hono and Cloudflare support extend it rather than introducing another package manager. Cloudflare publication requires a workerd-compatible preview gate and authenticated Cloudflare plus Supabase CLI sessions, but those sessions are unnecessary for local generation and acceptance. Existing generated repositories are not migrated automatically.
