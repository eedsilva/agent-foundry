# Agent Foundry — UI Design System

Version 1. Owns the visual language and information architecture of `apps/web`.
Read this before changing anything under `apps/web/app` or adding a component.

## 1. Problem

The current UI is a dark, high-contrast console that stacks every panel vertically.
`apps/web/app/project/[id]/page.tsx` is 1868 lines rendering thirteen `<h2>` sections in one
scroll. There is no hierarchy, no progressive disclosure, and no way to see a run's state
without scrolling twelve screens. `apps/web/app/globals.css` is 801 lines of hand-rolled
one-off classes with no reusable primitives.

The system already exposes a lot of information — projects, runtime and executor mode, models,
conversation, operations, agent stream, approvals and gates, steps, timeline events, artifacts
and diffs, router decisions, experiments, versions, knowledge files, preview sessions and logs,
drafts, model overrides, usage and cost. None of it is removed by this redesign. All of it gets
a defined home, reachable in at most one click.

## 2. Principles

1. **Structure over density.** Every piece of data has exactly one canonical location. If it
   appears twice, one of the two is a link.
2. **Progressive disclosure.** Default view answers "what is happening right now". Detail is one
   click away, never pre-expanded.
3. **Glass is chrome, not content.** Translucency marks surfaces that float above the work.
   Dense content — diffs, logs, tables — sits on solid cards.
4. **Light only.** No dark theme in v1. No `prefers-color-scheme` branch.
5. **Calm color.** Color means status. Decoration is neutral.
6. **Nothing is removed.** This is a reorganization, not a feature cut.

## 3. Foundations

### 3.1 Palette

Cool neutral base, teal accent.

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#F4F6F8` | Page base beneath the mesh |
| `--ink` | `#10151A` | Primary text |
| `--ink-muted` | `#5C6B7A` | Secondary text, labels |
| `--ink-subtle` | `#8A97A3` | Metadata, timestamps, placeholders |
| `--surface` | `#FFFFFF` | Content cards |
| `--surface-sunken` | `#EEF1F4` | Inset areas: code, logs, empty states |
| `--hairline` | `rgba(16, 21, 26, 0.08)` | All borders and dividers |
| `--accent` | `#0FA3A3` | Primary action, active state, focus ring |
| `--accent-strong` | `#0C8080` | Accent hover/pressed |
| `--accent-wash` | `rgba(15, 163, 163, 0.08)` | Selected row, active tab background |
| `--ok` | `#1FA971` | Succeeded, approved, passing |
| `--warn` | `#E8A33D` | Paused, awaiting approval, degraded |
| `--err` | `#E5484D` | Failed, rejected, error |
| `--info` | `#3E7BFA` | Running, in-progress, neutral notice |

Status colors are used as a `color` + a 10%-alpha `background` on pills, never as large fills.

### 3.2 Background

Fixed mesh behind everything. Three radial blooms on `--bg`, no scroll, no noise overlay.
The current `.noise` SVG layer is deleted.

```css
background:
  radial-gradient(60rem 40rem at 12% -10%, rgba(15, 163, 163, 0.14), transparent 60%),
  radial-gradient(50rem 36rem at 92% 8%, rgba(62, 123, 250, 0.10), transparent 62%),
  radial-gradient(44rem 30rem at 50% 108%, rgba(15, 163, 163, 0.08), transparent 60%),
  var(--bg);
```

### 3.3 Glass

```css
--glass: rgba(255, 255, 255, 0.6);
--glass-stroke: rgba(255, 255, 255, 0.72);
--glass-blur: 24px;

background: var(--glass);
backdrop-filter: blur(var(--glass-blur)) saturate(180%);
border: 1px solid var(--glass-stroke);
box-shadow: 0 1px 0 rgba(255, 255, 255, 0.6) inset, 0 8px 32px rgba(16, 21, 26, 0.06);
```

**Glass is allowed on:** top bar, inspector tab strip, slide-over sheets, dialogs, popovers,
dropdowns, floating run controls, toasts, the run alert strip.

**Glass is forbidden on:** content cards, tables, diff panes, log viewers, timeline bodies,
chat message bubbles, form fields. These use `--surface` with a `--hairline` border.

Rationale: `backdrop-filter` layered under body text over a gradient reduces contrast
unpredictably and costs GPU per layer. Apple applies it to chrome, not to documents.

### 3.4 Elevation

| Level | Shadow | Use |
| --- | --- | --- |
| 0 | none | Inline, flush content |
| 1 | `0 1px 2px rgba(16,21,26,.06)` | Content cards |
| 2 | `0 8px 24px rgba(16,21,26,.08)` | Popovers, dropdowns |
| 3 | `0 24px 64px rgba(16,21,26,.16)` | Dialogs, sheets |

### 3.5 Radius and spacing

Radius: `8px` controls, `12px` cards, `16px` panels, `20px` sheets/dialogs, `999px` pills.

Spacing scale is Tailwind's default 4px step. Panel padding `16px`; card gap `12px`;
section gap `24px`.

### 3.6 Type

Inter for UI, `ui-monospace` for ids, diffs, logs, model names.

| Role | Size / weight / tracking |
| --- | --- |
| Display (home hero) | 32px / 600 / -0.02em |
| Section title | 20px / 600 / -0.01em |
| Panel title | 15px / 600 |
| Body | 14px / 400 / 1.55 |
| Meta | 13px / 400 |
| Label | 12px / 600 / 0.04em uppercase |
| Mono | 12.5px / 400 |

The current `clamp(42px, 6vw, 78px)` hero and the uppercase mono eyebrows are dropped.

### 3.7 Motion

Durations 120ms (hover/press), 200ms (tab, popover), 280ms (sheet, dialog).
Easing `cubic-bezier(0.32, 0.72, 0, 1)`. All of it inside
`@media (prefers-reduced-motion: no-preference)`.

## 4. Stack

Tailwind CSS v4 + shadcn/ui on Next 16 / React 19.

Tokens live in a CSS-first `@theme` block, so Tailwind utilities and any remaining hand-written
CSS read the same variables during the migration. `globals.css` stays in the tree until the last
surface is migrated, then is deleted.

Primitives from shadcn: `Button`, `Card`, `Tabs`, `Dialog`, `Sheet`, `Popover`,
`DropdownMenu`, `Table`, `Tooltip`, `Toast`, `ScrollArea`, `Separator`, `Input`, `Textarea`,
`Select`, `Checkbox`, `Badge`.

Custom, in `apps/web/components/`:

| Component | Purpose |
| --- | --- |
| `GlassBar` | The glass chrome surface. Top bar, tab strip, run controls. |
| `StatusPill` | Maps a domain status string to a color + label. Single source of status color. |
| `Timeline` | Event list with dot rail, grouping, and live/polling indicator. |
| `DiffPane` | Unified diff renderer. Horizontal scroll bounded to its container. |
| `StatTile` | KPI tile for the router dashboard. |
| `EmptyState` | Icon + one line + optional action. |

No component gets built until a second caller exists, except the six above.

## 5. Information architecture

### 5.1 App shell

Sticky glass top bar, 56px, on every route:

```
[AF] Agent Foundry   Projetos  Router          [● real · 6 modelos]  [local-first]
```

- Brand links to `/`.
- Nav is `Projetos` (`/`) and `Router` (`/router`). Active item gets `--accent-wash`.
- The runtime pill shows executor mode, model count, and a status dot. It replaces the
  `runtimeCard` currently embedded in the home hero, so runtime health is visible on every page.
- Clicking the pill opens a popover with the full `RuntimeInfoResponse`.

### 5.2 Home — `/`

```
┌ hero: one line + lede ──────────────────────────────────────┐
├──────────────────────────────┬──────────────────────────────┤
│ Composer card                │ Pipeline card                │
│  name · PRD · workflow       │  PLAN → ARCH → BUILD →       │
│  [Fundir projeto]            │  VERIFY → RELEASE            │
├──────────────────────────────┴──────────────────────────────┤
│ Projetos                                    [filtro status] │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐                      │
│ │ card     │ │ card     │ │ card     │                      │
│ └──────────┘ └──────────┘ └──────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

Project card: name, status pill, current node, relative updated-at, and a five-segment pipeline
progress strip. The current flat `projectRow` list is replaced.

### 5.3 Builder — `/project/[id]`

Three panes under a glass header. This is the core of the redesign.

```
┌ GlassBar: ← · nome · status pill · nó atual · [pausar][retomar][retry] ┐
├ alert strip (only when paused / erro / resume-blocked / gate pendente) ┤
├────────────┬──────────────────────────────┬───────────────────────────┤
│ CHAT       │ PREVIEW | DIFF | ARTEFATO    │ INSPECTOR                 │
│            │                              │ ┌───────────────────────┐ │
│ mensagens  │                              │ │Ativ|Exec|Mud|Art|Rot|V│ │
│ operações  │  iframe / diff / artefato    │ └───────────────────────┘ │
│ stream     │                              │                           │
│            │  [desktop][tablet][mobile]   │  tab content              │
│ ▸ Knowledge│                              │                           │
│ [compor]   │                              │                           │
└────────────┴──────────────────────────────┴───────────────────────────┘
```

Panel relocation — every existing section keeps a home:

| Today (stacked panel) | New location |
| --- | --- |
| Conversa, operações, agent stream | Left pane |
| Knowledge files | Left pane, collapsible section |
| Preview | Center, `Preview` view |
| Draft diff, artifact diff | Center, `Diff` view |
| Artefato selecionado | Center, `Artefato` view (fullscreen dialog only for images/blobs) |
| Linha do tempo | Inspector → **Atividade** |
| Steps da execução | Inspector → **Execução** |
| Changes, checks, aprovações, browser checks, draft preservado | Inspector → **Mudanças** |
| Artefatos (lista) | Inspector → **Artefatos** |
| Decisões do model router, limite de emergência, modelo fixado | Inspector → **Router** |
| Versões, comparação, revert, branch, proteger | Inspector → **Versões** |
| Execução pausada, erro do projeto, resume bloqueado | Alert strip |

Rules:

- Active inspector tab is in the URL (`?tab=execucao`) so state is deep-linkable and survives
  reload.
- Tabs carry a count or status dot when they hold something actionable — a pending approval
  makes `Mudanças` show a warn dot.
- Pane widths are drag-resizable, persisted to `localStorage`, and reset via a menu item.
- Below 1000px the three panes collapse to one column with a segmented control switching
  Chat / Preview / Inspector.
- Dialogs stay dialogs: retry plan, approval decision, artifact fullscreen.

### 5.4 Router dashboard — `/router`

```
┌ GlassBar toolbar: período · workflow · modelo · [exportar CSV] ┐
├────────────────────────────────────────────────────────────────┤
│ [tile][tile][tile][tile][tile][tile]                           │
├────────────────────────────────────────────────────────────────┤
│ Decisões — sortable table, row click → detail sheet            │
├────────────────────────────────────────────────────────────────┤
│ Experimentos — table + [novo experimento] → dialog             │
└────────────────────────────────────────────────────────────────┘
```

The inline experiment creation form moves into a dialog. The decisions list becomes a real table
with sortable columns and a slide-over detail sheet per row.

## 6. Component decomposition

`apps/web/app/project/[id]/page.tsx` splits. Target: no file over ~300 lines.

| File | Responsibility |
| --- | --- |
| `page.tsx` | Data fetching, streams, state, handlers. Renders `BuilderShell`. |
| `builder-shell.tsx` | Three-pane layout, resize, responsive collapse |
| `builder-header.tsx` | Glass header, status, run controls |
| `run-alert-strip.tsx` | Paused / error / resume-blocked / gate notices |
| `chat-pane.tsx` | Conversation, operations, agent stream, composer |
| `center-pane.tsx` | Preview / Diff / Artefato view switcher |
| `inspector/index.tsx` | Tab strip, URL sync, badges |
| `inspector/activity-tab.tsx` | Timeline |
| `inspector/run-tab.tsx` | Steps, retry entry point |
| `inspector/changes-tab.tsx` | Changes, checks, approvals, draft |
| `inspector/artifacts-tab.tsx` | Artifact list |
| `inspector/router-tab.tsx` | Router decisions, model pin, emergency limit |
| `inspector/versions-tab.tsx` | Version history, compare, revert |
| `dialogs/*.tsx` | Retry plan, approval decision, artifact viewer, proposal editor |

Existing `preview-panel.tsx`, `knowledge-files.tsx`, `version-history.tsx`, `changes-panel.tsx`
are restyled in place and mounted into their new slots, not rewritten.

## 7. Accessibility

- Text contrast ≥ 4.5:1, UI element contrast ≥ 3:1, verified on the mesh background, not on flat
  white. `--ink-subtle` on `--surface-sunken` is the tightest pair and must be checked.
- Focus ring: 2px `--accent` + 2px offset, never removed.
- Existing `role="region"` + `aria-label` landmarks (`Chat`, `Preview`, `Changes`) are preserved;
  each inspector tab panel adds one.
- Tabs follow the ARIA tabs pattern with arrow-key navigation.
- Every icon-only control has an `aria-label`.
- Live regions: the agent stream and the timeline announce politely, throttled.
- All motion behind `prefers-reduced-motion`.

## 8. Testing

`apps/api/e2e/golden-flow.spec.ts` currently targets `.routesPanel`, `.artifactList`,
`.previewFrameWrap`, `.operationBadge`, `.knowledgeFileList`, `.diffPane`, `.screenshotFilmstrip`,
`.artifactModal`. Tailwind utilities remove those hooks.

Rule: **every element the e2e suite targets carries a `data-testid`**, and the spec migrates from
class selectors to `getByTestId` in the same PR that restyles that surface. Role- and label-based
locators are preferred where they already exist and must keep working — that includes the pt-BR
accessible names the spec asserts.

`apps/web/app/project/[id]/builder-shell-css.test.ts` greps `globals.css` for grid rules. It is
deleted with `globals.css` and replaced by a Playwright assertion that the panes actually collapse
at a narrow viewport.

## 9. Language

UI copy stays pt-BR. No i18n layer.

## 10. Migration

Parallel stylesheets, surface by surface. Tailwind and `globals.css` coexist; each surface's PR
deletes the CSS blocks it made dead. The app is shippable at every commit.

| # | Task | Done when |
| --- | --- | --- |
| 1 | Tailwind v4 + shadcn install, `@theme` tokens, mesh background | Build green, tokens resolve, both CSS systems coexist |
| 2 | Custom primitives + app shell, nav, runtime pill | New chrome on all three routes |
| 3 | Home redesign | `/` uses zero `globals.css` classes; its CSS deleted |
| 4 | Builder: split `page.tsx`, three-pane shell, `data-testid` pass | Behavior identical, e2e green on testids, no file > 300 lines |
| 5 | Builder: inspector tabs, alert strip, restyle | `/project/[id]` uses zero `globals.css` classes |
| 6 | Router dashboard | `/router` uses zero `globals.css` classes |
| 7 | Delete `globals.css`, a11y and responsive pass | File gone, contrast AA verified, ≤1000px collapse tested |

Dependencies: 3, 4, 6 depend on 2. 5 depends on 4. 7 depends on all. 6 can run parallel to 3–5.

Task 4 deliberately splits the file before restyling it. A combined split-and-restyle PR on an
1868-line file cannot be reviewed, and a behavior regression would be indistinguishable from a
styling change.
