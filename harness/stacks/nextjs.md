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
- Backend: Supabase for database, auth, and storage (`@supabase/supabase-js` + `@supabase/ssr`). Enable Row Level Security on every table holding user data.
- Every app ships with Supabase auth wired end to end: sign-in flow, protected routes, and session handling.
- UI: Tailwind CSS + shadcn/ui components.
- Structure: minimal feature folders — `app/` for routes, `features/<name>/` for feature logic and components, `lib/` for shared domain code. No extra layering until the app demonstrably needs it.
- Deployment target: Docker on the owner's server. Include a multi-stage `Dockerfile` using Next.js standalone output and a `docker-compose.yml`.
- Dependencies: well-known, actively maintained libraries are fine when they save real time; pin versions.
- Language: code, comments, and docs in English; user-facing copy follows the PRD's language.
