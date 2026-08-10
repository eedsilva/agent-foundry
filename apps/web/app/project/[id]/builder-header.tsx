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
  onPause,
  onResume,
  onRetry,
}: {
  project: ProjectDetail['project'];
  runStatus: WorkflowRun['status'] | undefined;
  advanced: boolean;
  onToggleAdvanced: () => void;
  onPause: () => void;
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
          className={cn(BTN, advanced && BTN_ACTIVE)}
          onClick={() => onToggleAdvanced()}
        >
          Avançado
        </button>
        {runStatus === 'running' ? (
          <button type="button" className={RUN_BUTTON} onClick={() => onPause()}>
            Pausar
          </button>
        ) : null}
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
