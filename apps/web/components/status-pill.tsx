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
