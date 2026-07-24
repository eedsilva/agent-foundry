# UI Redesign — Light Liquid Glass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dark, unstructured `apps/web` UI with a light Apple-glass design system and a three-pane project workspace, so every piece of system state has one canonical, reachable home.

**Architecture:** Tailwind CSS v4 (CSS-first `@theme` tokens) plus shadcn/ui primitives are added alongside the existing `apps/web/app/globals.css`. Each surface migrates in its own task and deletes the CSS it made dead; `globals.css` is removed in the final task. The 1868-line `apps/web/app/project/[id]/page.tsx` is split into focused files in one task (behavior-identical) and restyled in the next.

**Tech Stack:** Next 16.2 (App Router), React 19, TypeScript (strict, `exactOptionalPropertyTypes`), Tailwind CSS v4, shadcn/ui + Radix, Vitest (node environment, `renderToStaticMarkup` + string assertions), Playwright for e2e.

**Spec:** `DESIGN.md` at the repository root. Read it before starting any task. Token values, glass rules, and the panel relocation table are normative.

## Global Constraints

- **UI copy stays pt-BR.** No i18n layer. Accessible names asserted by `apps/api/e2e/golden-flow.spec.ts` (`Aprovações`, `Enviar`, `Aprovar`, `Iniciar preview`, `Decidido por`, `Confirmar approve`, `Editar proposta`, `Salvar proposta`, `Confirm plan`, `Confirm build`, `Tablet`, `Mobile`, `Console, rede e testes`, `Fixar/Desafixar design-reference.png`, `Substituir design-reference.png`, `Adicionar knowledge file`) must not change.
- **Light only.** No dark theme, no `prefers-color-scheme` dark branch, no `.dark` class variants. Delete shadcn's dark block whenever the CLI writes one.
- **Glass on chrome only.** `backdrop-filter` is allowed on top bar, tab strip, sheets, dialogs, popovers, dropdowns, toasts, floating run controls, alert strip. Never on content cards, tables, diff panes, log viewers, chat bubbles, or form fields.
- **Nothing is removed.** Every panel that exists today keeps a home per the `DESIGN.md` relocation table. Deleting a feature is a task failure.
- **Test hooks.** Every element `golden-flow.spec.ts` targets by CSS class gets a `data-testid`, and the spec migrates to `getByTestId` in the same task that restyles that surface.
- **Preserve landmarks.** `role="region"` with `aria-label` for `Chat`, `Preview`, and `Changes` must keep working; the e2e suite scopes queries to them.
- **Verification per task, all four commands, all must pass:**
  - `npm run typecheck --workspace @agent-foundry/web` (note: `apps/web` is **not** in the root `tsconfig.json` references, so root `npm run typecheck` does **not** cover it — run the workspace script explicitly)
  - `npm run test:unit`
  - `npm run lint`
  - `npm run format:check` (run `npm run format` first if it fails)
- **Node >= 22.** Install with `npm install --workspace @agent-foundry/web`.
- **Do not touch** `apps/api`, `apps/worker`, or `packages/*` except `apps/api/e2e/*.spec.ts`, which is the e2e suite for the web UI.

---

## File Structure

**Created:**

| Path                                                                                           | Responsibility                                                |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `apps/web/postcss.config.mjs`                                                                  | Wires `@tailwindcss/postcss`                                  |
| `apps/web/app/theme.css`                                                                       | `@import 'tailwindcss'` + `@theme` design tokens + base layer |
| `apps/web/components.json`                                                                     | shadcn CLI config                                             |
| `apps/web/lib/utils.ts`                                                                        | `cn()` class merger                                           |
| `apps/web/components/ui/*.tsx`                                                                 | shadcn primitives (CLI-generated)                             |
| `apps/web/components/glass-bar.tsx`                                                            | Glass chrome surface                                          |
| `apps/web/components/status-pill.tsx`                                                          | Status string → tone + label, single source of status color   |
| `apps/web/components/empty-state.tsx`                                                          | Empty state block                                             |
| `apps/web/components/stat-tile.tsx`                                                            | KPI tile                                                      |
| `apps/web/components/timeline.tsx`                                                             | Event list with dot rail                                      |
| `apps/web/components/diff-pane.tsx`                                                            | Unified diff renderer                                         |
| `apps/web/components/top-bar.tsx`                                                              | App shell header + nav                                        |
| `apps/web/components/runtime-pill.tsx`                                                         | Executor mode / model count pill + popover                    |
| `apps/web/app/project/[id]/builder-shell.tsx`                                                  | Three-pane layout, responsive collapse                        |
| `apps/web/app/project/[id]/builder-header.tsx`                                                 | Project glass header + run controls                           |
| `apps/web/app/project/[id]/run-alert-strip.tsx`                                                | Paused / error / resume-blocked notices                       |
| `apps/web/app/project/[id]/chat-pane.tsx`                                                      | Conversation, operations, agent stream, composer              |
| `apps/web/app/project/[id]/center-pane.tsx`                                                    | Preview / Diff / Artefato view switcher                       |
| `apps/web/app/project/[id]/inspector/index.tsx`                                                | Tab strip, URL sync, badges                                   |
| `apps/web/app/project/[id]/inspector/{activity,run,changes,artifacts,router,versions}-tab.tsx` | One inspector tab each                                        |
| `apps/web/app/project/[id]/dialogs/{retry-plan,decide,artifact-viewer}-dialog.tsx`             | Modal flows lifted out of `page.tsx`                          |

**Modified:** `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/router/dashboard-view.tsx`, `apps/web/app/project/[id]/page.tsx`, `apps/web/app/project/[id]/{preview-panel,knowledge-files,version-history,changes-panel}.tsx`, `apps/api/e2e/golden-flow.spec.ts`.

**Deleted (Task 7):** `apps/web/app/globals.css`, `apps/web/app/project/[id]/builder-shell-css.test.ts`.

---

### Task 1: Tailwind v4 + shadcn foundation

Adds the styling stack and the design tokens. No visual change to any page yet — `globals.css` still owns every rendered pixel at the end of this task.

**Files:**

- Modify: `apps/web/package.json`
- Modify: `apps/web/tsconfig.json`
- Create: `apps/web/postcss.config.mjs`
- Create: `apps/web/app/theme.css`
- Create: `apps/web/lib/utils.ts`
- Create: `apps/web/components.json`
- Modify: `apps/web/app/layout.tsx`
- Test: `apps/web/app/theme-tokens.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - CSS custom properties on `:root`, all consumed by later tasks: `--color-bg`, `--color-ink`, `--color-ink-muted`, `--color-ink-subtle`, `--color-surface`, `--color-surface-sunken`, `--color-hairline`, `--color-accent`, `--color-accent-strong`, `--color-accent-wash`, `--color-ok`, `--color-warn`, `--color-err`, `--color-info`, `--glass`, `--glass-stroke`, `--glass-blur`.
  - Tailwind utility names derived from those tokens: `bg-bg`, `text-ink`, `text-ink-muted`, `text-ink-subtle`, `bg-surface`, `bg-surface-sunken`, `border-hairline`, `text-accent`, `bg-accent`, `bg-accent-wash`, `text-ok`, `text-warn`, `text-err`, `text-info`.
  - `cn(...inputs: ClassValue[]): string` exported from `apps/web/lib/utils.ts`.
  - Path alias `@/*` resolving to `apps/web/*`.

- [ ] **Step 1: Write the failing token test**

The repo already tests CSS by reading the file (`builder-shell-css.test.ts`); follow that pattern.

Create `apps/web/app/theme-tokens.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(process.cwd(), 'apps/web/app/theme.css'), 'utf8');

const TOKENS: Record<string, string> = {
  '--color-bg': '#f4f6f8',
  '--color-ink': '#10151a',
  '--color-ink-muted': '#5c6b7a',
  '--color-ink-subtle': '#8a97a3',
  '--color-surface': '#ffffff',
  '--color-surface-sunken': '#eef1f4',
  '--color-accent': '#0fa3a3',
  '--color-accent-strong': '#0c8080',
  '--color-ok': '#1fa971',
  '--color-warn': '#e8a33d',
  '--color-err': '#e5484d',
  '--color-info': '#3e7bfa',
};

describe('theme.css', () => {
  it('imports tailwind', () => {
    expect(css).toMatch(/@import\s+['"]tailwindcss['"]/);
  });

  it('declares every design token from DESIGN.md with the specified value', () => {
    for (const [token, value] of Object.entries(TOKENS)) {
      expect(css.toLowerCase()).toContain(`${token}: ${value}`);
    }
  });

  it('declares the glass recipe', () => {
    expect(css).toMatch(/--glass-blur:\s*24px/);
    expect(css).toMatch(/--glass:\s*rgba\(255,\s*255,\s*255,\s*0?\.6\)/);
  });

  it('has no dark theme branch', () => {
    expect(css).not.toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).not.toMatch(/\.dark\s*\{/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit -- apps/web/app/theme-tokens.test.ts
```

Expected: FAIL — `ENOENT: no such file or directory ... apps/web/app/theme.css`.

- [ ] **Step 3: Install the styling dependencies**

```bash
npm install --workspace @agent-foundry/web \
  tailwindcss@^4 @tailwindcss/postcss@^4 \
  class-variance-authority clsx tailwind-merge lucide-react
```

`tailwindcss` and `@tailwindcss/postcss` may be installed as regular dependencies; Next reads PostCSS config at build time in the workspace, and the repo has no dev/prod split for `apps/web` builds.

- [ ] **Step 4: Create the PostCSS config**

Create `apps/web/postcss.config.mjs`:

```js
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

- [ ] **Step 5: Create `theme.css`**

Create `apps/web/app/theme.css`:

```css
@import 'tailwindcss';

@theme {
  --color-bg: #f4f6f8;
  --color-ink: #10151a;
  --color-ink-muted: #5c6b7a;
  --color-ink-subtle: #8a97a3;
  --color-surface: #ffffff;
  --color-surface-sunken: #eef1f4;
  --color-hairline: rgba(16, 21, 26, 0.08);
  --color-accent: #0fa3a3;
  --color-accent-strong: #0c8080;
  --color-accent-wash: rgba(15, 163, 163, 0.08);
  --color-ok: #1fa971;
  --color-warn: #e8a33d;
  --color-err: #e5484d;
  --color-info: #3e7bfa;

  --radius-control: 8px;
  --radius-card: 12px;
  --radius-panel: 16px;
  --radius-sheet: 20px;

  --shadow-card: 0 1px 2px rgba(16, 21, 26, 0.06);
  --shadow-pop: 0 8px 24px rgba(16, 21, 26, 0.08);
  --shadow-modal: 0 24px 64px rgba(16, 21, 26, 0.16);

  --font-sans:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;

  --ease-glass: cubic-bezier(0.32, 0.72, 0, 1);
}

:root {
  --glass: rgba(255, 255, 255, 0.6);
  --glass-stroke: rgba(255, 255, 255, 0.72);
  --glass-blur: 24px;
}

@layer base {
  html {
    color: var(--color-ink);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }

  body {
    margin: 0;
    min-height: 100vh;
    background:
      radial-gradient(60rem 40rem at 12% -10%, rgba(15, 163, 163, 0.14), transparent 60%),
      radial-gradient(50rem 36rem at 92% 8%, rgba(62, 123, 250, 0.1), transparent 62%),
      radial-gradient(44rem 30rem at 50% 108%, rgba(15, 163, 163, 0.08), transparent 60%),
      var(--color-bg);
    background-attachment: fixed;
  }

  :focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: 2px;
  }
}

@utility glass {
  background: var(--glass);
  backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  border: 1px solid var(--glass-stroke);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.6) inset,
    0 8px 32px rgba(16, 21, 26, 0.06);
}
```

The `glass` utility is the only place `backdrop-filter` is written. Later tasks apply `className="glass"` and never re-declare it.

- [ ] **Step 6: Add the `@/*` path alias**

Modify `apps/web/tsconfig.json` — add `baseUrl` and `paths` to `compilerOptions`, keeping everything else. `tsconfig.base.json` already sets `paths`, so this override must re-declare the `@agent-foundry/*` entries or they are lost:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "allowJs": false,
    "incremental": true,
    "jsx": "preserve",
    "plugins": [{ "name": "next" }],
    "noEmit": true,
    "isolatedModules": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./*"],
      "@agent-foundry/contracts": ["../../packages/contracts/src/index.ts"],
      "@agent-foundry/domain": ["../../packages/domain/src/index.ts"],
      "@agent-foundry/persistence": ["../../packages/persistence/src/index.ts"],
      "@agent-foundry/harness": ["../../packages/harness/src/index.ts"],
      "@agent-foundry/model-router": ["../../packages/model-router/src/index.ts"],
      "@agent-foundry/executors": ["../../packages/executors/src/index.ts"],
      "@agent-foundry/platform": ["../../packages/platform/src/index.ts"],
      "@agent-foundry/orchestrator": ["../../packages/orchestrator/src/index.ts"],
      "@agent-foundry/composition": ["../../packages/composition/src/index.ts"]
    }
  },
  "include": ["next-env.d.ts", ".next/types/**/*.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

Also add the alias to `vitest.config.ts` at the repo root so `@/` imports resolve in unit tests. Add one entry inside the existing `resolve.alias` object, keeping the nine `@agent-foundry/*` entries untouched:

```ts
      '@': `${root}apps/web`,
```

- [ ] **Step 7: Create `cn()`**

Create `apps/web/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 8: Create the shadcn config**

Create `apps/web/components.json` by hand rather than running `npx shadcn init`, so the CLI does not rewrite `theme.css` with its own oklch dark-mode palette:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "app/theme.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/hooks"
  },
  "iconLibrary": "lucide"
}
```

- [ ] **Step 9: Import the theme in the layout**

Modify `apps/web/app/layout.tsx` — add the `theme.css` import **above** the existing `globals.css` import so `globals.css` still wins during the migration:

```tsx
import './theme.css';
import './globals.css';
```

Change nothing else in this file yet.

- [ ] **Step 10: Run the test to verify it passes**

```bash
npm run test:unit -- apps/web/app/theme-tokens.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 11: Verify the build and the full check surface**

```bash
npm run build --workspace @agent-foundry/web
npm run typecheck --workspace @agent-foundry/web
npm run test:unit
npm run lint
npm run format
npm run format:check
```

Expected: all pass. The rendered pages look unchanged — `globals.css` is still last.

- [ ] **Step 12: Commit**

```bash
git add apps/web/package.json apps/web/tsconfig.json apps/web/postcss.config.mjs \
  apps/web/app/theme.css apps/web/app/theme-tokens.test.ts apps/web/lib/utils.ts \
  apps/web/components.json apps/web/app/layout.tsx vitest.config.ts package-lock.json
git commit -m "feat(web): add tailwind v4 and design tokens"
```

---

### Task 2: Primitives and app shell

Builds the six custom primitives and the glass top bar. This is the first visible change: new chrome on all three routes, old page bodies underneath.

**Files:**

- Create: `apps/web/components/glass-bar.tsx`
- Create: `apps/web/components/status-pill.tsx`
- Create: `apps/web/components/empty-state.tsx`
- Create: `apps/web/components/runtime-pill.tsx`
- Create: `apps/web/components/top-bar.tsx`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/globals.css` (delete `.topbar`, `.brand`, `.brandMark`, `.localBadge`, `.noise` blocks)
- Test: `apps/web/components/status-pill.test.tsx`
- Test: `apps/web/components/top-bar.test.tsx`

**Interfaces:**

- Consumes: tokens and `glass` utility from Task 1; `cn` from `@/lib/utils`.
- Produces:
  - `statusTone(status: string): 'ok' | 'warn' | 'err' | 'info' | 'neutral'`
  - `StatusPill({ status, label }: { status: string; label?: string })`
  - `GlassBar({ as, className, children }: { as?: 'header' | 'div' | 'nav'; className?: string; children: ReactNode })`
  - `EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode })`
  - `RuntimePill({ runtime }: { runtime: RuntimeInfoResponse | null })`
  - `TopBar({ activePath }: { activePath: string })`

- [ ] **Step 1: Write the failing primitives test**

Create `apps/web/components/status-pill.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusPill, statusTone } from './status-pill';

describe('statusTone', () => {
  it('maps every contract status to a tone', () => {
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('succeeded')).toBe('ok');
    expect(statusTone('running')).toBe('info');
    expect(statusTone('paused')).toBe('warn');
    expect(statusTone('pause_requested')).toBe('warn');
    expect(statusTone('awaiting_approval')).toBe('warn');
    expect(statusTone('failed')).toBe('err');
    expect(statusTone('rejected')).toBe('err');
    expect(statusTone('queued')).toBe('neutral');
    expect(statusTone('pending')).toBe('neutral');
    expect(statusTone('cancelled')).toBe('neutral');
    expect(statusTone('cancel_requested')).toBe('neutral');
    expect(statusTone('skipped')).toBe('neutral');
  });

  it('falls back to neutral for unknown statuses', () => {
    expect(statusTone('something-new')).toBe('neutral');
  });
});

describe('StatusPill', () => {
  it('renders the raw status as its own label and keeps it machine-readable', () => {
    const markup = renderToStaticMarkup(<StatusPill status="awaiting_approval" />);
    expect(markup).toContain('awaiting_approval');
    expect(markup).toContain('data-status="awaiting_approval"');
    expect(markup).toContain('data-tone="warn"');
  });

  it('renders an explicit label when given one', () => {
    const markup = renderToStaticMarkup(<StatusPill status="completed" label="concluído" />);
    expect(markup).toContain('concluído');
  });
});
```

Create `apps/web/components/top-bar.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TopBar } from './top-bar';

describe('TopBar', () => {
  it('links to both surfaces and marks the active one', () => {
    const markup = renderToStaticMarkup(<TopBar activePath="/router" />);
    expect(markup).toContain('href="/"');
    expect(markup).toContain('href="/router"');
    expect(markup).toContain('Projetos');
    expect(markup).toContain('Router');
    expect(markup).toContain('aria-current="page"');
  });

  it('is a glass surface, not a solid card', () => {
    const markup = renderToStaticMarkup(<TopBar activePath="/" />);
    expect(markup).toMatch(/class="[^"]*\bglass\b/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:unit -- apps/web/components
```

Expected: FAIL — cannot resolve `./status-pill` and `./top-bar`.

- [ ] **Step 3: Implement `StatusPill`**

Create `apps/web/components/status-pill.tsx`:

```tsx
import { cn } from '@/lib/utils';

export type StatusTone = 'ok' | 'warn' | 'err' | 'info' | 'neutral';

const TONES: Record<string, StatusTone> = {
  completed: 'ok',
  succeeded: 'ok',
  approved: 'ok',
  running: 'info',
  paused: 'warn',
  pause_requested: 'warn',
  awaiting_approval: 'warn',
  pending_approval: 'warn',
  failed: 'err',
  rejected: 'err',
  queued: 'neutral',
  pending: 'neutral',
  cancelled: 'neutral',
  cancel_requested: 'neutral',
  skipped: 'neutral',
};

export function statusTone(status: string): StatusTone {
  return TONES[status] ?? 'neutral';
}

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'text-ok bg-ok/10',
  warn: 'text-warn bg-warn/10',
  err: 'text-err bg-err/10',
  info: 'text-info bg-info/10',
  neutral: 'text-ink-muted bg-ink/[0.06]',
};

export function StatusPill({
  status,
  label,
  className,
}: {
  status: string;
  label?: string;
  className?: string;
}) {
  const tone = statusTone(status);
  return (
    <span
      data-status={status}
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[12px] font-semibold',
        TONE_CLASS[tone],
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {label ?? status}
    </span>
  );
}
```

- [ ] **Step 4: Implement `GlassBar` and `EmptyState`**

Create `apps/web/components/glass-bar.tsx`:

```tsx
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function GlassBar({
  as: Tag = 'div',
  className,
  children,
}: {
  as?: 'header' | 'div' | 'nav' | 'section';
  className?: string;
  children: ReactNode;
}) {
  return <Tag className={cn('glass rounded-panel', className)}>{children}</Tag>;
}
```

Create `apps/web/components/empty-state.tsx`:

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
    <div className="bg-surface-sunken rounded-card flex flex-col items-center gap-2 px-6 py-10 text-center">
      <p className="text-ink text-[14px] font-medium">{title}</p>
      {hint ? <p className="text-ink-subtle max-w-[42ch] text-[13px]">{hint}</p> : null}
      {action}
    </div>
  );
}
```

- [ ] **Step 5: Implement `RuntimePill` and `TopBar`**

Create `apps/web/components/runtime-pill.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import type { RuntimeInfoResponse } from '@agent-foundry/contracts';
import { getRuntime } from '@/lib/api';
import { cn } from '@/lib/utils';

export function RuntimePill() {
  const [runtime, setRuntime] = useState<RuntimeInfoResponse | null>(null);

  useEffect(() => {
    void getRuntime()
      .then(setRuntime)
      .catch(() => setRuntime(null));
  }, []);

  const live = runtime?.executorMode === 'real';

  return (
    <span
      data-testid="runtime-pill"
      title={runtime ? `${runtime.executors.length} executores` : 'conectando'}
      className="border-hairline text-ink-muted inline-flex items-center gap-2 rounded-full border bg-white/60 px-3 py-1.5 font-mono text-[12px]"
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', live ? 'bg-ok' : 'bg-ink-subtle')} />
      {runtime ? `${runtime.executorMode} · ${runtime.models.length} modelos` : 'conectando…'}
    </span>
  );
}
```

Create `apps/web/components/top-bar.tsx`:

```tsx
import { GlassBar } from './glass-bar';
import { RuntimePill } from './runtime-pill';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/', label: 'Projetos' },
  { href: '/router', label: 'Router' },
];

export function TopBar({ activePath }: { activePath: string }) {
  return (
    <GlassBar
      as="header"
      className="sticky top-0 z-30 flex h-14 items-center gap-6 rounded-none border-x-0 border-t-0 px-6"
    >
      <a href="/" className="flex items-center gap-2.5">
        <span className="bg-accent grid size-7 place-items-center rounded-[7px] font-mono text-[11px] font-bold text-white">
          AF
        </span>
        <strong className="text-ink text-[14px]">Agent Foundry</strong>
      </a>

      <nav className="flex items-center gap-1" aria-label="Principal">
        {NAV.map((item) => {
          const active = item.href === activePath;
          return (
            <a
              key={item.href}
              href={item.href}
              {...(active ? { 'aria-current': 'page' as const } : {})}
              className={cn(
                'rounded-control px-3 py-1.5 text-[13px] font-medium transition-colors',
                active ? 'bg-accent-wash text-accent' : 'text-ink-muted hover:text-ink',
              )}
            >
              {item.label}
            </a>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-3">
        <RuntimePill />
        <span className="text-ink-subtle hidden font-mono text-[11px] tracking-wide uppercase sm:inline">
          local-first
        </span>
      </div>
    </GlassBar>
  );
}
```

`TopBar` is a server component; `RuntimePill` carries its own `'use client'`.

- [ ] **Step 6: Wire the shell into the layout**

Replace the `<body>` contents of `apps/web/app/layout.tsx`:

```tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { headers } from 'next/headers';
import { TopBar } from '@/components/top-bar';
import './theme.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Agent Foundry',
  description: 'A local-first, auditable multi-agent software delivery pipeline.',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const pathname = (await headers()).get('x-invoke-path') ?? '/';
  return (
    <html lang="pt-BR">
      <body>
        <TopBar activePath={pathname.startsWith('/router') ? '/router' : '/'} />
        <main>{children}</main>
      </body>
    </html>
  );
}
```

If `x-invoke-path` is absent in this Next version, the fallback marks `Projetos` active; that is acceptable and the `top-bar.test.tsx` assertions still hold because they call `TopBar` directly.

- [ ] **Step 7: Delete the dead chrome CSS**

In `apps/web/app/globals.css`, delete the `.noise`, `.topbar`, `.brand`, `.brandMark`, and `.localBadge` rule blocks (lines ~47–103 in the current file). Leave `.pill` — the project and router pages still use it until Tasks 5 and 6.

Note: `.localBadge, .pill` is a shared selector. Split it: keep `.pill { ... }` with the same declarations, drop `.localBadge`.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
npm run test:unit -- apps/web/components
```

Expected: PASS, 6 tests.

- [ ] **Step 9: Verify**

```bash
npm run typecheck --workspace @agent-foundry/web
npm run test:unit
npm run lint
npm run format && npm run format:check
npm run build --workspace @agent-foundry/web
```

- [ ] **Step 10: Commit**

```bash
git add apps/web/components apps/web/app/layout.tsx apps/web/app/globals.css
git commit -m "feat(web): light glass app shell and status primitives"
```

---

### Task 3: Home page

**Files:**

- Modify: `apps/web/app/page.tsx`
- Create: `apps/web/components/project-card.tsx`
- Modify: `apps/web/app/globals.css` (delete home-only blocks)
- Test: `apps/web/components/project-card.test.tsx`
- Test: `apps/web/app/home-copy.test.tsx`

**Interfaces:**

- Consumes: `StatusPill`, `EmptyState`, `cn`, tokens.
- Produces: `ProjectCard({ project }: { project: Project })`, `PIPELINE_NODES: readonly { code: string; title: string }[]` exported from `apps/web/app/page.tsx`.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/components/project-card.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Project } from '@agent-foundry/contracts';
import { ProjectCard } from './project-card';

const project = {
  schemaVersion: '1',
  id: 'project-1',
  name: 'Issue Radar',
  status: 'running',
  currentNodeId: 'build',
  version: 1,
  createdAt: '2026-07-20T10:00:00.000Z',
  updatedAt: '2026-07-21T12:00:00.000Z',
} as unknown as Project;

describe('ProjectCard', () => {
  it('links to the project and surfaces name, status and current node', () => {
    const markup = renderToStaticMarkup(<ProjectCard project={project} />);
    expect(markup).toContain('href="/project/project-1"');
    expect(markup).toContain('Issue Radar');
    expect(markup).toContain('data-status="running"');
    expect(markup).toContain('build');
  });

  it('renders one segment per pipeline stage', () => {
    const markup = renderToStaticMarkup(<ProjectCard project={project} />);
    expect([...markup.matchAll(/data-stage="/g)]).toHaveLength(5);
  });
});
```

Create `apps/web/app/home-copy.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { PIPELINE_NODES } from './page';

describe('home pipeline copy', () => {
  it('keeps the five pipeline stages in order', () => {
    expect(PIPELINE_NODES.map((node) => node.code)).toEqual([
      'PLAN',
      'ARCH',
      'BUILD',
      'VERIFY',
      'RELEASE',
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
npm run test:unit -- apps/web/components/project-card.test.tsx apps/web/app/home-copy.test.tsx
```

Expected: FAIL — cannot resolve `./project-card`; `PIPELINE_NODES` is not exported.

- [ ] **Step 3: Implement `ProjectCard`**

Create `apps/web/components/project-card.tsx`:

```tsx
import type { Project } from '@agent-foundry/contracts';
import { StatusPill } from './status-pill';
import { cn } from '@/lib/utils';

const STAGES = ['plan', 'architecture', 'build', 'verify', 'release'] as const;

export function ProjectCard({ project }: { project: Project }) {
  const reachedIndex = STAGES.findIndex((stage) =>
    (project.currentNodeId ?? '').toLowerCase().startsWith(stage.slice(0, 4)),
  );

  return (
    <a
      href={`/project/${project.id}`}
      data-testid="project-card"
      className="bg-surface border-hairline rounded-card shadow-card hover:border-accent/40 flex flex-col gap-3 border p-4 transition-colors"
    >
      <div className="flex items-start justify-between gap-3">
        <strong className="text-ink text-[15px] leading-tight">{project.name}</strong>
        <StatusPill status={project.status} />
      </div>

      <div className="flex gap-1" aria-hidden>
        {STAGES.map((stage, index) => (
          <span
            key={stage}
            data-stage={stage}
            className={cn(
              'h-1 flex-1 rounded-full',
              reachedIndex >= 0 && index <= reachedIndex ? 'bg-accent' : 'bg-ink/10',
            )}
          />
        ))}
      </div>

      <div className="text-ink-subtle flex items-center justify-between font-mono text-[11px]">
        <span>{project.currentNodeId ?? 'sem nó'}</span>
        <time dateTime={project.updatedAt}>
          {new Date(project.updatedAt).toLocaleString('pt-BR')}
        </time>
      </div>
    </a>
  );
}
```

- [ ] **Step 4: Rewrite the home page**

Rewrite `apps/web/app/page.tsx`. Keep the existing `SAMPLE_PRD` constant, the `useEffect` data load, and the `submit` handler bodies exactly as they are — only markup and class names change, plus the exported `PIPELINE_NODES` and the removal of the runtime card (now in the top bar):

```tsx
'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Project } from '@agent-foundry/contracts';
import { createProject, listProjects } from '../lib/api';
import { ProjectCard } from '@/components/project-card';
import { EmptyState } from '@/components/empty-state';

const SAMPLE_PRD = `...unchanged, keep the existing literal verbatim...`;

export const PIPELINE_NODES = [
  { code: 'PLAN', title: 'Planejamento + revisão' },
  { code: 'ARCH', title: 'Arquitetura + revisão' },
  { code: 'BUILD', title: 'Implementação + code review' },
  { code: 'VERIFY', title: 'Checks determinísticos + reparo' },
  { code: 'RELEASE', title: 'Teste adversarial final' },
] as const;

export default function HomePage() {
  const router = useRouter();
  const [name, setName] = useState('Issue Radar');
  const [prd, setPrd] = useState(SAMPLE_PRD);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void listProjects()
      .then(setProjects)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const project = await createProject({ name, prd, workflowId: 'web-app-v1' });
      router.push(`/project/${project.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] px-6 py-10">
      <header className="mb-8 max-w-[62ch]">
        <h1 className="text-ink text-[32px] leading-tight font-semibold tracking-[-0.02em]">
          Transforme um PRD em uma linha de montagem de agentes.
        </h1>
        <p className="text-ink-muted mt-3 text-[15px] leading-relaxed">
          Planner, revisores, arquiteto, developer, fixer e tester. Cada passagem deixa artefatos,
          decisões, métricas e checkpoints Git.
        </p>
      </header>

      <section className="mb-10 grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.9fr)]">
        <form
          onSubmit={submit}
          className="bg-surface border-hairline rounded-panel shadow-card flex flex-col gap-4 border p-5"
        >
          <h2 className="text-ink text-[15px] font-semibold">Forneça o problema</h2>

          <label className="text-ink-muted flex flex-col gap-1.5 text-[13px] font-medium">
            Nome do projeto
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
              className="border-hairline rounded-control text-ink focus:border-accent border bg-white px-3 py-2 text-[14px] outline-none"
            />
          </label>

          <label className="text-ink-muted flex flex-col gap-1.5 text-[13px] font-medium">
            PRD <span className="text-ink-subtle font-normal">mínimo de 50 caracteres</span>
            <textarea
              value={prd}
              onChange={(event) => setPrd(event.target.value)}
              minLength={50}
              required
              className="border-hairline rounded-control text-ink focus:border-accent min-h-[260px] resize-y border bg-white px-3 py-2 font-mono text-[12.5px] leading-relaxed outline-none"
            />
          </label>

          {error ? (
            <p role="alert" className="text-err bg-err/10 rounded-control px-3 py-2 text-[13px]">
              {error}
            </p>
          ) : null}

          <button
            disabled={submitting}
            className="bg-accent hover:bg-accent-strong rounded-control px-4 py-2.5 text-[14px] font-semibold text-white disabled:opacity-60"
          >
            {submitting ? 'Criando e enfileirando…' : 'Fundir projeto'}
          </button>
        </form>

        <aside className="bg-surface border-hairline rounded-panel shadow-card border p-5">
          <h2 className="text-ink mb-4 text-[15px] font-semibold">Pipeline</h2>
          <ol className="flex flex-col gap-3">
            {PIPELINE_NODES.map((node) => (
              <li key={node.code} className="flex items-baseline gap-3">
                <code className="text-accent w-[62px] shrink-0 font-mono text-[11px] font-bold">
                  {node.code}
                </code>
                <span className="text-ink-muted text-[13px]">{node.title}</span>
              </li>
            ))}
          </ol>
        </aside>
      </section>

      <section>
        <h2 className="text-ink mb-4 text-[20px] font-semibold tracking-[-0.01em]">Projetos</h2>
        {projects.length === 0 ? (
          <EmptyState
            title="Nenhuma execução ainda."
            hint="Descreva o problema acima e funda o primeiro projeto."
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Delete the dead home CSS**

From `apps/web/app/globals.css`, delete the rule blocks now unused by any page: `.hero`, `.eyebrow`, `.lede` (check `project/[id]/page.tsx` first — it uses `.lede` and `.eyebrow`, so keep those two until Task 5), `.runtimeCard`, `.statusDot`, `.composer`, `.pipelinePanel`, `.pipeline`, `.finePrint`, `.stepNumber`, `.recent`, `.sectionTitle`, `.projectList`, `.projectRow`.

Verify before each deletion:

```bash
grep -rn "runtimeCard\|projectRow\|pipelinePanel" apps/web --include='*.tsx'
```

Delete only the blocks with zero remaining hits.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:unit -- apps/web/components/project-card.test.tsx apps/web/app/home-copy.test.tsx
```

Expected: PASS, 3 tests.

- [ ] **Step 7: Verify**

```bash
npm run typecheck --workspace @agent-foundry/web
npm run test:unit
npm run lint
npm run format && npm run format:check
npm run build --workspace @agent-foundry/web
```

- [ ] **Step 8: Commit**

```bash
git add apps/web/app/page.tsx apps/web/app/home-copy.test.tsx apps/web/components apps/web/app/globals.css
git commit -m "feat(web): redesign home on the glass design system"
```

---

### Task 4: Split the builder page (behavior-identical)

Structural only. No class names change, no markup changes, no copy changes. The page must render byte-identical output so the e2e suite passes untouched at the end of this task — except for added `data-testid` attributes.

**Files:**

- Modify: `apps/web/app/project/[id]/page.tsx` (1868 → ~300 lines)
- Create: `apps/web/app/project/[id]/builder-shell.tsx`
- Create: `apps/web/app/project/[id]/builder-header.tsx`
- Create: `apps/web/app/project/[id]/run-alert-strip.tsx`
- Create: `apps/web/app/project/[id]/chat-pane.tsx`
- Create: `apps/web/app/project/[id]/center-pane.tsx`
- Create: `apps/web/app/project/[id]/inspector/index.tsx`
- Create: `apps/web/app/project/[id]/inspector/{activity,run,changes,artifacts,router,versions}-tab.tsx`
- Create: `apps/web/app/project/[id]/dialogs/{retry-plan,decide,artifact-viewer}-dialog.tsx`
- Modify: `apps/api/e2e/golden-flow.spec.ts` (class selectors → `getByTestId`)
- Test: `apps/web/app/project/[id]/builder-shell.test.tsx`

**Interfaces:**

- Consumes: everything already in `page.tsx`.
- Produces:
  - `BuilderShell({ header, alerts, chat, center, inspector }: { header: ReactNode; alerts: ReactNode; chat: ReactNode; center: ReactNode; inspector: ReactNode })`
  - `InspectorTabs({ activeTab, onTabChange, tabs }: { activeTab: InspectorTabId; onTabChange: (tab: InspectorTabId) => void; tabs: InspectorTab[] })`
  - `type InspectorTabId = 'atividade' | 'execucao' | 'mudancas' | 'artefatos' | 'router' | 'versoes'`
  - `type InspectorTab = { id: InspectorTabId; label: string; badge?: { tone: StatusTone; count?: number }; content: ReactNode }`

- [ ] **Step 1: Write the failing shell test**

Create `apps/web/app/project/[id]/builder-shell.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BuilderShell } from './builder-shell';

describe('BuilderShell', () => {
  it('keeps Chat, Preview and Changes landmarks in document order', () => {
    const markup = renderToStaticMarkup(
      <BuilderShell
        header={<div />}
        alerts={null}
        chat={<section role="region" aria-label="Chat" />}
        center={<section role="region" aria-label="Preview" />}
        inspector={<section role="region" aria-label="Changes" />}
      />,
    );

    expect(
      [...markup.matchAll(/aria-label="(Chat|Preview|Changes)"/g)].map((match) => match[1]),
    ).toEqual(['Chat', 'Preview', 'Changes']);
  });

  it('exposes the three panes by testid', () => {
    const markup = renderToStaticMarkup(
      <BuilderShell header={null} alerts={null} chat={null} center={null} inspector={null} />,
    );
    expect(markup).toContain('data-testid="pane-chat"');
    expect(markup).toContain('data-testid="pane-center"');
    expect(markup).toContain('data-testid="pane-inspector"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit -- 'apps/web/app/project/[id]/builder-shell.test.tsx'
```

Expected: FAIL — cannot resolve `./builder-shell`.

- [ ] **Step 3: Create `BuilderShell`**

Create `apps/web/app/project/[id]/builder-shell.tsx`. For this task it keeps the existing `.builderGrid` class so nothing moves visually; Task 5 replaces the class with Tailwind:

```tsx
import type { ReactNode } from 'react';

export function BuilderShell({
  header,
  alerts,
  chat,
  center,
  inspector,
}: {
  header: ReactNode;
  alerts: ReactNode;
  chat: ReactNode;
  center: ReactNode;
  inspector: ReactNode;
}) {
  return (
    <div className="shell projectShell">
      {header}
      {alerts}
      <div className="builderGrid">
        <div data-testid="pane-chat">{chat}</div>
        <div data-testid="pane-center">{center}</div>
        <div data-testid="pane-inspector">{inspector}</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Move the markup out of `page.tsx`, one region at a time**

Work in this order, running `npm run typecheck --workspace @agent-foundry/web` after each move. Cut the JSX and the handlers it exclusively owns; pass everything else in as props. Do not rename any handler, state variable, class name, or string literal.

1. `builder-header.tsx` ← the `<section className="projectHero">` block (`page.tsx:904-936`)
2. `run-alert-strip.tsx` ← project error, `error`, the `Execução pausada` panel (`page.tsx:937-1299`, the alert-shaped parts only)
3. `chat-pane.tsx` ← the `<section className="panel chatPanel">` block (`page.tsx:942-1090`)
4. `center-pane.tsx` ← the preview mount and artifact display
5. `inspector/activity-tab.tsx` ← `Linha do tempo` (`page.tsx:1432-1469`)
6. `inspector/run-tab.tsx` ← `Steps da execução` (`page.tsx:1490-1548`)
7. `inspector/changes-tab.tsx` ← `ChangesPanel` mount, checks, approvals, `Draft preservado`
8. `inspector/artifacts-tab.tsx` ← `Artefatos` (`page.tsx:1470-1489`)
9. `inspector/router-tab.tsx` ← `Decisões do model router` + `Limite de emergência e modelo fixado` + `ModelPinFields`
10. `inspector/versions-tab.tsx` ← the version history mount
11. `dialogs/retry-plan-dialog.tsx`, `dialogs/decide-dialog.tsx`, `dialogs/artifact-viewer-dialog.tsx` ← the three modal blocks at `page.tsx:1630-1868`

Also move the pure helpers out of `page.tsx` into the file that uses them: `isFallback`, `artifactText`, `unifiedDiffToSpans`, `isVerificationReport`, `eventBadges`, `showsCompletedOperationLinks`, `DiffView`, `BlobArtifactPreview`.

`page.tsx` keeps: all `useState`/`useEffect`, the API calls, the event stream wiring, and a single `return <BuilderShell ... />`.

For this task, `inspector/index.tsx` renders all six tab contents stacked — identical to today's layout. Tabs arrive in Task 5.

- [ ] **Step 5: Add `data-testid` to every element the e2e suite targets**

| e2e selector today           | Element                    | `data-testid` to add          |
| ---------------------------- | -------------------------- | ----------------------------- |
| `.routesPanel`               | Router decisions section   | `router-decisions`            |
| `.routeGrid article h4`      | Route card heading         | `route-card` on the `article` |
| `.artifactList button`       | Artifact list entry button | `artifact-item`               |
| `.artifactModal`             | Artifact dialog            | `artifact-modal`              |
| `.artifactModal img`         | Artifact image             | `artifact-image`              |
| `.artifactModal .diffPane`   | Diff inside the modal      | `artifact-diff`               |
| `.previewFrameWrap iframe`   | Preview iframe             | `preview-frame`               |
| `.screenshotFilmstrip img`   | Screenshot thumbnail       | `screenshot-thumb`            |
| `.operationBadge`            | Operation status badge     | `operation-badge`             |
| `.knowledgeFileList article` | Knowledge file row         | `knowledge-file`              |

Keep the CSS classes in place in this task — both selectors work, so the change is reversible.

- [ ] **Step 6: Migrate `golden-flow.spec.ts` to testids**

In `apps/api/e2e/golden-flow.spec.ts`, replace each `page.locator('.x')` from the table above with `page.getByTestId('...')`. Leave every role/label/text locator untouched. Example:

```ts
// before
const routesPanel = page.locator('.routesPanel');
await expect(routesPanel.locator('.routeGrid article h4')).toHaveCount(3);
// after
const routesPanel = page.getByTestId('router-decisions');
await expect(routesPanel.getByTestId('route-card').locator('h4')).toHaveCount(3);
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
npm run test:unit -- 'apps/web/app/project/[id]'
```

Expected: PASS, including the pre-existing `changes-panel`, `knowledge-files`, `preview-panel`, `version-history`, and `builder-shell-css` tests.

- [ ] **Step 8: Verify no file exceeds 300 lines**

```bash
wc -l apps/web/app/project/\[id\]/*.tsx apps/web/app/project/\[id\]/inspector/*.tsx apps/web/app/project/\[id\]/dialogs/*.tsx | sort -rn | head -5
```

Expected: the largest file is under 300 lines. If `page.tsx` is still over, move more handlers into the pane that owns them.

- [ ] **Step 9: Verify the full surface**

```bash
npm run typecheck --workspace @agent-foundry/web
npm run test:unit
npm run lint
npm run format && npm run format:check
npm run build --workspace @agent-foundry/web
```

Then run the e2e suite; it exercises the real UI and is the only check that proves this refactor preserved behavior:

```bash
npm install
npx playwright test --config apps/api/e2e/playwright.config.ts
```

(`npm install` first: fresh worktrees can have an empty `node_modules`, which makes Playwright fall through to a stale `dist`.)

- [ ] **Step 10: Commit**

```bash
git add apps/web/app/project apps/api/e2e/golden-flow.spec.ts
git commit -m "refactor(web): split builder page into panes and inspector tabs"
```

---

### Task 5: Builder inspector, alert strip, and restyle

Turns the stacked panes into the designed workspace: three resizable panes, six inspector tabs with URL state, alert strip.

**Files:**

- Modify: `apps/web/app/project/[id]/builder-shell.tsx`
- Modify: `apps/web/app/project/[id]/inspector/index.tsx`
- Modify: `apps/web/app/project/[id]/{builder-header,run-alert-strip,chat-pane,center-pane}.tsx`
- Modify: `apps/web/app/project/[id]/inspector/*.tsx`
- Modify: `apps/web/app/project/[id]/{preview-panel,knowledge-files,version-history,changes-panel}.tsx`
- Modify: `apps/web/app/globals.css` (delete builder blocks)
- Modify: `apps/api/e2e/golden-flow.spec.ts` (open the inspector tab before asserting on its contents)
- Test: `apps/web/app/project/[id]/inspector/inspector.test.tsx`

**Interfaces:**

- Consumes: `BuilderShell`, `InspectorTabId`, `StatusPill`, `EmptyState`, `GlassBar`.
- Produces: `inspectorTabFromSearch(value: string | null): InspectorTabId` — parses `?tab=`, returns `'atividade'` for anything unrecognized.

- [ ] **Step 1: Write the failing inspector test**

Create `apps/web/app/project/[id]/inspector/inspector.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InspectorTabs, inspectorTabFromSearch } from './index';

const tabs = [
  { id: 'atividade' as const, label: 'Atividade', content: <p>timeline</p> },
  { id: 'mudancas' as const, label: 'Mudanças', content: <p>changes</p> },
];

describe('inspectorTabFromSearch', () => {
  it('accepts known tabs and defaults the rest', () => {
    expect(inspectorTabFromSearch('mudancas')).toBe('mudancas');
    expect(inspectorTabFromSearch('router')).toBe('router');
    expect(inspectorTabFromSearch('nope')).toBe('atividade');
    expect(inspectorTabFromSearch(null)).toBe('atividade');
  });
});

describe('InspectorTabs', () => {
  it('follows the ARIA tabs pattern', () => {
    const markup = renderToStaticMarkup(
      <InspectorTabs activeTab="mudancas" onTabChange={() => {}} tabs={tabs} />,
    );
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('role="tab"');
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain('aria-selected="true"');
  });

  it('renders only the active tab panel', () => {
    const markup = renderToStaticMarkup(
      <InspectorTabs activeTab="mudancas" onTabChange={() => {}} tabs={tabs} />,
    );
    expect(markup).toContain('changes');
    expect(markup).not.toContain('timeline');
  });

  it('marks a tab that needs attention', () => {
    const withBadge = [
      {
        id: 'mudancas' as const,
        label: 'Mudanças',
        badge: { tone: 'warn' as const, count: 1 },
        content: <p>x</p>,
      },
    ];
    const markup = renderToStaticMarkup(
      <InspectorTabs activeTab="mudancas" onTabChange={() => {}} tabs={withBadge} />,
    );
    expect(markup).toContain('data-badge-tone="warn"');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit -- 'apps/web/app/project/[id]/inspector/inspector.test.tsx'
```

Expected: FAIL — `inspectorTabFromSearch` is not exported.

- [ ] **Step 3: Implement the tab strip**

Rewrite `apps/web/app/project/[id]/inspector/index.tsx`:

```tsx
'use client';

import type { ReactNode } from 'react';
import type { StatusTone } from '@/components/status-pill';
import { cn } from '@/lib/utils';

export const INSPECTOR_TAB_IDS = [
  'atividade',
  'execucao',
  'mudancas',
  'artefatos',
  'router',
  'versoes',
] as const;

export type InspectorTabId = (typeof INSPECTOR_TAB_IDS)[number];

export type InspectorTab = {
  id: InspectorTabId;
  label: string;
  badge?: { tone: StatusTone; count?: number };
  content: ReactNode;
};

export function inspectorTabFromSearch(value: string | null): InspectorTabId {
  return INSPECTOR_TAB_IDS.includes(value as InspectorTabId)
    ? (value as InspectorTabId)
    : 'atividade';
}

const BADGE_CLASS: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-info',
  neutral: 'bg-ink-subtle',
};

export function InspectorTabs({
  activeTab,
  onTabChange,
  tabs,
}: {
  activeTab: InspectorTabId;
  onTabChange: (tab: InspectorTabId) => void;
  tabs: InspectorTab[];
}) {
  const active = tabs.find((tab) => tab.id === activeTab) ?? tabs[0];

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = tabs[(index + delta + tabs.length) % tabs.length];
    if (next) onTabChange(next.id);
  }

  return (
    <section
      role="region"
      aria-label="Changes"
      data-testid="inspector"
      className="flex min-h-0 flex-col"
    >
      <div
        role="tablist"
        aria-label="Inspetor"
        className="glass rounded-panel sticky top-14 z-10 flex gap-0.5 overflow-x-auto p-1"
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            role="tab"
            type="button"
            id={`inspector-tab-${tab.id}`}
            aria-controls={`inspector-panel-${tab.id}`}
            aria-selected={tab.id === activeTab}
            tabIndex={tab.id === activeTab ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'rounded-control flex shrink-0 items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium',
              tab.id === activeTab ? 'bg-accent-wash text-accent' : 'text-ink-muted hover:text-ink',
            )}
          >
            {tab.label}
            {tab.badge ? (
              <span
                data-badge-tone={tab.badge.tone}
                className={cn('size-1.5 rounded-full', BADGE_CLASS[tab.badge.tone])}
              />
            ) : null}
          </button>
        ))}
      </div>

      {active ? (
        <div
          role="tabpanel"
          id={`inspector-panel-${active.id}`}
          aria-labelledby={`inspector-tab-${active.id}`}
          className="min-h-0 flex-1 overflow-y-auto pt-3"
        >
          {active.content}
        </div>
      ) : null}
    </section>
  );
}
```

The `role="region" aria-label="Changes"` landmark stays on the inspector so the existing e2e scoping keeps working.

- [ ] **Step 4: Sync the active tab to the URL in `page.tsx`**

In `apps/web/app/project/[id]/page.tsx`:

```tsx
import { useRouter, useSearchParams } from 'next/navigation';
import { inspectorTabFromSearch, type InspectorTabId } from './inspector';

// inside the component
const searchParams = useSearchParams();
const router = useRouter();
const activeTab = inspectorTabFromSearch(searchParams.get('tab'));

function selectTab(tab: InspectorTabId) {
  const next = new URLSearchParams(searchParams.toString());
  next.set('tab', tab);
  router.replace(`?${next.toString()}`, { scroll: false });
}
```

Wrap the page body in `<Suspense>` if the Next build complains that `useSearchParams` needs a suspense boundary.

- [ ] **Step 5: Restyle `BuilderShell` to three panes**

Rewrite `apps/web/app/project/[id]/builder-shell.tsx`:

```tsx
import type { ReactNode } from 'react';

export function BuilderShell({
  header,
  alerts,
  chat,
  center,
  inspector,
}: {
  header: ReactNode;
  alerts: ReactNode;
  chat: ReactNode;
  center: ReactNode;
  inspector: ReactNode;
}) {
  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col gap-3 px-4 py-3">
      {header}
      {alerts}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(300px,0.9fr)_minmax(420px,1.4fr)_minmax(320px,1fr)]">
        <div
          data-testid="pane-chat"
          className="bg-surface border-hairline rounded-panel shadow-card flex min-h-0 flex-col overflow-hidden border"
        >
          {chat}
        </div>
        <div
          data-testid="pane-center"
          className="bg-surface border-hairline rounded-panel shadow-card flex min-h-0 flex-col overflow-hidden border"
        >
          {center}
        </div>
        <div data-testid="pane-inspector" className="flex min-h-0 flex-col">
          {inspector}
        </div>
      </div>
    </div>
  );
}
```

Below `lg` (1024px) the grid is one column and all three panes stack in Chat → Preview → Inspector order, which is what `builder-shell.test.tsx` asserts.

- [ ] **Step 6: Restyle the panes and inspector tabs**

Convert every `className="panel"`, `panelHeader`, `hint`, `errorBox`, `secondaryButton`, `primaryButton`, `pill`, `artifactList`, `timeline`, `emptyState` in the builder files to Tailwind, using:

| Old class             | Replacement                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `panel`               | `bg-surface border-hairline rounded-panel shadow-card border p-4`                                             |
| `panelHeader`         | `flex items-center justify-between gap-3 mb-3`                                                                |
| `hint`                | `text-ink-subtle text-[12px]`                                                                                 |
| `errorBox`            | `text-err bg-err/10 rounded-control px-3 py-2 text-[13px]` + `role="alert"`                                   |
| `secondaryButton`     | `border-hairline rounded-control text-ink hover:bg-accent-wash border px-3 py-1.5 text-[13px] font-medium`    |
| `primaryButton`       | `bg-accent hover:bg-accent-strong rounded-control px-4 py-2 text-[14px] font-semibold text-white`             |
| `pill` / status spans | `<StatusPill status={...} />`                                                                                 |
| `emptyState`          | `<EmptyState title="…" />`                                                                                    |
| `diffPane`            | keep the element, add `overflow-x-auto max-w-full font-mono text-[12.5px] bg-surface-sunken rounded-card p-3` |

`errorBox` currently has no `role`; adding `role="alert"` is required by `DESIGN.md` §7 and does not affect any existing locator.

- [ ] **Step 7: Build the alert strip**

Rewrite `apps/web/app/project/[id]/run-alert-strip.tsx` so paused runs, project errors, and resume-blocked states render as one glass strip above the panes rather than as full panels:

```tsx
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function RunAlertStrip({
  tone,
  title,
  detail,
  actions,
}: {
  tone: 'warn' | 'err' | 'info';
  title: string;
  detail?: string;
  actions?: ReactNode;
}) {
  return (
    <div
      role="alert"
      data-testid="run-alert"
      className={cn(
        'glass rounded-panel flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]',
        tone === 'err' && 'text-err',
        tone === 'warn' && 'text-warn',
        tone === 'info' && 'text-info',
      )}
    >
      <strong className="font-semibold">{title}</strong>
      {detail ? <span className="text-ink-muted">{detail}</span> : null}
      {actions ? <span className="ml-auto flex gap-2">{actions}</span> : null}
    </div>
  );
}
```

- [ ] **Step 8: Delete the dead builder CSS**

From `apps/web/app/globals.css`, delete every block now unreferenced. Verify first:

```bash
for cls in panel panelHeader hint errorBox secondaryButton primaryButton builderGrid chatPanel \
  timeline artifactList projectHero projectStatusBlock routesPanel routeGrid modelPinGrid \
  executionEvidence dashboardGrid conversationList operationLinks agentStreamActivity \
  changesSection lede eyebrow backLink loadingState; do
  echo "$cls: $(grep -rn "\"[^\"]*\b$cls\b" apps/web --include='*.tsx' | grep -vc '\.test\.' || true)"
done
```

Delete only classes reporting `0`.

- [ ] **Step 9: Update the e2e suite for tabs**

Anything the spec asserts inside the inspector now needs its tab opened first. Add a helper near the top of `apps/api/e2e/golden-flow.spec.ts`:

```ts
async function openInspectorTab(page: Page, label: string) {
  await page.getByRole('tab', { name: label }).click();
  await expect(page.getByRole('tab', { name: label })).toHaveAttribute('aria-selected', 'true');
}
```

Call `await openInspectorTab(page, 'Router')` before the router-decisions assertions, `'Artefatos'` before artifact-list assertions, and `'Mudanças'` before checks/approvals assertions.

- [ ] **Step 10: Run the tests to verify they pass**

```bash
npm run test:unit -- 'apps/web/app/project/[id]'
```

Expected: PASS.

- [ ] **Step 11: Verify**

```bash
npm run typecheck --workspace @agent-foundry/web
npm run test:unit
npm run lint
npm run format && npm run format:check
npm run build --workspace @agent-foundry/web
npm install && npx playwright test --config apps/api/e2e/playwright.config.ts
```

- [ ] **Step 12: Commit**

```bash
git add apps/web/app/project apps/web/app/globals.css apps/api/e2e/golden-flow.spec.ts
git commit -m "feat(web): three-pane builder workspace with tabbed inspector"
```

---

### Task 6: Router dashboard

Independent of Tasks 3–5; can be done in parallel after Task 2.

**Files:**

- Modify: `apps/web/app/router/dashboard-view.tsx`
- Create: `apps/web/components/stat-tile.tsx`
- Modify: `apps/web/app/router/dashboard-view.test.tsx`
- Modify: `apps/web/app/globals.css` (delete `.kpiGrid`, `.kpiTile`, `.filterBar`, `.experimentTable`, `.routerDashboard`)
- Test: `apps/web/components/stat-tile.test.tsx`

**Interfaces:**

- Consumes: `StatusPill`, `EmptyState`, `GlassBar`, tokens.
- Produces: `StatTile({ label, value, hint, tone }: { label: string; value: string | number; hint?: string; tone?: StatusTone })`

- [ ] **Step 1: Write the failing stat tile test**

Create `apps/web/components/stat-tile.test.tsx`:

```tsx
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatTile } from './stat-tile';

describe('StatTile', () => {
  it('renders label, value and hint', () => {
    const markup = renderToStaticMarkup(
      <StatTile label="Decisões" value={42} hint="últimos 7 dias" />,
    );
    expect(markup).toContain('Decisões');
    expect(markup).toContain('42');
    expect(markup).toContain('últimos 7 dias');
  });

  it('is a solid card, never glass', () => {
    const markup = renderToStaticMarkup(<StatTile label="x" value="1" />);
    expect(markup).not.toMatch(/\bglass\b/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npm run test:unit -- apps/web/components/stat-tile.test.tsx
```

Expected: FAIL — cannot resolve `./stat-tile`.

- [ ] **Step 3: Implement `StatTile`**

Create `apps/web/components/stat-tile.tsx`:

```tsx
import type { StatusTone } from './status-pill';
import { cn } from '@/lib/utils';

const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'text-ok',
  warn: 'text-warn',
  err: 'text-err',
  info: 'text-info',
  neutral: 'text-ink',
};

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: StatusTone;
}) {
  return (
    <div className="bg-surface border-hairline rounded-card shadow-card flex flex-col gap-1 border p-4">
      <span className="text-ink-muted text-[12px] font-semibold tracking-[0.04em] uppercase">
        {label}
      </span>
      <strong className={cn('text-[24px] leading-none font-semibold', TONE_CLASS[tone])}>
        {value}
      </strong>
      {hint ? <span className="text-ink-subtle text-[12px]">{hint}</span> : null}
    </div>
  );
}
```

- [ ] **Step 4: Restyle the dashboard**

In `apps/web/app/router/dashboard-view.tsx`:

- Wrap the filter row in `<GlassBar className="flex flex-wrap items-end gap-3 p-3">`.
- Replace each `<div className="kpiTile">` with `<StatTile label="…" value={…} />`, keeping the exact same labels and values, inside `<div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">`.
- Replace the `Decisões` `<ul className="artifactList">` with a `<table>`: columns `quando`, `task kind`, `modelo`, `provider`, `score`, `fallback`. Row click opens a detail `<dialog>` — reuse the existing decision object; do not add a fetch.
- Replace the inline experiment form with a `<button>` that opens a `<dialog data-testid="new-experiment">` containing the same form fields and the same submit handler.
- Apply the class conversion table from Task 5 Step 6 to everything else on the page.

- [ ] **Step 5: Extend the dashboard test**

Add to the existing `describe('RouterDashboardView')` block in `apps/web/app/router/dashboard-view.test.tsx`. Keep the existing case untouched and reuse its exact prop set and the module-level `dashboard` / `experiment` fixtures already defined in that file:

```tsx
it('renders the decisions as a table and moves experiment creation into a dialog', () => {
  const markup = renderToStaticMarkup(
    <RouterDashboardView
      filters={EMPTY_ROUTER_FILTERS}
      onFiltersChange={() => {}}
      dashboard={dashboard}
      decisions={[]}
      experiments={[experiment]}
      exportHref="http://localhost:4000/router/export"
      hypothesis=""
      onHypothesisChange={() => {}}
      onSubmitExperiment={() => {}}
    />,
  );

  expect(markup).toContain('<table');
  expect(markup).toContain('<th');
  expect(markup).toContain('data-testid="new-experiment"');
});
```

The import line in that file ends in `./dashboard-view.js` — leave the extension as it is.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
npm run test:unit -- apps/web/components/stat-tile.test.tsx apps/web/app/router
```

Expected: PASS.

- [ ] **Step 7: Delete the dead router CSS**

Delete `.routerDashboard`, `.filterBar`, `.kpiGrid`, `.kpiTile`, `.experimentTable`, `.compactTextarea` from `apps/web/app/globals.css` after confirming zero `.tsx` references with the grep loop from Task 5 Step 8.

- [ ] **Step 8: Verify**

```bash
npm run typecheck --workspace @agent-foundry/web
npm run test:unit
npm run lint
npm run format && npm run format:check
npm run build --workspace @agent-foundry/web
```

- [ ] **Step 9: Commit**

```bash
git add apps/web/app/router apps/web/components apps/web/app/globals.css
git commit -m "feat(web): rebuild router dashboard on the glass design system"
```

---

### Task 7: Remove `globals.css` and run the accessibility pass

**Files:**

- Delete: `apps/web/app/globals.css`
- Delete: `apps/web/app/project/[id]/builder-shell-css.test.ts`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/api/e2e/golden-flow.spec.ts` (adds the responsive assertions)
- Modify: `apps/web/app/theme.css` (only if a contrast fix is needed)

**Interfaces:**

- Consumes: everything from Tasks 1–6.
- Produces: nothing new.

- [ ] **Step 1: Prove `globals.css` is dead**

```bash
node -e "
const fs=require('fs');
const css=fs.readFileSync('apps/web/app/globals.css','utf8');
const classes=[...new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m=>m[1]))];
const {execSync}=require('child_process');
const live=classes.filter(c=>{
  try{execSync(\`grep -rq 'className=\"[^\"]*\\\\b\${c}\\\\b' apps/web --include='*.tsx'\`);return true}catch{return false}
});
console.log(live.length? 'STILL USED: '+live.join(', ') : 'globals.css is dead');
"
```

Expected: `globals.css is dead`. If not, convert the listed classes in the file that still uses them before continuing.

- [ ] **Step 2: Delete the file and its import**

```bash
git rm apps/web/app/globals.css apps/web/app/project/\[id\]/builder-shell-css.test.ts
```

Remove the `import './globals.css';` line from `apps/web/app/layout.tsx`.

- [ ] **Step 3: Write the replacement responsive e2e check**

`builder-shell-css.test.ts` grepped CSS text; replace it with a real behavioral check.

Do **not** create a new spec file. `apps/api/e2e/support.ts` exports only `reserveEphemeralPort` and `waitForHttp` — there is no reusable project fixture, and the API, worker, and preview servers are started by the `test.beforeAll` inside `golden-flow.spec.ts`. A new spec would have to duplicate that ~60-line setup.

Instead, append these assertions to the existing test at `apps/api/e2e/golden-flow.spec.ts:436` (`'golden flow: change request, preview, browser tests, diff approval, axe'`), at the end of its body, where a project is already open in the builder:

```ts
// Responsive: below the lg breakpoint the three panes stack instead of sitting side by side.
await page.setViewportSize({ width: 900, height: 900 });
const chatBox = await page.getByTestId('pane-chat').boundingBox();
const centerBox = await page.getByTestId('pane-center').boundingBox();
expect(chatBox).not.toBeNull();
expect(centerBox).not.toBeNull();
expect(centerBox!.y).toBeGreaterThan(chatBox!.y + chatBox!.height - 1);

// Long diff lines scroll inside their pane instead of widening the document.
expect(
  await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  ),
).toBe(true);

await page.setViewportSize({ width: 1440, height: 900 });
```

Restore the viewport at the end so nothing after this point inherits the narrow size.

- [ ] **Step 4: Run the contrast audit**

Check every text/background pair from `DESIGN.md` §3.1 at the 4.5:1 threshold:

```bash
node -e "
const pairs=[['#5C6B7A','#FFFFFF'],['#8A97A3','#FFFFFF'],['#8A97A3','#EEF1F4'],['#5C6B7A','#EEF1F4'],['#0FA3A3','#FFFFFF'],['#FFFFFF','#0FA3A3'],['#1FA971','#FFFFFF'],['#E8A33D','#FFFFFF'],['#E5484D','#FFFFFF'],['#3E7BFA','#FFFFFF']];
const lin=c=>{c/=255;return c<=0.03928?c/12.92:((c+0.055)/1.055)**2.4};
const lum=h=>0.2126*lin(parseInt(h.slice(1,3),16))+0.7152*lin(parseInt(h.slice(3,5),16))+0.0722*lin(parseInt(h.slice(5,7),16));
for(const [fg,bg] of pairs){const a=lum(fg),b=lum(bg);const r=((Math.max(a,b)+0.05)/(Math.min(a,b)+0.05));console.log(fg,'on',bg,r.toFixed(2),r>=4.5?'AA':r>=3?'AA-large/ui-only':'FAIL')}
"
```

Any pair reporting `FAIL` for body text must be fixed by darkening the foreground token in `theme.css` and updating the value in `DESIGN.md` §3.1 and in `theme-tokens.test.ts`. Pairs used only for large text, icons, or non-text UI may sit at `AA-large/ui-only`; note which ones in the commit message.

- [ ] **Step 5: Keyboard pass**

Start the app and walk it with the keyboard only:

```bash
npm run dev:inline
```

Confirm: `Tab` reaches every control on `/`, `/router`, and `/project/[id]`; the inspector tablist responds to `ArrowLeft`/`ArrowRight`; every focused element shows the 2px accent ring; no focus is trapped outside a dialog; `Escape` closes each dialog.

Note: `dev:inline`'s checkpoint machinery performs real `git commit`/`reset` on the working tree. Commit or stash your diff before starting it.

- [ ] **Step 6: Verify**

```bash
npm run typecheck --workspace @agent-foundry/web
npm run test:unit
npm run lint
npm run format && npm run format:check
npm run build --workspace @agent-foundry/web
npm install && npx playwright test --config apps/api/e2e/playwright.config.ts
npm run check
```

`npm run check` is the repository-wide gate and must pass before this task is done.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(web): remove legacy stylesheet and finish the a11y pass"
```

---

## Out of scope

- Dark theme.
- i18n / English copy.
- Any change to `apps/api`, `apps/worker`, or `packages/*` beyond the e2e specs.
- New data or endpoints. Every surface renders what the API already returns.
- Registering these tasks as GitHub issues via `planning/roadmap-spec.json` + `npm run github:roadmap:apply`. That publishes to GitHub and needs explicit approval first.

## Self-review notes

- **Spec coverage:** `DESIGN.md` §3 tokens → Task 1. §3.3 glass rule → Task 1 (`@utility glass`) enforced in Tasks 2–6. §4 primitives → Tasks 2, 3, 5, 6 (`GlassBar`, `StatusPill`, `EmptyState`, `RuntimePill`, `StatTile`, `Timeline`/`DiffPane` restyled in place in Task 5). §5.1 shell → Task 2. §5.2 home → Task 3. §5.3 builder + relocation table → Tasks 4 and 5. §5.4 router → Task 6. §6 decomposition → Task 4. §7 a11y → Tasks 5 and 7. §8 testing → Tasks 4, 5, 7. §9 pt-BR → global constraint. §10 migration order → task order.
- **Type consistency:** `StatusTone` is defined once in Task 2 and imported by Tasks 5 and 6. `InspectorTabId` is defined in Task 4 and re-exported from the same module in Task 5. `cn` is defined in Task 1 and used everywhere after.
- **Known constraint:** `apps/web` is absent from the root `tsconfig.json` references, so `npm run typecheck` at the root does not cover it. Every task therefore runs `npm run typecheck --workspace @agent-foundry/web` explicitly.
