# ADR 0061: Builder defaults to a simple two-pane view; execution detail moves behind an "Avançado" toggle

- Status: Proposed
- Date: 2026-08-09
- Owners: UX
- Tracked by issue #488 ([Spec] Simplify the builder to a Lovable-like default view)

## Context

`apps/web`'s builder shell (`builder-shell.tsx`) has always rendered a fixed three-pane
layout — Chat | Preview | Inspector — with the comment "panes are never swapped out by a
segmented control" recording that this was deliberate. Inspector carries six tabs
(Atividade/Execução/Mudanças/Artefatos/Router/Versões; see `DESIGN.md`'s concept→tab
table) and is always visible, always taking roughly a third of the screen, regardless of
whether the operator wants execution/step/artifact detail at that moment.

`docs/PRODUCT_CONTRACT.md` states the product's own positioning as "a private, self-owned
alternative to Lovable" for a solo developer. PR #312 (glass design-system redesign) and
PR #444 ("rescope v1 to the local Lovable loop") already moved the product in this
direction, but neither introduced progressive disclosure — Inspector's detail is
unconditionally on screen. This was surfaced concretely during issue #473's real-mode
tracer runs: the plan-approval gate, the one action an operator must take, lives only
inside Inspector's non-default Mudanças tab, with nothing in the existing alert strip
(`run-alert-strip.tsx`) surfacing it. An operator has to know to look for it.

## Decision

- Default view is two panes: Chat | Preview. Inspector is hidden entirely by default.
- A new "Avançado" toggle in `builder-header.tsx`'s existing right-aligned control group
  (styled as a persistent switch, distinct from momentary action buttons like
  Pausar/Retomar) restores the exact three-pane grid unchanged when turned on — no new
  overlay/drawer component.
- Toggle state persists per-project via `localStorage`, not globally: a project under
  active debugging stays in Advanced across reloads; other projects still default to
  simple.
- `run-alert-strip.tsx` gains a case for run status `awaiting_approval`: a compact banner
  with inline Approve/Reject actions, plus a "Ver plano completo" link that opens Advanced
  directly to Mudanças. No approval gate becomes unreachable from the simple view.
- A new read-only Files tab joins Inspector as a seventh tab (same toggle, not a separate
  one), listing the generated workspace's files. Its exclusion list is derived from the
  generated project's own `.gitignore`, plus a hardcoded always-exclude for `.env*` and
  credential-bearing paths regardless of `.gitignore` contents.
- All new user-facing labels are in Portuguese, matching the existing shell.

## Considered Options

- **Strip detail from inside the three panes instead of hiding a pane.** Rejected — leaves
  Inspector permanently occupying screen space, which is the actual complaint.
- **Surface approvals as inline chat messages.** Rejected — plan content (risks,
  decisions, next actions) is long and structured; the existing alert strip already owns
  "surface run-state banners above the panes."
- **Auto-expand Advanced whenever a gate is raised.** Rejected in favor of the alert-strip
  approach, which needs no pane-visibility side effects.
- **Inspector as an overlay/drawer instead of restoring the grid.** Rejected — new
  component class (z-index, backdrop, animation, responsive handling) for marginal benefit
  on a solo-developer desktop tool.
- **A separate toggle for the Files tab.** Rejected — two toggles is two things to
  explain; folded into the existing Inspector tab pattern instead.
- **Full file editing (the old #139 scope: save, Operation-linked working changes,
  conflict detection).** Rejected for now — read-only only, explicitly deferred rather
  than silently absorbed.

## Consequences

- `DESIGN.md`'s three-pane layout diagram and the "always visible" framing need updating
  to describe the simple/Advanced split — tracked as an implementation detail of whichever
  ticket builds this, not this ADR.
- Explicitly out of scope: generated-app UI/UX (#469/#476, a different surface), the
  destructive-migration approval gap found in #473's defect list (backend orchestration
  wiring, unrelated to this UI decision), and #97's accessibility/responsiveness/
  performance polish track (complementary, not overlapping).
