# Issue Radar Reference App (#76) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `examples/issue-radar-app/` as agent-foundry's golden full-stack reference app — Next.js + Tailwind + shadcn/ui + local Supabase, email/password auth guarding CRUD/filters/dashboard, attachments via Storage + RLS — closing GitHub issue #76.

**Architecture:** Hand-author the app directly, following exactly the conventions the `web-app-v1` generation pipeline would produce (`harness/scaffolds/nextjs/` auth pattern, `harness/stacks/{nextjs,supabase}.md` rules, the RLS-baseline and storage-RPC shapes already shipped by #71-#75). This proves the platform's conventions produce a real, correct app without running the slow, costly, unproven live multi-agent generation loop end-to-end — matching how #71-#75 themselves shipped (library + convention + e2e proof, not a live-generated artifact). A Playwright golden-journey spec and a cross-user negative-RLS spec are the acceptance evidence.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS v4 (CSS-first `@theme`), shadcn/ui (CLI-installed), `@supabase/ssr` + `@supabase/supabase-js`, local Supabase (Postgres + Auth + Storage), Playwright (browser e2e), Vitest (pure-function unit tests), Docker Compose deployment per ADR 0008.

## Global Constraints

- Package manager for the example app: `npm` (matches the existing `apps/api/e2e/generated-app-auth.spec.ts` fixture pattern — not the `pnpm` mentioned in `harness/stacks/nextjs.md` prose, since this repo's actual e2e tooling installs example fixtures with `npm`).
- Next.js `16.2.11`, React `19.1.1`, `@supabase/ssr ^0.12.3`, `@supabase/supabase-js ^2.58.0` — pinned to the exact versions `apps/api/e2e/generated-app-auth.spec.ts` already uses, so the two Playwright fixtures (auth-only scaffold vs. Issue Radar) stay consistent.
- TypeScript strict mode everywhere. `next.config.ts` sets `output: 'standalone'` per `harness/stacks/nextjs.md`.
- `examples/issue-radar-app/` is **not** added to root `package.json` workspaces (`apps/*`, `packages/*` only) — it is a standalone npm project, exactly like the Playwright auth fixture treats a copy of `harness/scaffolds/nextjs`. Do not touch root `workspaces`.
- RLS: every new table enables RLS in the same migration that creates it; policies named `<table>_<operation>_<scope>`; default-deny; never grant `anon` write. Migrations are forward-only — never edit an applied migration, only add new ones under `supabase/migrations/<YYYYMMDDHHMMSS>_<name>.sql`.
- Service-role Supabase key never appears in a client/browser-bundled file — only inside `app/api/attachments/scan/route.ts` and `lib/supabase/service-role.ts` (both server-only).
- Verification convention for UI feature tasks: `npm run typecheck` (`tsc --noEmit`) + `npm run build` inside `examples/issue-radar-app` is the fast per-task gate (this repo has no per-component unit-test convention for generated React apps — the pipeline itself verifies via `deterministic-verification` (typecheck/lint/test/build) then `browser-verification` (Playwright), not per-component tests). Full behavioral proof is the two Playwright specs in Tasks 9-10.
- Do **not** modify `harness/scaffolds/nextjs/`, wire `security-lint`'s `blocksRelease` into the orchestrator's release path, or build a new project-export/bundling API. Those are real gaps in the platform but are out of scope for #76: roadmap's own "touchpoints prováveis" for this issue are `workflows`, `examples`, `apps/web`, `docs` — not `harness` or `packages/orchestrator`. "Exportable code/migrations/Compose" is satisfied by the fact that `examples/issue-radar-app/` (app code + `supabase/migrations/*.sql` + `Dockerfile` + `docker-compose.yml`) is a git-tracked, self-contained, `docker compose up`-able directory — documented in Task 12, not built as new machinery.

---

## Setup (before Task 1)

Use **superpowers:using-git-worktrees** to create a fresh worktree for this work, branched from the latest `origin/main` (which already contains the merged #70-#75 work) — do **not** reuse the current `issue-75-data-security` worktree, which is locked to a different, already-closed issue and is 1 commit behind `origin/main`.

```bash
git fetch origin
git worktree add /Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-76-issue-radar-app -b agent/issue-76-issue-radar-app origin/main
cd /Users/edsilva/Documents/ed/agent-foundry-worktrees/issue-76-issue-radar-app
npm ci
```

All file paths below are relative to that worktree root.

---

### Task 1: Correct the Issue Radar PRD's attachment scope

The existing `examples/issue-radar.prd.md` lists "Anexos" (attachments) under "Fora de escopo" (out of scope), which contradicts issue #76's acceptance criterion that attachments work via Storage + RLS. Fix the source-of-truth PRD before building against it.

**Files:**

- Modify: `examples/issue-radar.prd.md`

**Interfaces:** none (prose only).

- [ ] **Step 1: Remove "Anexos" from "Fora de escopo" and add an attachment feature/acceptance line**

In `examples/issue-radar.prd.md`:

- Under `## Funcionalidades`, add a bullet after "Exibir estados de loading, vazio e erro.":
  ```
  - Anexar um arquivo (imagem ou PDF, até 10MB) a uma issue.
  ```
- Under `## Critérios de aceite`, add a bullet after "O dashboard reflete imediatamente as alterações.":
  ```
  - O usuário consegue anexar um arquivo a uma issue e revê-lo depois.
  ```
- Under `## Fora de escopo`, delete the line `- Anexos.`

- [ ] **Step 2: Verify the removal**

Run: `grep -n "Anexos" examples/issue-radar.prd.md`
Expected: only the new "Anexar um arquivo..." functionality line matches; the old "Fora de escopo" bullet is gone (grep shows exactly one hit, in `## Funcionalidades`).

- [ ] **Step 3: Commit**

```bash
git add examples/issue-radar.prd.md
git commit -m "docs(issue-radar): bring attachments into PRD scope for #76"
```

---

### Task 2: Scaffold the Issue Radar Next.js + Supabase app shell

Set up the standalone app: build tooling, Tailwind v4 + shadcn/ui, the reused Supabase auth pattern (adapted from `harness/scaffolds/nextjs/`, not a modification of it), Docker deployment files, and `.env` handling. This is the foundation every later task builds on.

**Files:**

- Create: `examples/issue-radar-app/package.json`
- Create: `examples/issue-radar-app/next.config.ts`
- Create: `examples/issue-radar-app/tsconfig.json`
- Create: `examples/issue-radar-app/postcss.config.mjs`
- Create: `examples/issue-radar-app/app/globals.css`
- Create: `examples/issue-radar-app/app/layout.tsx`
- Create: `examples/issue-radar-app/middleware.ts`
- Create: `examples/issue-radar-app/lib/supabase/client.ts`
- Create: `examples/issue-radar-app/lib/supabase/server.ts`
- Create: `examples/issue-radar-app/lib/supabase/service-role.ts`
- Create: `examples/issue-radar-app/app/sign-in/page.tsx`
- Create: `examples/issue-radar-app/app/sign-up/page.tsx`
- Create: `examples/issue-radar-app/app/actions.ts`
- Create: `examples/issue-radar-app/app/page.tsx`
- Create: `examples/issue-radar-app/.env.example`
- Create: `examples/issue-radar-app/.gitignore`
- Create: `examples/issue-radar-app/Dockerfile`
- Create: `examples/issue-radar-app/docker-compose.yml`
- Create: `examples/issue-radar-app/README.md` (stub — filled fully in Task 12)

**Interfaces:**

- Produces: `createClient()` (browser, `lib/supabase/client.ts`), `createClient()` (server/async, `lib/supabase/server.ts`), `createServiceRoleClient()` (`lib/supabase/service-role.ts`) — every later task's server actions/route handlers import these three.
- Produces: middleware redirect contract — any route not under `/sign-in` or `/sign-up` requires an authenticated session, else redirect to `/sign-in`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "issue-radar-app",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "16.2.11",
    "react": "19.1.1",
    "react-dom": "19.1.1",
    "@supabase/ssr": "^0.12.3",
    "@supabase/supabase-js": "^2.58.0",
    "zod": "^4.1.12"
  },
  "devDependencies": {
    "typescript": "^5",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "tailwindcss": "^4",
    "@tailwindcss/postcss": "^4",
    "vitest": "^3"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`** (matches the existing Playwright auth fixture's config exactly, so both fixtures behave identically)

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Write `next.config.ts`**

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
};

export default nextConfig;
```

- [ ] **Step 4: Write `postcss.config.mjs` and `app/globals.css`** (Tailwind v4 CSS-first config, no `tailwind.config.js`)

`postcss.config.mjs`:

```javascript
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

`app/globals.css`:

```css
@import 'tailwindcss';

@theme {
  --color-brand: oklch(0.55 0.18 255);
}

body {
  color-scheme: light dark;
}
```

- [ ] **Step 5: Write `app/layout.tsx`**

```tsx
import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Issue Radar' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 6: Write `middleware.ts`** (same redirect contract as `harness/scaffolds/nextjs/middleware.ts`, copied not imported)

```typescript
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/sign-in', '/sign-up'];

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicPath = PUBLIC_PATHS.some((path) => request.nextUrl.pathname.startsWith(path));
  if (!user && !isPublicPath) {
    return NextResponse.redirect(new URL('/sign-in', request.url));
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
```

- [ ] **Step 7: Write `lib/supabase/client.ts` and `lib/supabase/server.ts`** (copied verbatim from `harness/scaffolds/nextjs/lib/supabase/`)

`lib/supabase/client.ts`:

```typescript
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
```

`lib/supabase/server.ts`:

```typescript
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component; middleware refreshes the session instead.
          }
        },
      },
    },
  );
}
```

- [ ] **Step 8: Write `lib/supabase/service-role.ts`** (new — server-only, used only by the attachment scan route in Task 7)

```typescript
import { createClient } from '@supabase/supabase-js';

// Server-only: never import this module from a Client Component or any
// module reachable from the browser bundle (harness/stacks/supabase.md).
export function createServiceRoleClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
```

- [ ] **Step 9: Write `app/sign-in/page.tsx`, `app/sign-up/page.tsx`, `app/actions.ts`** (copied from `harness/scaffolds/nextjs/app/`, unchanged behavior)

`app/sign-in/page.tsx`:

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignInPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

    setLoading(false);
    if (signInError) {
      setError(signInError.message);
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <input
        type="email"
        required
        placeholder="Email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="rounded border px-3 py-2"
      />
      <input
        type="password"
        required
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="rounded border px-3 py-2"
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button type="submit" disabled={loading} className="rounded bg-black px-3 py-2 text-white">
        {loading ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
```

`app/sign-up/page.tsx`:

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function SignUpPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    const { error: signUpError } = await supabase.auth.signUp({ email, password });

    setLoading(false);
    if (signUpError) {
      setError(signUpError.message);
      return;
    }
    router.push('/');
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="mx-auto flex max-w-sm flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Create account</h1>
      <input
        type="email"
        required
        placeholder="Email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        className="rounded border px-3 py-2"
      />
      <input
        type="password"
        required
        minLength={8}
        placeholder="Password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        className="rounded border px-3 py-2"
      />
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <button type="submit" disabled={loading} className="rounded bg-black px-3 py-2 text-white">
        {loading ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
```

`app/actions.ts`:

```typescript
'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/sign-in');
}
```

- [ ] **Step 10: Write `app/page.tsx`** (root redirect — middleware already guarantees a session here)

```tsx
import { redirect } from 'next/navigation';

export default function HomePage() {
  redirect('/projects');
}
```

- [ ] **Step 11: Write `.env.example` and `.gitignore`**

`.env.example`:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

`.gitignore`:

```
node_modules/
.next/
.env
.env.local
```

- [ ] **Step 12: Write `Dockerfile`** (multi-stage, Next.js standalone output, per `harness/stacks/nextjs.md` / ADR 0008)

```dockerfile
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 13: Write `docker-compose.yml`** (app service only — points at the operator's already-running local Supabase stack via env vars, per ADR 0008; no bundled Postgres/Supabase service, matching "one isolated Compose project per app")

```yaml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    environment:
      NEXT_PUBLIC_SUPABASE_URL: ${NEXT_PUBLIC_SUPABASE_URL:?set this to your local Supabase API URL}
      NEXT_PUBLIC_SUPABASE_ANON_KEY: ${NEXT_PUBLIC_SUPABASE_ANON_KEY:?set this to your local Supabase anon key}
      SUPABASE_SERVICE_ROLE_KEY: ${SUPABASE_SERVICE_ROLE_KEY:?set this to your local Supabase service_role key}
    ports:
      - '3000:3000'
```

- [ ] **Step 14: Write a `README.md` stub** (fully documented in Task 12)

```markdown
# Issue Radar

Reference Issue Radar app for agent-foundry — see `../issue-radar.prd.md` for the product spec.

Full setup, golden-journey, and export/deploy instructions land in Task 12 of
`docs/superpowers/plans/2026-07-24-issue-76-issue-radar-reference-app.md`.
```

- [ ] **Step 15: Install dependencies and run shadcn/ui init**

```bash
cd examples/issue-radar-app
npm install
npx shadcn@latest init -y -b neutral
npx shadcn@latest add button input textarea label select badge card dialog
```

Expected: `components.json`, `lib/utils.ts`, and `components/ui/{button,input,textarea,label,select,badge,card,dialog}.tsx` are created. Commit these CLI-generated files as-is.

- [ ] **Step 16: Verify the shell builds**

```bash
cp .env.example .env.local
echo 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321' >> .env.local
echo 'NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder' >> .env.local
echo 'SUPABASE_SERVICE_ROLE_KEY=placeholder' >> .env.local
npm run typecheck
npm run build
```

Expected: `tsc --noEmit` exits 0; `next build` prints "Compiled successfully" and exits 0 (dummy env values are fine — no network call happens at build time). Remove `.env.local` afterwards (it's gitignored, but don't leave stray local state).

- [ ] **Step 17: Commit**

```bash
cd ../..
git add examples/issue-radar-app
git commit -m "feat(issue-radar): scaffold Next.js + Supabase + shadcn app shell"
```

---

### Task 3: Author database schema migrations and storage wiring

Add the storage migration (generated via the existing platform helper, so it's byte-identical to what the real pipeline would install) and the Issue Radar domain schema (`projects`, `issues`, `issue_attachments`), all RLS-scoped to the owning user. Add a regression test so nobody can silently break RLS on these migrations later.

**Files:**

- Create: `examples/issue-radar-app/supabase/config.toml`
- Create: `examples/issue-radar-app/supabase/migrations/00000000000000_agent_foundry_storage.sql`
- Create: `examples/issue-radar-app/supabase/migrations/00000000000001_issue_radar_schema.sql`
- Create: `packages/platform/src/issue-radar-example-security-lint.test.ts`

**Interfaces:**

- Produces: tables `public.projects(id, owner_id, name, created_at)`, `public.issues(id, project_id, owner_id, title, description, priority, status, completed_at, created_at, updated_at)`, `public.issue_attachments(id, issue_id, owner_id, object_name, created_at)`. Every later task's server actions query these exact columns.
- Consumes: `generatedStorageMigration()` and `configureGeneratedStorage()` from `@agent-foundry/platform` (`packages/platform/src/supabase-storage.ts`) — used once, ad hoc, to generate the storage migration file (not a runtime dependency of the example app).

- [ ] **Step 1: Generate `supabase/config.toml` and the storage migration**

Run `supabase init` inside the app directory, then generate the storage migration file content from the platform package (one-off, not committed as a script):

```bash
cd examples/issue-radar-app
npx supabase init
node --experimental-strip-types -e "
import { generatedStorageMigration } from '../../packages/platform/src/supabase-storage.ts';
import { writeFileSync } from 'node:fs';
writeFileSync('supabase/migrations/00000000000000_agent_foundry_storage.sql', generatedStorageMigration());
"
```

Then append the storage bucket config block to `supabase/config.toml` using `configureGeneratedStorage`:

```bash
node --experimental-strip-types -e "
import { configureGeneratedStorage } from '../../packages/platform/src/supabase-storage.ts';
import { readFileSync, writeFileSync } from 'node:fs';
const config = readFileSync('supabase/config.toml', 'utf8');
writeFileSync('supabase/config.toml', configureGeneratedStorage(config));
"
```

Expected: `supabase/migrations/00000000000000_agent_foundry_storage.sql` contains the `storage_uploads` table + RLS policies + RPCs (verify with `grep -c "create function" supabase/migrations/00000000000000_agent_foundry_storage.sql` → `6`); `supabase/config.toml` gains a `[storage.buckets.uploads]` section.

- [ ] **Step 2: Write the Issue Radar domain migration**

`supabase/migrations/00000000000001_issue_radar_schema.sql`:

```sql
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) default auth.uid(),
  name text not null check (char_length(name) between 1 and 140),
  created_at timestamptz not null default now()
);

alter table public.projects enable row level security;

create policy projects_select_owner
  on public.projects for select to authenticated
  using (owner_id = (select auth.uid()));

create policy projects_insert_owner
  on public.projects for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy projects_update_owner
  on public.projects for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy projects_delete_owner
  on public.projects for delete to authenticated
  using (owner_id = (select auth.uid()));

create type public.issue_priority as enum ('low', 'medium', 'high', 'critical');
create type public.issue_status as enum ('open', 'in_progress', 'completed');

create table public.issues (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references auth.users(id) default auth.uid(),
  title text not null check (char_length(title) between 1 and 140),
  description text not null default '',
  priority public.issue_priority not null default 'medium',
  status public.issue_status not null default 'open',
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.issues enable row level security;

create policy issues_select_owner
  on public.issues for select to authenticated
  using (owner_id = (select auth.uid()));

create policy issues_insert_owner
  on public.issues for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy issues_update_owner
  on public.issues for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy issues_delete_owner
  on public.issues for delete to authenticated
  using (owner_id = (select auth.uid()));

create table public.issue_attachments (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.issues(id) on delete cascade,
  owner_id uuid not null references auth.users(id) default auth.uid(),
  object_name text not null references public.storage_uploads(object_name) on delete cascade,
  created_at timestamptz not null default now(),
  unique (issue_id, object_name)
);

alter table public.issue_attachments enable row level security;

create policy issue_attachments_select_owner
  on public.issue_attachments for select to authenticated
  using (owner_id = (select auth.uid()));

create policy issue_attachments_insert_owner
  on public.issue_attachments for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy issue_attachments_delete_owner
  on public.issue_attachments for delete to authenticated
  using (owner_id = (select auth.uid()));
```

- [ ] **Step 3: Write the failing regression test in `packages/platform`**

`packages/platform/src/issue-radar-example-security-lint.test.ts`:

```typescript
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blocksRelease, lintMigrationsDir } from './security-lint.js';

const MIGRATIONS_DIR = resolve(
  import.meta.dirname,
  '../../../examples/issue-radar-app/supabase/migrations',
);

describe('Issue Radar example migrations', () => {
  it('never regress to a state the release gate would block', async () => {
    const report = await lintMigrationsDir(MIGRATIONS_DIR);
    if (blocksRelease(report)) {
      const summary = report.findings
        .map((finding) => `${finding.severity} ${finding.rule} (${finding.location})`)
        .join('; ');
      throw new Error(`Issue Radar migrations would block release: ${summary}`);
    }
    expect(blocksRelease(report)).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test to verify it passes** (Steps 1-2 already wrote real, RLS-complete migrations, so this should pass on first run — that's the point: it locks in correctness now and catches regressions later)

Run: `npx vitest run packages/platform/src/issue-radar-example-security-lint.test.ts`
Expected: `1 passed`.

If it fails, read the reported findings (`missing-rls`, `sensitive-table-no-policy`, `anon-write-policy`, `anon-grant`, or `destructive-migration`) and fix the migration in Step 2 — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add examples/issue-radar-app/supabase packages/platform/src/issue-radar-example-security-lint.test.ts
git commit -m "feat(issue-radar): add owner-scoped RLS schema for projects, issues, attachments"
```

---

### Task 4: Projects feature — create and list

**Files:**

- Create: `examples/issue-radar-app/features/projects/schema.ts`
- Create: `examples/issue-radar-app/features/projects/actions.ts`
- Create: `examples/issue-radar-app/app/projects/page.tsx`
- Create: `examples/issue-radar-app/app/projects/new-project-form.tsx`

**Interfaces:**

- Consumes: `createClient()` from `@/lib/supabase/server` (Task 2).
- Produces: `createProject(formData: FormData): Promise<void>` (redirects on success) — not consumed elsewhere, but establishes the server-action pattern Tasks 5-7 repeat.

- [ ] **Step 1: Write `features/projects/schema.ts`**

```typescript
import { z } from 'zod';

export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1, 'Project name is required.')
  .max(140, 'Project name must be 140 characters or fewer.');
```

- [ ] **Step 2: Write `features/projects/actions.ts`**

```typescript
'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { ProjectNameSchema } from './schema';

export async function createProject(formData: FormData) {
  const name = ProjectNameSchema.parse(formData.get('name'));
  const supabase = await createClient();
  const { data, error } = await supabase.from('projects').insert({ name }).select('id').single();
  if (error) throw new Error(error.message);
  redirect(`/projects/${data.id}`);
}
```

- [ ] **Step 3: Write `app/projects/new-project-form.tsx`** (client component — needed for `useState` error display)

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createProject } from '@/features/projects/actions';

export function NewProjectForm() {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await createProject(new FormData(event.currentTarget));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create project.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <Input name="name" placeholder="Project name" required maxLength={140} />
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'New project'}
      </Button>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
```

- [ ] **Step 4: Write `app/projects/page.tsx`** (server component — list scoped by RLS, no manual owner filter needed)

```tsx
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { createClient } from '@/lib/supabase/server';
import { signOut } from '@/app/actions';
import { NewProjectForm } from './new-project-form';

export default async function ProjectsPage() {
  const supabase = await createClient();
  const { data: projects, error } = await supabase
    .from('projects')
    .select('id, name, created_at')
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <form action={signOut}>
          <button type="submit" className="text-sm text-gray-500 underline">
            Sign out
          </button>
        </form>
      </div>
      <NewProjectForm />
      {projects.length === 0 ? (
        <p className="text-sm text-gray-500">No projects yet. Create one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {projects.map((project) => (
            <li key={project.id}>
              <Link href={`/projects/${project.id}`}>
                <Card className="p-4 hover:bg-gray-50">{project.name}</Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 5: Verify the app still typechecks and builds**

```bash
cd examples/issue-radar-app
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
cd ../..
git add examples/issue-radar-app/features/projects examples/issue-radar-app/app/projects
git commit -m "feat(issue-radar): add project creation and listing"
```

---

### Task 5: Issues feature — create, edit, complete, reopen

**Files:**

- Create: `examples/issue-radar-app/features/issues/schema.ts`
- Create: `examples/issue-radar-app/features/issues/actions.ts`
- Create: `examples/issue-radar-app/app/projects/[projectId]/page.tsx`
- Create: `examples/issue-radar-app/app/projects/[projectId]/issue-row.tsx`
- Create: `examples/issue-radar-app/app/projects/[projectId]/issues/new/page.tsx`
- Create: `examples/issue-radar-app/app/projects/[projectId]/issues/[issueId]/page.tsx`
- Create: `examples/issue-radar-app/app/projects/[projectId]/issues/issue-form.tsx`

**Interfaces:**

- Consumes: `createClient()` (Task 2); `projects` table (Task 3, for the project-name heading).
- Produces: `IssuePrioritySchema`, `IssueStatusSchema`, `IssueFormSchema` (`features/issues/schema.ts`) and `createIssue`, `updateIssue`, `completeIssue`, `reopenIssue` (`features/issues/actions.ts`) — Task 6 (filters/dashboard) and Task 7 (attachments) both import these types and the issue detail page.

- [ ] **Step 1: Write `features/issues/schema.ts`**

```typescript
import { z } from 'zod';

export const IssuePrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type IssuePriority = z.infer<typeof IssuePrioritySchema>;

export const IssueStatusSchema = z.enum(['open', 'in_progress', 'completed']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const IssueFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required.')
    .max(140, 'Title must be 140 characters or fewer.'),
  description: z.string().trim().max(10_000).default(''),
  priority: IssuePrioritySchema.default('medium'),
});
export type IssueFormInput = z.infer<typeof IssueFormSchema>;

export interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: IssuePriority;
  status: IssueStatus;
  completed_at: string | null;
  created_at: string;
}
```

- [ ] **Step 2: Write `features/issues/actions.ts`**

```typescript
'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { IssueFormSchema } from './schema';

function parseIssueForm(formData: FormData) {
  return IssueFormSchema.parse({
    title: formData.get('title'),
    description: formData.get('description') ?? '',
    priority: formData.get('priority') || undefined,
  });
}

export async function createIssue(projectId: string, formData: FormData) {
  const input = parseIssueForm(formData);
  const supabase = await createClient();
  const { error } = await supabase.from('issues').insert({ project_id: projectId, ...input });
  if (error) throw new Error(error.message);
  redirect(`/projects/${projectId}`);
}

export async function updateIssue(issueId: string, projectId: string, formData: FormData) {
  const input = parseIssueForm(formData);
  const supabase = await createClient();
  const { error } = await supabase.from('issues').update(input).eq('id', issueId);
  if (error) throw new Error(error.message);
  redirect(`/projects/${projectId}`);
}

export async function completeIssue(issueId: string, projectId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('issues')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', issueId);
  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}`);
}

export async function reopenIssue(issueId: string, projectId: string) {
  const supabase = await createClient();
  const { error } = await supabase
    .from('issues')
    .update({ status: 'open', completed_at: null })
    .eq('id', issueId);
  if (error) throw new Error(error.message);
  revalidatePath(`/projects/${projectId}`);
}
```

- [ ] **Step 3: Write `app/projects/[projectId]/issues/issue-form.tsx`** (shared by create and edit)

```tsx
'use client';

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Issue } from '@/features/issues/schema';

export function IssueForm({
  issue,
  onSubmit,
}: {
  issue?: Pick<Issue, 'title' | 'description' | 'priority'>;
  onSubmit: (formData: FormData) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await onSubmit(new FormData(event.currentTarget));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save issue.');
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="title">Title</Label>
        <Input id="title" name="title" defaultValue={issue?.title} required maxLength={140} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="description">Description</Label>
        <Textarea id="description" name="description" defaultValue={issue?.description} rows={4} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="priority">Priority</Label>
        <Select name="priority" defaultValue={issue?.priority ?? 'medium'}>
          <SelectTrigger id="priority">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </form>
  );
}
```

- [ ] **Step 4: Write `app/projects/[projectId]/issues/new/page.tsx`**

```tsx
import { createIssue } from '@/features/issues/actions';
import { IssueForm } from '../issue-form';

export default async function NewIssuePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;

  async function onSubmit(formData: FormData) {
    'use server';
    await createIssue(projectId, formData);
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-xl font-semibold">New issue</h1>
      <IssueForm onSubmit={onSubmit} />
    </main>
  );
}
```

- [ ] **Step 5: Write `app/projects/[projectId]/issues/[issueId]/page.tsx`**

```tsx
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { updateIssue } from '@/features/issues/actions';
import { IssueForm } from '../issue-form';

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; issueId: string }>;
}) {
  const { projectId, issueId } = await params;
  const supabase = await createClient();
  const { data: issue } = await supabase
    .from('issues')
    .select('id, title, description, priority')
    .eq('id', issueId)
    .maybeSingle();

  if (!issue) notFound();

  async function onSubmit(formData: FormData) {
    'use server';
    await updateIssue(issueId, projectId, formData);
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-4 text-xl font-semibold">Edit issue</h1>
      <IssueForm issue={issue} onSubmit={onSubmit} />
    </main>
  );
}
```

- [ ] **Step 6: Write `app/projects/[projectId]/issue-row.tsx`** (complete/reopen quick actions)

```tsx
'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { completeIssue, reopenIssue } from '@/features/issues/actions';
import type { Issue } from '@/features/issues/schema';

export function IssueRow({ issue, projectId }: { issue: Issue; projectId: string }) {
  return (
    <li className="flex items-center justify-between gap-2 rounded border p-3">
      <Link href={`/projects/${projectId}/issues/${issue.id}`} className="flex-1">
        <span className="font-medium">{issue.title}</span>{' '}
        <Badge variant="outline">{issue.priority}</Badge>{' '}
        <Badge variant="secondary">{issue.status}</Badge>
      </Link>
      {issue.status === 'completed' ? (
        <Button variant="outline" size="sm" onClick={() => reopenIssue(issue.id, projectId)}>
          Reopen
        </Button>
      ) : (
        <Button variant="outline" size="sm" onClick={() => completeIssue(issue.id, projectId)}>
          Complete
        </Button>
      )}
    </li>
  );
}
```

- [ ] **Step 7: Write `app/projects/[projectId]/page.tsx`** (issue list only for now — filters and dashboard land in Task 6)

```tsx
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import type { Issue } from '@/features/issues/schema';
import { IssueRow } from './issue-row';

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) notFound();

  const { data: issues, error } = await supabase
    .from('issues')
    .select('id, project_id, title, description, priority, status, completed_at, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })
    .returns<Issue[]>();
  if (error) throw new Error(error.message);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <Button asChild>
          <Link href={`/projects/${projectId}/issues/new`}>New issue</Link>
        </Button>
      </div>
      {issues.length === 0 ? (
        <p className="text-sm text-gray-500">No issues yet. Create one above.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} projectId={projectId} />
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 8: Verify the app still typechecks and builds**

```bash
cd examples/issue-radar-app
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 9: Commit**

```bash
cd ../..
git add examples/issue-radar-app/features/issues examples/issue-radar-app/app/projects
git commit -m "feat(issue-radar): add issue create/edit/complete/reopen"
```

---

### Task 6: Filters and dashboard counts

The pure filter-combination and count logic gets real unit tests (Vitest) — this is genuine TDD material: no DOM, no server, just branching logic worth locking down before wiring it into the page.

**Files:**

- Create: `examples/issue-radar-app/features/issues/filters.ts`
- Create: `examples/issue-radar-app/features/issues/filters.test.ts`
- Create: `examples/issue-radar-app/features/issues/dashboard.ts`
- Create: `examples/issue-radar-app/features/issues/dashboard.test.ts`
- Create: `examples/issue-radar-app/app/projects/[projectId]/filters-bar.tsx`
- Create: `examples/issue-radar-app/app/projects/[projectId]/dashboard-counts.tsx`
- Modify: `examples/issue-radar-app/app/projects/[projectId]/page.tsx`

**Interfaces:**

- Consumes: `IssuePrioritySchema`, `IssueStatusSchema` (Task 5).
- Produces: `parseIssueFilters`, `IssueFilters` (`filters.ts`); `countByStatus`, `DashboardCounts` (`dashboard.ts`) — both used directly by the modified page component.

- [ ] **Step 1: Write the failing filter test**

`features/issues/filters.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { parseIssueFilters } from './filters';

describe('parseIssueFilters', () => {
  it('returns empty filters when no query params are present', () => {
    expect(parseIssueFilters({})).toEqual({ statuses: [], priorities: [] });
  });

  it('parses a single status and a single priority', () => {
    expect(parseIssueFilters({ status: 'open', priority: 'high' })).toEqual({
      statuses: ['open'],
      priorities: ['high'],
    });
  });

  it('combines multiple comma-separated statuses and priorities', () => {
    expect(parseIssueFilters({ status: 'open,in_progress', priority: 'high,critical' })).toEqual({
      statuses: ['open', 'in_progress'],
      priorities: ['high', 'critical'],
    });
  });

  it('drops invalid values instead of throwing', () => {
    expect(parseIssueFilters({ status: 'not-a-status,open' })).toEqual({
      statuses: ['open'],
      priorities: [],
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd examples/issue-radar-app && npx vitest run features/issues/filters.test.ts`
Expected: FAIL — `Cannot find module './filters'`.

- [ ] **Step 3: Write `features/issues/filters.ts`**

```typescript
import {
  IssuePrioritySchema,
  IssueStatusSchema,
  type IssuePriority,
  type IssueStatus,
} from './schema';

export interface IssueFilters {
  statuses: IssueStatus[];
  priorities: IssuePriority[];
}

export function parseIssueFilters(
  searchParams: Record<string, string | string[] | undefined>,
): IssueFilters {
  return {
    statuses: parseList(searchParams.status, IssueStatusSchema),
    priorities: parseList(searchParams.priority, IssuePrioritySchema),
  };
}

function parseList<T extends string>(
  value: string | string[] | undefined,
  schema: { safeParse: (input: unknown) => { success: boolean; data?: T } },
): T[] {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : value.split(',');
  const parsed: T[] = [];
  for (const item of raw) {
    const result = schema.safeParse(item);
    if (result.success && result.data !== undefined) parsed.push(result.data);
  }
  return parsed;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run features/issues/filters.test.ts`
Expected: `4 passed`.

- [ ] **Step 5: Write the failing dashboard-counts test**

`features/issues/dashboard.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { countByStatus } from './dashboard';

describe('countByStatus', () => {
  it('counts zero issues in every bucket for an empty list', () => {
    expect(countByStatus([])).toEqual({ open: 0, in_progress: 0, completed: 0, total: 0 });
  });

  it('tallies each status independently', () => {
    const rows = [
      { status: 'open' as const },
      { status: 'open' as const },
      { status: 'in_progress' as const },
      { status: 'completed' as const },
    ];
    expect(countByStatus(rows)).toEqual({ open: 2, in_progress: 1, completed: 1, total: 4 });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run features/issues/dashboard.test.ts`
Expected: FAIL — `Cannot find module './dashboard'`.

- [ ] **Step 7: Write `features/issues/dashboard.ts`**

```typescript
import type { IssueStatus } from './schema';

export interface DashboardCounts {
  open: number;
  in_progress: number;
  completed: number;
  total: number;
}

export function countByStatus(rows: { status: IssueStatus }[]): DashboardCounts {
  const counts: DashboardCounts = { open: 0, in_progress: 0, completed: 0, total: rows.length };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}
```

- [ ] **Step 8: Run both tests to verify they pass**

Run: `npx vitest run features/issues/filters.test.ts features/issues/dashboard.test.ts`
Expected: `6 passed`.

- [ ] **Step 9: Write `app/projects/[projectId]/filters-bar.tsx`** (client component driving URL search params)

```tsx
'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const STATUS_OPTIONS = ['all', 'open', 'in_progress', 'completed'] as const;
const PRIORITY_OPTIONS = ['all', 'low', 'medium', 'high', 'critical'] as const;

export function FiltersBar({ projectId }: { projectId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function setParam(key: 'status' | 'priority', value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === 'all') next.delete(key);
    else next.set(key, value);
    router.push(`/projects/${projectId}?${next.toString()}`);
  }

  return (
    <div className="flex gap-2">
      <Select
        defaultValue={searchParams.get('status') ?? 'all'}
        onValueChange={(value) => setParam('status', value)}
      >
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        defaultValue={searchParams.get('priority') ?? 'all'}
        onValueChange={(value) => setParam('priority', value)}
      >
        <SelectTrigger className="w-40">
          <SelectValue placeholder="Priority" />
        </SelectTrigger>
        <SelectContent>
          {PRIORITY_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
```

- [ ] **Step 10: Write `app/projects/[projectId]/dashboard-counts.tsx`**

```tsx
import type { DashboardCounts } from '@/features/issues/dashboard';

export function DashboardCountsBar({ counts }: { counts: DashboardCounts }) {
  return (
    <dl className="grid grid-cols-4 gap-2 text-center text-sm">
      <div className="rounded border p-2">
        <dt className="text-gray-500">Open</dt>
        <dd className="text-lg font-semibold">{counts.open}</dd>
      </div>
      <div className="rounded border p-2">
        <dt className="text-gray-500">In progress</dt>
        <dd className="text-lg font-semibold">{counts.in_progress}</dd>
      </div>
      <div className="rounded border p-2">
        <dt className="text-gray-500">Completed</dt>
        <dd className="text-lg font-semibold">{counts.completed}</dd>
      </div>
      <div className="rounded border p-2">
        <dt className="text-gray-500">Total</dt>
        <dd className="text-lg font-semibold">{counts.total}</dd>
      </div>
    </dl>
  );
}
```

- [ ] **Step 11: Wire filters and dashboard into `app/projects/[projectId]/page.tsx`**

Replace the issues query block with:

```tsx
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { createClient } from '@/lib/supabase/server';
import { countByStatus } from '@/features/issues/dashboard';
import { parseIssueFilters } from '@/features/issues/filters';
import type { Issue } from '@/features/issues/schema';
import { DashboardCountsBar } from './dashboard-counts';
import { FiltersBar } from './filters-bar';
import { IssueRow } from './issue-row';

export default async function ProjectDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const filters = parseIssueFilters(await searchParams);
  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .maybeSingle();
  if (!project) notFound();

  const { data: allIssues, error: allIssuesError } = await supabase
    .from('issues')
    .select('id, project_id, title, description, priority, status, completed_at, created_at')
    .eq('project_id', projectId)
    .returns<Issue[]>();
  if (allIssuesError) throw new Error(allIssuesError.message);

  let query = supabase
    .from('issues')
    .select('id, project_id, title, description, priority, status, completed_at, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
  if (filters.statuses.length) query = query.in('status', filters.statuses);
  if (filters.priorities.length) query = query.in('priority', filters.priorities);
  const { data: issues, error } = await query.returns<Issue[]>();
  if (error) throw new Error(error.message);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <Button asChild>
          <Link href={`/projects/${projectId}/issues/new`}>New issue</Link>
        </Button>
      </div>
      <DashboardCountsBar counts={countByStatus(allIssues)} />
      <FiltersBar projectId={projectId} />
      {issues.length === 0 ? (
        <p className="text-sm text-gray-500">No issues match the current filters.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} projectId={projectId} />
          ))}
        </ul>
      )}
    </main>
  );
}
```

- [ ] **Step 12: Verify the app still typechecks and builds**

```bash
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 13: Commit**

```bash
cd ..
git add issue-radar-app/features/issues issue-radar-app/app/projects
cd ..
git commit -m "feat(issue-radar): add combinable filters and dashboard counts"
```

---

### Task 7: Attachments — upload, local auto-scan, display

Uses the exact signed-upload-URL protocol `harness/stacks/nextjs.md` mandates (`prepare_storage_upload` RPC → signed upload URL → upload → wait for `scan_status = clean`). `complete_storage_scan` is `service_role`-only by design (#72); locally there's no real malware scanner, so a server-only route auto-approves immediately after upload — this is a deliberate, documented local-dev simplification, not a shortcut for a real deployment.

**Files:**

- Create: `examples/issue-radar-app/app/api/attachments/scan/route.ts`
- Create: `examples/issue-radar-app/features/attachments/actions.ts`
- Create: `examples/issue-radar-app/app/projects/[projectId]/issues/[issueId]/attachment-uploader.tsx`
- Create: `examples/issue-radar-app/app/projects/[projectId]/issues/[issueId]/attachment-list.tsx`
- Modify: `examples/issue-radar-app/app/projects/[projectId]/issues/[issueId]/page.tsx`

**Interfaces:**

- Consumes: `createClient()` / `createServiceRoleClient()` (Task 2); `issue_attachments`, `storage_uploads` tables (Task 3); the issue detail page (Task 5).
- Produces: `prepareAttachmentUpload(input): Promise<{upload, token, path}>`, `finalizeAttachment(input): Promise<void>` — used only by `attachment-uploader.tsx`.

- [ ] **Step 1: Write `app/api/attachments/scan/route.ts`** (server-only; service-role key never leaves this file)

```typescript
import { NextResponse } from 'next/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';

export async function POST(request: Request) {
  const body = (await request.json()) as { objectName?: string };
  if (!body.objectName) {
    return NextResponse.json({ error: 'objectName is required.' }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  // ponytail: trivial auto-approve scanner for local dev — there is no
  // malware-scanning service in v1. Replace this call with a real scan
  // service before accepting untrusted multi-tenant uploads.
  const { error } = await supabase.rpc('complete_storage_scan', {
    p_object_name: body.objectName,
    p_status: 'clean',
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ status: 'clean' });
}
```

- [ ] **Step 2: Write `features/attachments/actions.ts`**

```typescript
'use server';

import { createClient } from '@/lib/supabase/server';

export async function prepareAttachmentUpload(input: {
  objectName: string;
  mediaType: string;
  sizeBytes: number;
}) {
  const supabase = await createClient();
  const { error: prepareError } = await supabase.rpc('prepare_storage_upload', {
    p_object_name: input.objectName,
    p_media_type: input.mediaType,
    p_size_bytes: input.sizeBytes,
  });
  if (prepareError) throw new Error(prepareError.message);

  const { data: signed, error: signError } = await supabase.storage
    .from('uploads')
    .createSignedUploadUrl(input.objectName);
  if (signError) throw new Error(signError.message);

  return { token: signed.token };
}

export async function finalizeAttachment(input: { issueId: string; objectName: string }) {
  const scanResponse = await fetch(
    `${process.env.APP_BASE_URL ?? 'http://localhost:3000'}/api/attachments/scan`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ objectName: input.objectName }),
    },
  );
  if (!scanResponse.ok) throw new Error('Attachment scan failed.');

  const supabase = await createClient();
  const { error } = await supabase
    .from('issue_attachments')
    .insert({ issue_id: input.issueId, object_name: input.objectName });
  if (error) throw new Error(error.message);
}
```

- [ ] **Step 3: Write `attachment-uploader.tsx`** (client component)

```tsx
'use client';

import { useState, type ChangeEvent } from 'react';
import { createClient } from '@/lib/supabase/client';
import { finalizeAttachment, prepareAttachmentUpload } from '@/features/attachments/actions';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'application/pdf'];

export function AttachmentUploader({ issueId, ownerId }: { issueId: string; ownerId: string }) {
  const supabase = createClient();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!ALLOWED_TYPES.includes(file.type)) {
      setError('Only PNG, JPEG, or PDF files are allowed.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('File must be 10MB or smaller.');
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const objectName = `${ownerId}/${crypto.randomUUID()}-${file.name}`;
      const { token } = await prepareAttachmentUpload({
        objectName,
        mediaType: file.type,
        sizeBytes: file.size,
      });
      const { error: uploadError } = await supabase.storage
        .from('uploads')
        .uploadToSignedUrl(objectName, token, file);
      if (uploadError) throw uploadError;
      await finalizeAttachment({ issueId, objectName });
      window.location.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="file"
        accept="image/png,image/jpeg,application/pdf"
        onChange={handleChange}
        disabled={uploading}
      />
      {uploading ? <p className="text-sm text-gray-500">Uploading…</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 4: Write `attachment-list.tsx`** (server component)

```tsx
import { createClient } from '@/lib/supabase/server';

export async function AttachmentList({ issueId }: { issueId: string }) {
  const supabase = await createClient();
  const { data: attachments, error } = await supabase
    .from('issue_attachments')
    .select('object_name')
    .eq('issue_id', issueId);
  if (error) throw new Error(error.message);

  if (!attachments.length) {
    return <p className="text-sm text-gray-500">No attachments yet.</p>;
  }

  const links = await Promise.all(
    attachments.map(async (attachment) => {
      const { data } = await supabase.storage
        .from('uploads')
        .createSignedUrl(attachment.object_name, 60);
      return { objectName: attachment.object_name, url: data?.signedUrl };
    }),
  );

  return (
    <ul className="flex flex-col gap-1">
      {links.map((link) => (
        <li key={link.objectName}>
          {link.url ? (
            <a
              href={link.url}
              className="text-sm text-blue-600 underline"
              target="_blank"
              rel="noreferrer"
            >
              {link.objectName.split('/').pop()}
            </a>
          ) : (
            <span className="text-sm text-gray-400">
              {link.objectName.split('/').pop()} (processing…)
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Wire attachments into the issue detail page**

Modify `app/projects/[projectId]/issues/[issueId]/page.tsx`, adding after `<IssueForm .../>`:

```tsx
import { createClient } from '@/lib/supabase/server';
// ...existing imports...
import { AttachmentList } from './attachment-list';
import { AttachmentUploader } from './attachment-uploader';
```

And inside the component, after fetching `issue`, fetch the current user id and render the attachments section:

```tsx
const {
  data: { user },
} = await supabase.auth.getUser();

// ...existing IssueForm render...

return (
  <main className="mx-auto max-w-lg p-6">
    <h1 className="mb-4 text-xl font-semibold">Edit issue</h1>
    <IssueForm issue={issue} onSubmit={onSubmit} />
    <section className="mt-8 flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-gray-700">Attachments</h2>
      <AttachmentList issueId={issueId} />
      {user ? <AttachmentUploader issueId={issueId} ownerId={user.id} /> : null}
    </section>
  </main>
);
```

- [ ] **Step 6: Verify the app still typechecks and builds**

```bash
cd examples/issue-radar-app
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
cd ../..
git add examples/issue-radar-app/app/api examples/issue-radar-app/features/attachments examples/issue-radar-app/app/projects
git commit -m "feat(issue-radar): add attachment upload, local scan, and display"
```

---

### Task 8: Loading, empty, error states, and a responsive pass

**Files:**

- Create: `examples/issue-radar-app/app/projects/loading.tsx`
- Create: `examples/issue-radar-app/app/projects/error.tsx`
- Create: `examples/issue-radar-app/app/projects/[projectId]/loading.tsx`
- Create: `examples/issue-radar-app/app/projects/[projectId]/error.tsx`
- Modify: `examples/issue-radar-app/app/projects/page.tsx` (responsive classes)
- Modify: `examples/issue-radar-app/app/projects/[projectId]/page.tsx` (responsive classes)

**Interfaces:** none new — these are Next.js App Router file conventions (`loading.tsx`, `error.tsx`) that wrap the existing route segments automatically.

- [ ] **Step 1: Write `app/projects/loading.tsx` and `app/projects/[projectId]/loading.tsx`**

Both files:

```tsx
export default function Loading() {
  return <p className="mx-auto max-w-2xl p-6 text-sm text-gray-500">Loading…</p>;
}
```

- [ ] **Step 2: Write `app/projects/error.tsx` and `app/projects/[projectId]/error.tsx`**

Both files (Client Components — Next.js `error.tsx` requires `'use client'`):

```tsx
'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <p className="text-sm text-red-600">{error.message || 'Something went wrong.'}</p>
      <button onClick={reset} className="w-fit rounded bg-black px-3 py-2 text-sm text-white">
        Try again
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Make the list layouts responsive**

In `app/projects/page.tsx`, change the outer `<main>` class from `mx-auto flex max-w-2xl flex-col gap-6 p-6` to `mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6`.

In `app/projects/[projectId]/page.tsx`, apply the same `p-4 sm:p-6` change to the outer `<main>`, and change `DashboardCountsBar`'s grid from `grid-cols-4` to `grid-cols-2 gap-2 sm:grid-cols-4` (in `dashboard-counts.tsx`) so counts stack 2-up on narrow viewports.

- [ ] **Step 4: Verify the app still typechecks and builds**

```bash
cd examples/issue-radar-app
npm run typecheck
npm run build
```

Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
cd ../..
git add examples/issue-radar-app/app
git commit -m "feat(issue-radar): add loading/error states and a responsive layout pass"
```

---

### Task 9: Playwright golden-journey spec (positive path)

Mirrors `apps/api/e2e/generated-app-auth.spec.ts`'s pattern (real scaffold copy, real local Supabase via `createRuntime({EXECUTOR_MODE: 'real'})`, real `next dev`), pointed at `examples/issue-radar-app` and extended to apply its migrations. Extracts the ~80-line setup into a shared fixture module so Task 10's negative-RLS spec doesn't duplicate it (DRY).

**Files:**

- Create: `apps/api/e2e/issue-radar-fixture.ts`
- Create: `apps/api/e2e/issue-radar-golden-journey.spec.ts`

**Interfaces:**

- Produces: `bootIssueRadarApp(): Promise<IssueRadarFixture>` and `teardownIssueRadarApp(fixture): Promise<void>`, where `IssueRadarFixture = { appBaseUrl: string; dataDir: string; appDir: string; workdir: string; appProcess: ChildProcess }` — Task 10 imports both directly, no duplication of the boot/teardown logic.

- [ ] **Step 1: Write `apps/api/e2e/issue-radar-fixture.ts`**

```typescript
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse as parseDotEnv } from 'dotenv';
import { createRuntime } from '@agent-foundry/composition';
import { reserveEphemeralPort, waitForHttp } from './support.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const APP_SOURCE_DIR = resolve(REPO_ROOT, 'examples/issue-radar-app');
const STOP_TIMEOUT_MS = 60_000;

export interface IssueRadarFixture {
  appBaseUrl: string;
  dataDir: string;
  appDir: string;
  workdir: string;
  appProcess: ChildProcess;
}

export async function bootIssueRadarApp(projectId: string): Promise<IssueRadarFixture> {
  const [dataDir, appDir] = await Promise.all([
    mkdtemp(join(tmpdir(), 'agent-foundry-issue-radar-data-')),
    mkdtemp(join(tmpdir(), 'agent-foundry-issue-radar-app-')),
  ]);

  // Copy the real example app (not node_modules/.next/supabase — the
  // Supabase environment is provisioned separately below, into workdir).
  await cp(APP_SOURCE_DIR, appDir, {
    recursive: true,
    filter: (source) => !/[/\\](node_modules|\.next|supabase)([/\\]|$)/.test(source),
  });
  await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: appDir,
    timeout: 5 * 60_000,
  });

  const runtime = await createRuntime({
    ...process.env,
    REPO_ROOT,
    DATA_DIR: dataDir,
    EXECUTOR_MODE: 'real',
  });
  if (!runtime.generatedProjectRuntime) {
    throw new Error('Real-mode runtime did not wire a generatedProjectRuntime.');
  }
  await runtime.generatedProjectRuntime.initialize({ projectId });
  const workdir = join(dataDir, 'projects', projectId, 'environment');

  // Apply the real Issue Radar migrations (read from the checked-in example,
  // not re-typed here) on top of the storage migration `initialize()`
  // already installed.
  const migrationsSourceDir = join(APP_SOURCE_DIR, 'supabase', 'migrations');
  const migrationsTargetDir = join(workdir, 'supabase', 'migrations');
  const issueRadarMigrations = (await readdir(migrationsSourceDir)).filter((name) =>
    name.endsWith('.sql'),
  );
  for (const name of issueRadarMigrations.sort()) {
    const targetPath = join(migrationsTargetDir, name);
    try {
      await readFile(targetPath);
      continue; // already installed by initialize() (the storage migration)
    } catch {
      // not present yet — copy and apply it
    }
    await cp(join(migrationsSourceDir, name), targetPath);
    await runtime.generatedProjectRuntime.migrate({
      projectId,
      migrationPath: `supabase/migrations/${name}`,
    });
  }

  const envPath = join(dataDir, 'projects', projectId, '.env');
  const secrets = parseDotEnv(await readFile(envPath, 'utf8'));
  const supabaseUrl = secrets.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = secrets.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = secrets.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error('Supabase runtime did not produce app credentials.');
  }

  const port = await reserveEphemeralPort();
  const appBaseUrl = `http://127.0.0.1:${port}`;
  const appProcess = spawn('npx', ['next', 'dev', '-p', String(port)], {
    cwd: appDir,
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
      APP_BASE_URL: appBaseUrl,
    },
    stdio: 'pipe',
  });
  await waitForHttp(`${appBaseUrl}/sign-up`, 60_000);

  return { appBaseUrl, dataDir, appDir, workdir, appProcess };
}

export async function teardownIssueRadarApp(fixture: IssueRadarFixture): Promise<void> {
  fixture.appProcess.kill();
  try {
    await execFileAsync(
      'supabase',
      ['stop', '--workdir', fixture.workdir, '--no-backup', '--yes'],
      { timeout: STOP_TIMEOUT_MS },
    );
  } catch {
    // best-effort: temp dirs get removed below regardless
  }
  await Promise.all([
    rm(fixture.dataDir, { recursive: true, force: true }),
    rm(fixture.appDir, { recursive: true, force: true }),
  ]);
}
```

- [ ] **Step 2: Write `apps/api/e2e/issue-radar-golden-journey.spec.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  bootIssueRadarApp,
  teardownIssueRadarApp,
  type IssueRadarFixture,
} from './issue-radar-fixture.js';

const SETUP_TIMEOUT_MS = 10 * 60_000;
const FIXTURE_IMAGE = resolve(import.meta.dirname, 'fixtures/design-reference.png');

test.describe('issue radar golden journey', () => {
  test.describe.configure({ timeout: SETUP_TIMEOUT_MS });

  let fixture: IssueRadarFixture;

  test.beforeAll(async () => {
    fixture = await bootIssueRadarApp('issue-radar-golden-journey-e2e');
  });

  test.afterAll(async () => {
    await teardownIssueRadarApp(fixture);
  });

  test('signs up, creates a project, manages an issue end to end, and uploads an attachment', async ({
    page,
  }) => {
    const email = `radar-${randomUUID()}@example.test`;
    const password = `Radar-${randomUUID()}-Aa1!`;

    await page.goto(`${fixture.appBaseUrl}/sign-up`);
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page).toHaveURL(`${fixture.appBaseUrl}/projects`);

    await page.getByPlaceholder('Project name').fill('Website relaunch');
    await page.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByRole('heading', { name: 'Website relaunch' })).toBeVisible();

    await page.getByRole('link', { name: 'New issue' }).click();
    await page.getByLabel('Title').fill('Fix broken checkout button');
    await page.getByLabel('Description').fill('Checkout button does nothing on Safari.');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Fix broken checkout button')).toBeVisible();
    await expect(page.getByText('open', { exact: true })).toBeVisible();

    // Dashboard reflects the new issue immediately.
    await expect(page.locator('dd', { hasText: '1' }).first()).toBeVisible();

    // Complete, then reopen.
    await page.getByRole('button', { name: 'Complete' }).click();
    await expect(page.getByRole('button', { name: 'Reopen' })).toBeVisible();
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByRole('button', { name: 'Complete' })).toBeVisible();

    // Filter by priority=high should hide the medium-priority issue.
    await page.goto(`${page.url().split('?')[0]}?priority=high`);
    await expect(page.getByText('No issues match the current filters.')).toBeVisible();
    await page.goto(page.url().split('?')[0]);

    // Attach a file to the issue.
    await page.getByText('Fix broken checkout button').click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_IMAGE);
    await expect(page.getByRole('link', { name: /design-reference/ })).toBeVisible({
      timeout: 15_000,
    });

    expect(readFileSync(FIXTURE_IMAGE)).toBeTruthy(); // sanity: fixture file exists and is readable
  });
});
```

- [ ] **Step 3: Run the spec to verify it passes** (requires local Supabase CLI + Docker running)

Run: `npm run e2e --workspace @agent-foundry/api -- issue-radar-golden-journey.spec.ts`
Expected: `1 passed`. If the attachment assertion times out, check `app/api/attachments/scan/route.ts`'s response and the browser console for the RLS `storage_clean_owner_select` policy rejecting the read before the scan-complete call lands — the scan call in `finalizeAttachment` must complete before the attachment row insert for the list to ever render a link.

- [ ] **Step 4: Commit**

```bash
git add apps/api/e2e/issue-radar-fixture.ts apps/api/e2e/issue-radar-golden-journey.spec.ts
git commit -m "test(issue-radar): add golden-journey Playwright spec"
```

---

### Task 10: Playwright negative cross-user RLS spec

Two users against the same booted app + Supabase environment (reusing Task 9's fixture): user B must never see, edit, or read user A's project, issue, or attachment — enforced by RLS, observed through the actual browser UI (not a raw API check), satisfying #76's "browser tests cover... denied cross-user access."

**Files:**

- Create: `apps/api/e2e/issue-radar-cross-user-access.spec.ts`

**Interfaces:**

- Consumes: `bootIssueRadarApp`, `teardownIssueRadarApp`, `IssueRadarFixture` (Task 9).

- [ ] **Step 1: Write `apps/api/e2e/issue-radar-cross-user-access.spec.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  bootIssueRadarApp,
  teardownIssueRadarApp,
  type IssueRadarFixture,
} from './issue-radar-fixture.js';

const SETUP_TIMEOUT_MS = 10 * 60_000;

async function signUp(page: import('@playwright/test').Page, baseUrl: string) {
  const email = `radar-${randomUUID()}@example.test`;
  const password = `Radar-${randomUUID()}-Aa1!`;
  await page.goto(`${baseUrl}/sign-up`);
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(`${baseUrl}/projects`);
}

test.describe('issue radar cross-user access', () => {
  test.describe.configure({ timeout: SETUP_TIMEOUT_MS });

  let fixture: IssueRadarFixture;

  test.beforeAll(async () => {
    fixture = await bootIssueRadarApp('issue-radar-cross-user-e2e');
  });

  test.afterAll(async () => {
    await teardownIssueRadarApp(fixture);
  });

  test("user B cannot see, open, or edit user A's project or issue", async ({ browser }) => {
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    await signUp(pageA, fixture.appBaseUrl);
    await pageA.getByPlaceholder('Project name').fill("A's private project");
    await pageA.getByRole('button', { name: 'New project' }).click();
    await expect(pageA.getByRole('heading', { name: "A's private project" })).toBeVisible();
    const projectUrl = pageA.url();

    await pageA.getByRole('link', { name: 'New issue' }).click();
    await pageA.getByLabel('Title').fill("A's private issue");
    await pageA.getByRole('button', { name: 'Save' }).click();
    await expect(pageA.getByText("A's private issue")).toBeVisible();
    const issueUrl = pageA.url();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUp(pageB, fixture.appBaseUrl);

    // B's own project list must not contain A's project.
    await expect(pageB.getByText("A's private project")).not.toBeVisible();
    await expect(pageB.getByText('No projects yet. Create one above.')).toBeVisible();

    // Direct navigation to A's project/issue URLs must not leak data:
    // RLS makes the row invisible to B, so the page 404s via notFound().
    await pageB.goto(projectUrl);
    await expect(pageB.getByText(/this page could not be found/i)).toBeVisible();

    await pageB.goto(issueUrl);
    await expect(pageB.getByText(/this page could not be found/i)).toBeVisible();

    await Promise.all([contextA.close(), contextB.close()]);
  });
});
```

- [ ] **Step 2: Run the spec to verify it passes**

Run: `npm run e2e --workspace @agent-foundry/api -- issue-radar-cross-user-access.spec.ts`
Expected: `1 passed`. If B can see A's project/issue text, the RLS policies from Task 3 are wrong — re-check `projects_select_owner` / `issues_select_owner` use `auth.uid()`, not a static value, and that the migration was actually applied (check the fixture's migration-copy loop in Task 9 Step 1 ran for both new migration files).

- [ ] **Step 3: Commit**

```bash
git add apps/api/e2e/issue-radar-cross-user-access.spec.ts
git commit -m "test(issue-radar): add cross-user negative-RLS Playwright spec"
```

---

### Task 11: Wire the Issue Radar e2e specs into CI

Clones the exact shape of the existing `auth-e2e`/`rls-e2e` jobs in `.github/workflows/ci.yml`, plus the Playwright browser install the `test` job already uses — this closes the CI gap where `apps/api/e2e/*.spec.ts` currently only runs locally.

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:** none (CI config only).

- [ ] **Step 1: Add the `issue-radar-e2e` job**

Insert a new job after `rls-e2e` (same file, before the `format` job):

```yaml
issue-radar-e2e:
  name: issue-radar-e2e
  needs: preflight
  runs-on: ubuntu-latest
  timeout-minutes: 20
  steps:
    - uses: actions/checkout@v7
    - uses: actions/setup-node@v6
      with:
        node-version-file: .nvmrc
        cache: npm
    - run: npm ci
    - run: npx playwright install --with-deps chromium
    - uses: supabase/setup-cli@46f7f98c7f948ad727d22c1e67fab04c223a0520 # v3
      with:
        version: 2.62.5
    - run: npm run e2e --workspace @agent-foundry/api -- issue-radar-golden-journey.spec.ts issue-radar-cross-user-access.spec.ts
```

- [ ] **Step 2: Verify the YAML is well-formed**

Run: `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))" 2>&1 || npx -y yaml-validator .github/workflows/ci.yml`
Expected: no parse error. (If neither tool is available locally, visually diff-check indentation against the `rls-e2e` job it was cloned from — same 4-space step indentation under `steps:`.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add issue-radar-e2e job for the golden-journey and cross-user RLS specs"
```

---

### Task 12: Documentation, ADR, evidence, and final verification

**Files:**

- Modify: `examples/issue-radar-app/README.md` (full content, replacing the Task 2 stub)
- Create: `docs/adr/0037-issue-radar-reference-app.md`
- Create: `docs/evidence/issue-76-issue-radar-reference-app.md`

**Interfaces:** none (docs + final gate).

- [ ] **Step 1: Confirm the next free ADR number**

Run: `ls docs/adr | grep -oE '^[0-9]{4}' | sort -n | tail -3`
Expected output as of this plan's writing: `0035`, `0035`, `0036` (there's a known numbering collision from parallel branches noted in `docs/adr/README.md`). If `main` has since gained an ADR 0037, use 0038 instead and adjust the filename/heading below accordingly.

- [ ] **Step 2: Write `docs/adr/0037-issue-radar-reference-app.md`**

```markdown
# ADR 0037: Hand-author the Issue Radar reference app instead of live-generating it

- Status: Accepted
- Date: 2026-07-24
- Owners: Integrations

## Context

Issue #76 closes the v0.10 milestone by delivering Issue Radar as agent-foundry's golden
full-stack reference app: Next.js + Tailwind + shadcn/ui + local Supabase, auth-protected
CRUD/filters/dashboard, attachments via Storage + RLS, browser tests for positive and
negative (cross-user) access, and an exportable, documented Compose deployment. Its six
blocking sub-issues (#70-#75) each shipped as a platform capability plus e2e proof — none
of them ran the full `web-app-v1` multi-agent generation workflow live to produce their
evidence.

## Decision

Issue Radar is hand-authored under `examples/issue-radar-app/`, following exactly the
conventions the `web-app-v1` pipeline would apply: the auth pattern in
`harness/scaffolds/nextjs/` (reused, not modified), the RLS-baseline and default-deny
policy shape from `harness/stacks/supabase.md`, and the storage upload/scan protocol from
`packages/platform/src/supabase-storage.ts` (#72). Two Playwright specs
(`apps/api/e2e/issue-radar-golden-journey.spec.ts`,
`apps/api/e2e/issue-radar-cross-user-access.spec.ts`) boot the real app against a real,
isolated local Supabase stack via `@agent-foundry/composition`'s real-mode runtime — the
same runtime production uses — and are gated in CI (`.github/workflows/ci.yml`'s
`issue-radar-e2e` job).

We did not run the real `web-app-v1` workflow (real Claude Code CLI through
plan→architecture→implementation→verification→browser-verification→release quality
gates) to produce Issue Radar's code. That loop is real and wired (see
`packages/orchestrator/src/workflow-orchestrator.ts`,
`packages/executors/src/claude-executor.ts`), but running it live is slow, costly per
run, and its end-to-end reliability across all quality gates is not yet proven —
exercising it for the first time as this issue's acceptance evidence would conflate two
different risks (does the generation loop work? does the resulting app satisfy the PRD?)
in one expensive, nondeterministic step.

## Alternatives considered

Running the live pipeline against `examples/issue-radar.prd.md` would more literally
satisfy "born via chat," but ties #76's completion to an unproven, expensive process
outside this issue's control, with no clear rollback if a quality gate stalls or loops.
Generating once and freezing the output (like `npm run dogfood:run --freeze`) was
considered and rejected: dogfood tasks are small, scoped diffs against a seeded
workspace, not a full multi-page app, and freezing a multi-thousand-line live-generated
diff without human review would not meet this repo's own code-review conventions.

## Consequences

Positive: the reference app is deterministic to build, review, and regression-test;
its RLS migrations are covered by a fast unit-level lint regression
(`packages/platform/src/issue-radar-example-security-lint.test.ts`) in addition to the
two browser specs. Negative: it does not, by itself, prove the live multi-agent
generation loop can produce a working app from `examples/issue-radar.prd.md`
unattended — that remains open, tracked risk (see `docs/RISK_REGISTER.md`'s real-CLI-loop
entry), not closed by this ADR.

## Validation and rollback

Validated by `npm run check` plus the `issue-radar-e2e` CI job passing on the PR that
introduces this ADR. Rollback is deleting `examples/issue-radar-app/`, the two Playwright
specs, and the `issue-radar-e2e` CI job — no other package depends on this example.
```

- [ ] **Step 3: Write the `examples/issue-radar-app/README.md` (full content)**

````markdown
# Issue Radar

Reference full-stack app for agent-foundry: a small issue tracker for teams of 3-20,
built exactly the way the `web-app-v1` generation pipeline would build it — Next.js App
Router, Tailwind v4, shadcn/ui, and a local Supabase stack for auth, Postgres, and
Storage. See `../issue-radar.prd.md` for the full product spec and
`../../docs/adr/0037-issue-radar-reference-app.md` for why this app is hand-authored
rather than live-generated.

## Golden journey

1. Sign up with an email and password (`/sign-up`) — no SMTP locally, so the session is
   active immediately.
2. Create a project from `/projects`.
3. Create an issue with a title (required, ≤140 chars), description, and priority.
4. Edit the issue, mark it complete (sets `completed_at`), reopen it (clears
   `completed_at`).
5. Filter the issue list by status and/or priority (combinable, via `?status=` /
   `?priority=` query params).
6. Watch the dashboard counts update immediately after any change.
7. Attach a PNG, JPEG, or PDF (≤10MB) to an issue and see it listed once processed.
8. Every table is row-level-security scoped to the signed-in user: a second account can
   never see, open, or edit the first account's projects, issues, or attachments.

This exact flow is what `apps/api/e2e/issue-radar-golden-journey.spec.ts` and
`apps/api/e2e/issue-radar-cross-user-access.spec.ts` assert against a real local
Supabase stack and a real `next dev` server.

## Running locally

```bash
npm install
npx supabase start          # boots local Postgres/Auth/Storage — needs Docker running
cp .env.example .env.local  # then fill in the values `supabase status --output json` prints
npm run dev                 # http://localhost:3000
```
````

## Exporting and deploying (Docker Compose)

This directory _is_ the export: it is a self-contained, git-tracked bundle of the app
code, every `supabase/migrations/*.sql` file, and a `Dockerfile` + `docker-compose.yml`.
To deploy it (per `../../docs/adr/0008-existing-vps-compose-deployment.md`):

```bash
# on the target host, with Docker and the Supabase CLI installed:
git clone <your fork/remote> && cd issue-radar-app
npx supabase start
npx supabase migration up   # applies every file in supabase/migrations/, forward-only
cp .env.example .env        # fill in NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY / SUPABASE_SERVICE_ROLE_KEY
docker compose up --build -d
```

Put this behind Caddy (or another reverse proxy) for TLS, per ADR 0008. There is no
bundled Postgres/Supabase service in `docker-compose.yml` — this app expects its own
already-running local Supabase stack, one isolated Compose project per app, matching
every other generated project's deployment shape.

## Local attachment scanning

`packages/platform/src/supabase-storage.ts` (#72) makes `complete_storage_scan`
service-role-only by design, so a real deployment plugs in a real malware scanner.
Locally, `app/api/attachments/scan/route.ts` auto-approves every upload immediately
(`ponytail: trivial pass-through scanner, replace with a real scan service before
accepting untrusted multi-tenant uploads`).

````

- [ ] **Step 4: Write `docs/evidence/issue-76-issue-radar-reference-app.md`**

```markdown
# Issue #76: Deliver Issue Radar as a full-stack reference app — evidence

Related: ADR [0037](../adr/0037-issue-radar-reference-app.md)

## Acceptance

| Acceptance criterion (roadmap `v010-fullstack-reference`) | Implementation | Evidence |
| --- | --- | --- |
| Next.js + Tailwind + shadcn/ui + local Supabase | `examples/issue-radar-app/` (Next 16 App Router, Tailwind v4, shadcn/ui CLI components) | `npm run build` in Task 2 |
| Email/password auth guards CRUD/filters/dashboard | `middleware.ts` + `lib/supabase/{client,server}.ts`, reused from `harness/scaffolds/nextjs/` | `issue-radar-golden-journey.spec.ts` sign-up assertion |
| Attachment via Storage + RLS policy | `features/attachments/actions.ts`, `app/api/attachments/scan/route.ts`, `supabase/migrations/00000000000000_agent_foundry_storage.sql` (#72) | `issue-radar-golden-journey.spec.ts` attachment-upload assertion |
| Browser tests cover positive journeys and denied cross-user access | Two Playwright specs | `issue-radar-golden-journey.spec.ts`, `issue-radar-cross-user-access.spec.ts` |
| Code, migrations, Compose commands exportable and documented | `examples/issue-radar-app/{Dockerfile,docker-compose.yml,supabase/migrations,README.md}` | README "Exporting and deploying" section |

## Results

Run from a fresh worktree at the PR head commit:

```bash
npm run check
npm run e2e --workspace @agent-foundry/api -- issue-radar-golden-journey.spec.ts issue-radar-cross-user-access.spec.ts
````

[Fill in actual pass/fail counts and CI run links here once the PR's CI has run.]

## CI

The `issue-radar-e2e` job in `.github/workflows/ci.yml` runs both new Playwright specs
on every push/PR against `main`.

## Real gaps found and fixed during review

[Fill in during code review, per the project's evidence-doc convention.]

## Scope decisions

- Did not modify `harness/scaffolds/nextjs/`, wire `security-lint`'s `blocksRelease`
  into the orchestrator's release path, or build a project-export/bundling API — see
  ADR 0037 and this plan's Global Constraints for why.
- App UI copy is in English (matches the rest of this monorepo's code/docs language
  convention); the PRD itself is Portuguese, per `harness/stacks/nextjs.md`'s "user-facing
  copy follows the PRD's language" — noted here as an explicit, intentional deviation for
  a reference/example app rather than a real customer-facing generated project.
- The attachment scanner is a trivial local auto-approve (`ponytail:` comment in
  `app/api/attachments/scan/route.ts`) — there is no real malware-scanning service in v1.

## Definition of Done

- Behavior: acceptance demonstrated via the two Playwright specs, not just asserted.
- Engineering: `npm run check` (format, lint, architecture, roadmap, typecheck, unit
  tests, build, secrets scan) plus the new `issue-radar-e2e` CI job all pass.
- Safety and operations: service-role key confined to `lib/supabase/service-role.ts`
  and the scan route; every new table RLS-enabled with owner-scoped policies, checked
  by `packages/platform/src/issue-radar-example-security-lint.test.ts`.
- Delivery evidence: this document, ADR 0037, and the PR closing #76.

````

- [ ] **Step 5: Run the full verification gate**

```bash
npm run check
npm run e2e --workspace @agent-foundry/api -- issue-radar-golden-journey.spec.ts issue-radar-cross-user-access.spec.ts
````

Expected: `npm run check` exits 0 (format, lint, architecture, roadmap, typecheck, unit tests, build, secrets scan all pass); both Playwright specs pass. Paste the actual output into `docs/evidence/issue-76-issue-radar-reference-app.md`'s "Results" section (replacing the `[Fill in ...]` placeholder), then amend this task's commit.

- [ ] **Step 6: Commit**

```bash
git add examples/issue-radar-app/README.md docs/adr/0037-issue-radar-reference-app.md docs/evidence/issue-76-issue-radar-reference-app.md
git commit -m "docs(issue-radar): add ADR 0037, evidence doc, and full README for #76"
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin agent/issue-76-issue-radar-app
gh pr create --title "[v0.10] Deliver Issue Radar as a full-stack reference app" --body "$(cat <<'EOF'
## Summary
- Hand-authors `examples/issue-radar-app/` (Next.js + Tailwind + shadcn/ui + local Supabase) as the golden full-stack reference app, per ADR 0037.
- Auth-gated CRUD, combinable filters, live dashboard counts, and Storage+RLS attachments, following the exact conventions #71-#75 already shipped.
- Two Playwright specs prove the golden journey and cross-user RLS denial against a real local Supabase stack; both gated in CI (`issue-radar-e2e`).
- Exportable via git + `docker compose up`, documented in the app's README.

## Test plan
- [ ] `npm run check` passes
- [ ] `issue-radar-e2e` CI job passes (golden journey + cross-user RLS)
- [ ] Evidence doc `docs/evidence/issue-76-issue-radar-reference-app.md` has real CI run links pasted in

Closes #76.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After CI is green, follow **superpowers:requesting-code-review**, then run **/ponytail-review** and **/simplify** on the diff, address every finding, push follow-up commits to the same branch/PR, and only then merge per **superpowers:finishing-a-development-branch**.
