import React from 'react';
import { cn } from '@/lib/utils';
import type { StatusTone } from './status-pill';

/**
 * Solid content card — never glass (DESIGN.md §2.3: glass is chrome).
 *
 * The tone rides on the left border, not on the value: `--ok` (2.55:1),
 * `--warn` (1.94:1), `--err` (3.53:1) and `--info` (3.91:1) as text on
 * `--surface` all fail the 4.5:1 DESIGN.md §7 requires. The value therefore
 * stays `--ink` (16.15:1) and the border — a non-text element, held to 3:1 —
 * carries the status.
 */
const TONE_BORDER: Record<StatusTone, string> = {
  ok: 'border-l-2 border-l-ok',
  warn: 'border-l-2 border-l-warn',
  err: 'border-l-2 border-l-err',
  info: 'border-l-2 border-l-info',
  neutral: '',
};

export function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
  title,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: StatusTone;
  title?: string;
}) {
  return (
    <div
      title={title}
      data-tone={tone}
      className={cn(
        'bg-surface border-hairline rounded-card shadow-card flex flex-col gap-1 border p-4',
        TONE_BORDER[tone],
      )}
    >
      <span className="text-ink-muted text-[12px] font-semibold tracking-[0.04em] uppercase">
        {label}
      </span>
      <strong className="text-ink text-[24px] leading-none font-semibold">{value}</strong>
      {hint ? <span className="text-ink-subtle text-[12px]">{hint}</span> : null}
    </div>
  );
}
