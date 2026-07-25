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
       * `--ink-muted` measures 4.82:1 on the sunken wash, 5.47:1 on white.
       * Task 7 darkened `--ink-subtle` to #656E77 (4.57:1 on the sunken wash),
       * so either would pass now; the hint keeps the stronger of the two.
       */}
      {hint ? <p className="text-ink-muted max-w-[42ch] text-[13px]">{hint}</p> : null}
      {action}
    </div>
  );
}
