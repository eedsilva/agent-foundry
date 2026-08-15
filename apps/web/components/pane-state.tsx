import React, { type ReactNode } from 'react';

export type PaneStateKind = 'empty' | 'loading' | 'error';

// `empty`/`loading` keep the same neutral sunken wash as the old EmptyState;
// `error` swaps to the ERROR_BOX colour pattern (see lib/ui.ts) — `--ink`
// text on `bg-err/10` with `border-err/30`, since `text-err` on `bg-err/10`
// only measures 3.44:1 against DESIGN.md §7's 4.5:1.
const TONE: Record<PaneStateKind, string> = {
  empty: 'bg-surface-sunken',
  loading: 'bg-surface-sunken',
  error: 'bg-err/10 border-err/30 border',
};

const ROLE: Record<PaneStateKind, 'status' | 'alert' | undefined> = {
  empty: undefined,
  loading: 'status',
  error: 'alert',
};

/** One primitive for the three states every pane can be in: nothing to show,
 * still loading, or failed. Replaces EmptyState — the previous primitive only
 * covered "nothing to show" and left loading/error to five different ad-hoc
 * patterns across the builder panes. */
export function PaneState({
  kind,
  title,
  hint,
  action,
}: {
  kind: PaneStateKind;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div
      data-testid="pane-state"
      data-kind={kind}
      role={ROLE[kind]}
      aria-busy={kind === 'loading' ? true : undefined}
      className={`${TONE[kind]} rounded-card flex flex-col items-center gap-2 px-6 py-10 text-center`}
    >
      <p className="text-ink text-[14px] font-medium">{title}</p>
      {/*
       * `--ink-muted` measures 4.82:1 on the sunken wash, 5.47:1 on white.
       * Task 7 darkened `--ink-subtle` to #656E77 (4.57:1 on the sunken wash),
       * so either would pass now; the hint keeps the stronger of the two.
       */}
      {hint ? <p className="text-ink-muted max-w-[42ch] text-[13px]">{hint}</p> : null}
      {action}
    </div>
  );
}
