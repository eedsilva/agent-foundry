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
      {hint ? <p className="text-ink-subtle max-w-[42ch] text-[13px]">{hint}</p> : null}
      {action}
    </div>
  );
}
