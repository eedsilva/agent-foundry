import React from 'react';
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

// DESIGN.md §3.1 pairs a status colour with its own 10%-alpha wash, but every
// one of those pairs lands between 2.0:1 and 3.5:1 — `--info` on its wash
// measures 3.45:1, and axe fails the builder's preview panel on it. The label
// therefore uses `--ink` (>= 12:1 on every wash) and the tone is carried by the
// wash plus the dot, which are non-text. DESIGN.md §7 requires >= 4.5:1.
const TONE_CLASS: Record<StatusTone, string> = {
  ok: 'bg-ok/10',
  warn: 'bg-warn/10',
  err: 'bg-err/10',
  info: 'bg-info/10',
  neutral: 'bg-ink/[0.06]',
};

const DOT_CLASS: Record<StatusTone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-info',
  neutral: 'bg-ink-subtle',
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
        'text-ink inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[12px] font-semibold',
        TONE_CLASS[tone],
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          DOT_CLASS[tone],
          tone === 'info' && 'status-dot-live',
        )}
      />
      {label ?? status}
    </span>
  );
}
