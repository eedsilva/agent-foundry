'use client';

import React, { type ReactNode } from 'react';
import type { ResumeBlockedResponse, WorkflowRun } from '@agent-foundry/contracts';
import { cn } from '@/lib/utils';

// The title is `--ink` (17.75:1 on the glass composite), not the tone colour:
// `--warn`/`--err`/`--info` as text on near-white glass measure 2.09/3.78/3.75:1,
// under the 4.5:1 DESIGN.md §7 requires. The tone rides on the dot, which is
// non-text.
const DOT_CLASS = {
  warn: 'bg-warn',
  err: 'bg-err',
  info: 'bg-info',
} as const;

export function AlertStrip({
  tone,
  title,
  detail,
  actions,
}: {
  tone: keyof typeof DOT_CLASS;
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role="alert"
      data-testid="run-alert"
      className="glass rounded-panel text-ink flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]"
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOT_CLASS[tone])} />
      <strong className="font-semibold">{title}</strong>
      {detail ? <span className="text-ink-muted min-w-0">{detail}</span> : null}
      {actions ? <span className="ml-auto flex gap-2">{actions}</span> : null}
    </div>
  );
}

export function ProjectProvisioningError({ error }: { error: string }) {
  return (
    <AlertStrip
      tone="err"
      title={error}
      actions={
        <a href="#project-timeline" className="text-accent hover:text-accent-strong font-medium">
          Ver detalhes na linha do tempo
        </a>
      }
    />
  );
}

export function RunAlertStrip({
  projectError,
  error,
  run,
  resumeBlocked,
  onRetry,
}: {
  projectError: string | null | undefined;
  error: string;
  run: WorkflowRun | undefined;
  resumeBlocked: ResumeBlockedResponse | null;
  onRetry: () => void;
}) {
  return (
    <>
      {projectError ? <ProjectProvisioningError error={projectError} /> : null}
      {error ? <AlertStrip tone="err" title={error} /> : null}

      {run?.status === 'paused' ? (
        <AlertStrip
          tone="warn"
          title="Execução pausada"
          detail={
            <>
              run {run.id} · ponto de retomada:{' '}
              <code className="font-mono">
                {run.pause?.resumeNodeId ?? 'próximo step pendente'}
              </code>
            </>
          }
        />
      ) : null}

      {resumeBlocked ? (
        <AlertStrip
          tone="err"
          title="Retomada bloqueada"
          detail={
            <>
              O estado mudou desde a pausa. Reexecute o projeto para usar o estado atual.
              <span className="text-ink-subtle ml-2 font-mono text-[11px]">
                {resumeBlocked.diagnostics
                  .map(
                    (item) =>
                      `${item.field}: esperado ${item.expected.slice(0, 12)}, atual ${item.actual.slice(0, 12)}`,
                  )
                  .join(' · ')}
              </span>
            </>
          }
          actions={
            <button
              type="button"
              className="border-hairline rounded-control text-ink hover:bg-accent-wash border px-3 py-1 text-[13px] font-medium"
              onClick={() => onRetry()}
            >
              Reiniciar do zero
            </button>
          }
        />
      ) : null}
    </>
  );
}
