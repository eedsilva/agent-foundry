# Stack: Next.js web application

Unless the approved architecture says otherwise:

- Use current Next.js App Router conventions and React server/client boundaries deliberately.
- Use TypeScript with strict mode.
- Keep domain logic outside React components and route handlers.
- Validate untrusted input at process boundaries.
- Prefer server-side data access and explicit API contracts.
- Include loading, error, and empty states for user-facing workflows.
- Avoid global mutable state and giant all-purpose components.
- Do not introduce a queue or state library without a demonstrated need.

## Owner defaults

Standing choices for generated apps. The PRD or approved architecture may override them; record any override as a decision.

- Package manager: pnpm.
- Backend: the project's own isolated local Supabase Docker stack (`@supabase/supabase-js` + `@supabase/ssr`), per ADR 0007. Never point a generated app at Supabase Cloud or another project's stack. Enable Row Level Security on every table holding user data.
- Every app ships with Supabase auth wired end to end: sign-in flow, protected routes, and session handling. Email/password only — no OAuth, magic links, or SMTP; password reset is an administrator operation.
- Secrets and credentials live in local `.env` files: git-ignored and never echoed into source, prompts, artifacts, screenshots, or logs.
- UI: Tailwind CSS + shadcn/ui components.
- Structure: minimal feature folders — `app/` for routes, `features/<name>/` for feature logic and components, `lib/` for shared domain code. No extra layering until the app demonstrably needs it.
- Deployment target: Docker Compose on the owner's existing VPS behind Caddy, per ADR 0008. Include a multi-stage `Dockerfile` using Next.js standalone output and a `docker-compose.yml`.
- Dependencies: well-known, actively maintained libraries are fine when they save real time; pin versions.
- Language: code, comments, and docs in English; user-facing copy follows the PRD's language.

## Generated-project uploads

- Use only the private `uploads` bucket. Do not use `getPublicUrl`, S3 credentials, or a service-role key in browser code.
- First call `prepare_storage_upload` for `<user.id>/<opaque-name>`, then use the authenticated Supabase client to create and use its signed upload URL. Signed URLs are short-lived bearer credentials: never log or persist them.
- Render or download only after `scan_status = clean`; `quarantine` and `rejected` are unavailable. Only the service-role scanner may read `storage_scan_queue` and call `complete_storage_scan`; no browser may set scan state.
- Export bytes before `confirm_storage_export`. Cleanup calls `storage_cleanup_candidates`, deletes bytes through the Storage API, then calls `confirm_storage_cleanup`.
