import React from 'react';
import { cn } from '@/lib/utils';
import type { StatusTone } from './status-pill';

/**
 * Solid content card — never glass (DESIGN.md §2.3: glass is chrome).
 *
 * The tone rides on the left border, never on the value. Measured against
 * `--surface` #FFFFFF: `--ok` 3.01:1, `--warn` 2.16:1, `--err` 3.91:1,
 * `--info` 3.88:1 — all far below the 4.5:1 DESIGN.md §7 requires for text,
 * so the value stays `--ink` (18.35:1).
 *
 * The border is **decorative only**: `--warn` at 2.16:1 (and `--ok` at
 * 3.01:1, which only just clears) cannot be the sole carrier of meaning under
 * WCAG 1.4.11. Callers must keep the status legible in `label`/`value`; a
 * status that has to be readable on its own belongs in `StatusPill`, whose
 * wash + dot + `--ink` label is the audited pattern. Task 7 owns any change to
 * the tokens themselves.
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
      {/* `--ink-subtle` is 2.98:1 on `--surface`; `--ink-muted` is 5.47:1. */}
      {hint ? <span className="text-ink-muted text-[12px]">{hint}</span> : null}
    </div>
  );
}
