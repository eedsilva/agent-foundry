'use client';

import React from 'react';
import type { WorkflowRun } from '@agent-foundry/contracts';
import { GlassBar } from '@/components/glass-bar';
import { StatusPill } from '@/components/status-pill';
import { BTN, BTN_ACTIVE } from '@/lib/ui';
import { cn } from '@/lib/utils';
import type { ProjectDetail } from '../../../lib/api';

const RUN_BUTTON =
  'border-hairline rounded-control text-ink hover:bg-accent-wash active:scale-[0.98] border px-3 py-1.5 text-[13px] font-medium transition-[background-color,border-color,color,transform] duration-150 ease-[var(--ease-out)]';

export function BuilderHeader({
  project,
  runStatus,
  advanced,
  onToggleAdvanced,
  onResume,
  onRetry,
}: {
  project: ProjectDetail['project'];
  runStatus: WorkflowRun['status'] | undefined;
  advanced: boolean;
  onToggleAdvanced: () => void;
  onResume: () => void;
  onRetry: () => void;
}) {
  return (
    <GlassBar
      as="header"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5"
    >
      <a
        href="/"
        className="text-ink-muted hover:text-ink shrink-0 text-[13px] transition-colors duration-150"
      >
        ← projetos
      </a>

      <div className="min-w-0">
        <h1 className="text-ink truncate text-[16px] leading-tight font-semibold tracking-[-0.01em]">
          {project.name}
        </h1>
        <p className="text-ink-muted truncate font-mono text-[11px]">
          {project.id} · nó atual: {project.currentNodeId ?? 'nenhum'}
        </p>
      </div>

      <StatusPill status={project.status} />

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <time className="text-ink-muted text-[12px]">
          Atualizado {new Date(project.updatedAt).toLocaleString('pt-BR')}
        </time>
        <button
          type="button"
          aria-pressed={advanced}
          className={cn(BTN, 'inline-flex items-center gap-1.5', advanced && BTN_ACTIVE)}
          onClick={() => onToggleAdvanced()}
        >
          {/* BTN and RUN_BUTTON (Pausar/Retomar) are near-identical strings —
              in its off state, BTN_ACTIVE alone gives no visual cue this is a
              persistent switch rather than a one-off action. The dot is the
              state-independent marker, same idiom as RuntimePill. */}
          <span
            data-testid="advanced-toggle-dot"
            aria-hidden
            className={cn('size-1.5 rounded-full', advanced ? 'bg-accent-strong' : 'bg-ink-subtle')}
          />
          Avançado
        </button>
        {/* No "Pausar" here: `run-alert-strip.tsx` renders one under the exact
            same `run.status === 'running'` condition, wired to the same
            handler, and `page.tsx` always renders that strip — so both were on
            screen at once. The strip's wins: it sits beside the progress text
            describing the run being paused, and it is reachable from the
            simple two-pane view. "Retomar"/"Tentar novamente" below stay here
            — no running strip is shown in those states. */}
        {runStatus === 'pause_requested' ? (
          <span className="text-ink-subtle font-mono text-[11px]">pausando no próximo step…</span>
        ) : null}
        {runStatus === 'paused' ? (
          <button type="button" className={RUN_BUTTON} onClick={() => onResume()}>
            Retomar
          </button>
        ) : null}
        {project.status === 'failed' ? (
          <button type="button" className={RUN_BUTTON} onClick={() => onRetry()}>
            Tentar novamente
          </button>
        ) : null}
      </div>
    </GlassBar>
  );
}
