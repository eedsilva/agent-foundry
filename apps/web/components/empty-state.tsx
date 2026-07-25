import React, { type ReactNode } from 'react';

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
      {/*
       * `--ink-subtle` on `--surface-sunken` is 2.63:1 — under the 4.5:1
       * DESIGN.md §7 requires (§7 names this exact pair as the tightest one).
       * `--ink-muted` measures 4.82:1 on the sunken wash, 5.47:1 on white.
       */}
      {hint ? <p className="text-ink-muted max-w-[42ch] text-[13px]">{hint}</p> : null}
      {action}
    </div>
  );
}
