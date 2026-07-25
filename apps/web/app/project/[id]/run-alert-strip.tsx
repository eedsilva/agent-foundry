'use client';

import React, { type ReactNode } from 'react';
import type { ResumeBlockedResponse, WorkflowRun } from '@agent-foundry/contracts';
import { cn } from '@/lib/utils';

const TONE_CLASS = {
  warn: 'text-warn',
  err: 'text-err',
  info: 'text-info',
} as const;

export function AlertStrip({
  tone,
  title,
  detail,
  actions,
}: {
  tone: keyof typeof TONE_CLASS;
  title: string;
  detail?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      role="alert"
      data-testid="run-alert"
      className={cn(
        'glass rounded-panel flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-[13px]',
        TONE_CLASS[tone],
      )}
    >
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
