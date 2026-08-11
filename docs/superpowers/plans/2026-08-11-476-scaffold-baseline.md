# Plan: [HA-A.2] Generated-app scaffold baseline (issue #476)

Repo: eedsilva/agent-foundry. Branch: `feat/476-scaffold-baseline`. Worktree:
`.claude/worktrees/476-scaffold-baseline`. Parent epic: #469. Governing ADR: 0059
(defers per-shape templates — this plan ships exactly one shape-agnostic baseline).

## Global Constraints

- **Touchpoints allowed**: `harness/scaffolds/nextjs/apps/web/**` (new/edited files)
  plus new test files under `packages/harness/src/`. Do NOT touch `apps/api`,
  `supabase/`, `scripts/`, or any auth/RLS file under `harness/scaffolds/nextjs`.
- **ADR 0059**: no per-shape scaffold variants. Exactly one shape-agnostic baseline
  every generated app inherits regardless of app shape.
- **No component zoo**: only the components explicitly named in these tasks.
- **Golden stack, no version drift**: Next.js 16.2.11, React 19.1.1, TypeScript
  5.9.2, Tailwind v4 CSS-first (`@import 'tailwindcss'` style — NOT
  `tailwind.config.js` theme extension). Match
  `harness/scaffolds/nextjs/apps/web/package.json`'s existing pins exactly; do not
  bump any existing pinned version.
- **`git diff --check` cleanliness**: every file touched must end with exactly one
  trailing newline, contain no trailing whitespace on any line, and no blank line
  immediately before EOF. Verify with `git diff --check` after staging, before
  committing — a past regression looped every mock run into repair over exactly
  this.
- **No `@radix-ui`/`shadcn` npm runtime dependency**: shadcn ships as vendored
  source, not an installed package. Write component files by hand in the shadcn
  visual/API style — do not attempt `npx shadcn` (no network access assumed).
- **Testing convention**: content assertions (`readFile` + `toContain`/
  `toMatchObject`), matching `packages/harness/src/scaffold-tooling.test.ts`'s
  style. No snapshot testing.
- **Zero prompt-side instructions**: nothing in these tasks may add PRD-prompt
  text, planner instructions, or CLI flags to make the shell/nav/theme/states
  appear. Inheritance must be automatic via scaffold application alone
  (`ProjectService.create` → `VersionedHarnessRepository.scaffoldFiles('nextjs')`
  → `FileWorkspaceManager.applyScaffold`).
- **Typecheck new TS test files**: run `npx tsc -b packages/harness` after any new
  test file — `exactOptionalPropertyTypes` issues slip past vitest-only checks.
- **Scaffold's own lint/format are separate**: `harness/scaffolds/nextjs/**` has
  its own `eslint.config.mjs`/`prettier.config.mjs`, ignored by the root configs.
  From inside that directory, run `pnpm lint && pnpm format:check` (pnpm, not
  npm) on any file touched there.
- **Root repo checks**: `npx prettier --check --no-cache <new/edited test files>`
  and `npx eslint <new/edited .ts test files>` for anything under `packages/`.

## Task 1: shadcn/ui foundation — tokens and utils

Create these files exactly:

`harness/scaffolds/nextjs/apps/web/components.json`:
```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "app/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

`harness/scaffolds/nextjs/apps/web/lib/utils.ts`:
```ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Add to `harness/scaffolds/nextjs/apps/web/package.json`'s `dependencies`:
`"clsx": "^2.1.1"` and `"tailwind-merge": "^3.3.1"`.

Replace `harness/scaffolds/nextjs/apps/web/app/globals.css` (currently just
`@import 'tailwindcss';`) with:
```css
@import 'tailwindcss';

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-border: var(--border);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --radius-md: var(--radius);
}

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --border: oklch(0.922 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --radius: 0.5rem;
}
```
Keep this token set minimal — background/foreground/border/muted/radius only,
enough for the shell/nav/state components in Tasks 2-3. Do not add a fuller
shadcn palette nothing here uses.

**Test** — new file `packages/harness/src/scaffold-shadcn-foundation.test.ts`:
- `components.json` parses as JSON; `tailwind.cssVariables === true`;
  `aliases.ui === '@/components/ui'`.
- `globals.css` contains `--background`, `--foreground`, and `@theme inline`.
- `lib/utils.ts` contains `export function cn`.
- `apps/web/package.json`'s parsed `dependencies` include `clsx` and
  `tailwind-merge`.

## Task 2: UI primitives and shell/nav

Create these files exactly:

`harness/scaffolds/nextjs/apps/web/components/ui/button.tsx`:
```tsx
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-md border border-border bg-foreground px-4 py-2 text-sm font-medium text-background transition-colors hover:opacity-90 disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}
```

`harness/scaffolds/nextjs/apps/web/components/ui/skeleton.tsx`:
```tsx
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} {...props} />;
}
```

`harness/scaffolds/nextjs/apps/web/components/nav.tsx`:
```tsx
import Link from 'next/link';

export interface NavLink {
  href: string;
  label: string;
}

export function Nav({ links = [] }: { links?: NavLink[] }) {
  return (
    <nav className="flex items-center gap-4 border-b border-border px-6 py-4">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-sm font-medium text-foreground hover:opacity-70"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
```

`harness/scaffolds/nextjs/apps/web/components/shell.tsx`:
```tsx
import type { ReactNode } from 'react';
import { Nav, type NavLink } from './nav';

export function Shell({ children, navLinks }: { children: ReactNode; navLinks?: NavLink[] }) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Nav links={navLinks} />
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
```

Edit `harness/scaffolds/nextjs/apps/web/app/layout.tsx` to:
```tsx
import type { ReactNode } from 'react';
import { Shell } from '../components/shell';
import './globals.css';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
```

**Test** — new file `packages/harness/src/scaffold-shell-nav.test.ts`:
- `components/ui/button.tsx` contains `export function Button`.
- `components/ui/skeleton.tsx` contains `export function Skeleton`.
- `components/nav.tsx` contains `export function Nav`.
- `components/shell.tsx` contains `export function Shell` and imports `Nav`.
- `app/layout.tsx` imports and renders `Shell` (contains `<Shell>` and
  `from '../components/shell'`).

## Task 3: Empty/loading/error state components

Create these three files (minimal props: `title`, `hint`, optional `action` for
empty; `LoadingState` renders 3 `Skeleton` lines; `ErrorState` takes `title` and
optional `message`). Use `cn()`/theme tokens from Tasks 1-2, no new dependencies.

`harness/scaffolds/nextjs/apps/web/components/empty-state.tsx`:
```tsx
import type { ReactNode } from 'react';

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-md border border-border px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      {action}
    </div>
  );
}
```

`harness/scaffolds/nextjs/apps/web/components/loading-state.tsx`:
```tsx
import { Skeleton } from './ui/skeleton';

export function LoadingState() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
```

`harness/scaffolds/nextjs/apps/web/components/error-state.tsx`:
```tsx
export function ErrorState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="rounded-md border border-border px-6 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
    </div>
  );
}
```

Edit `harness/scaffolds/nextjs/apps/web/app/page.tsx`: replace its existing
inline `items.length === 0 ? <p className="text-sm text-gray-600">No items
yet.</p> : ...` ternary's empty branch with
`<EmptyState title="No items yet" hint="Items you create will show up here." />`,
importing `EmptyState` from `../components/empty-state`. Do not change the
non-empty branch or any other page.tsx behavior.

**Test** — new file `packages/harness/src/scaffold-states.test.ts`:
- `components/empty-state.tsx`, `components/loading-state.tsx`,
  `components/error-state.tsx` exist and export `EmptyState`/`LoadingState`/
  `ErrorState` respectively.
- `app/page.tsx` imports `EmptyState` from `../components/empty-state` and no
  longer contains the literal old inline string `text-sm text-gray-600`.

## Task 4: `git diff --check` regression test

New file: `packages/harness/src/scaffold-git-diff-check.test.ts`.

Copy the entire `harness/scaffolds/nextjs` tree into a fresh temp directory
(mirror `packages/harness/src/scaffold-db-script.test.ts`'s copy pattern —
read it first for the exact copy helper it uses). In that temp directory:
`git init`, `git add -A`, commit with a fixed author (matching this repo's
other scaffold tests' git identity convention), then run:

```
git diff --check 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD
```

(`4b825dc642cb6eb9a060e54bf8d69288fbee4904` is the git empty-tree sentinel,
already used for exactly this purpose in
`packages/executors/src/verifier.ts` — read that file's `EMPTY_GIT_TREE`
constant and its two `git diff --check` invocations for the precedent to
mirror.) Assert the command exits 0 with empty stdout. This is the first
automated coverage of the "scaffold passes `git diff --check`" acceptance
criterion — there is none today.

## Task 5: Scaffold-inheritance integration test

New file: `packages/harness/src/scaffold-inheritance.test.ts`.

Build a real `VersionedHarnessRepository` (from
`packages/harness/src/versioned-harness.ts`) pointed at this repo's real
`harness/` directory, call `.scaffoldFiles('nextjs')`, and apply the result to
a real temp workspace via a real `FileWorkspaceManager.applyScaffold` (from
`packages/persistence`) — no PRD/prompt/CLI involved anywhere in this test,
proving inheritance needs zero prompt-side instructions. Assert on the
resulting files on disk:
- `apps/web/app/layout.tsx` contains `Shell`.
- `apps/web/components/shell.tsx` exists and contains `Nav`.
- `apps/web/components/empty-state.tsx` exists.
- `apps/web/app/globals.css` contains `--background`.

Read `packages/orchestrator/src/project-service.test.ts`'s
`describe('ProjectService.create scaffold application', ...)` block first for
the closest existing precedent (it fakes `scaffoldFiles`/`workspaces`; this
new test uses the real implementations of both instead — that's the point of
this task).
